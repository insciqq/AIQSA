import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetComposerSessionStoreForTest,
  resetRunLifecycleStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import {
  beginChatRouteResolution,
  cancelChatRouteResolution,
  chatRouteForChat,
  chatRouteForState,
  chatSendUnderWay,
  isCurrentChatRouteResolution,
  navigateChatRoute,
  resolveChatRoute,
  settleChatRouteResolution,
  useChatRouteHistory,
  useChatRoutePath,
  useControlCenterHref,
  useShownChatRoute,
  writeChatRoute,
  type ChatRoute,
  type ChatRouteTargets
} from "./chatRoute";
import {
  composerSessionKey,
  projectComposerSessionKey,
  useComposerSessionStore
} from "./composerSessionStore";
import { useRunLifecycleStore } from "./runLifecycleStore";
import type { WorkspaceChatSummary } from "./types";
import { useWorkspaceStore } from "./workspaceStore";

const BLANK: ChatRoute = { chatId: null, projectId: null };
const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

function summary(input: Partial<WorkspaceChatSummary> & { id: string }): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-09-26T00:00:00.000Z",
    defaultModelId: "model",
    defaultProvider: "provider",
    folderId: null,
    messageCount: 0,
    pinned: false,
    projectId: null,
    title: "Chat",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...input
  };
}

function targets(overrides: Partial<ChatRouteTargets> = {}) {
  let state: ChatRoute = BLANK;
  const fake = {
    openAssistant: vi.fn(async (_assistantId: string | null) => "opened" as const),
    openBlank: vi.fn(() => { state = BLANK; }),
    openChat: vi.fn(async (chatId: string) => {
      state = { chatId, projectId: null };
      return "opened" as const;
    }),
    openProject: vi.fn(async (projectId: string, chatId: string | null) => {
      state = { chatId, projectId };
      return "opened" as const;
    }),
    showUnavailable: vi.fn(),
    stateRoute: vi.fn(() => state),
    ...overrides
  } satisfies ChatRouteTargets;
  return fake;
}

afterEach(() => {
  cleanup();
  cancelChatRouteResolution(beginChatRouteResolution());
  resetComposerSessionStoreForTest();
  resetRunLifecycleStoreForTest();
  resetWorkspaceStoreForTest();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("chat route writer", () => {
  it("replaces the address for state-owner writes and keeps history length", () => {
    const length = window.history.length;
    writeChatRoute({ chatId: "chat-1", projectId: null });
    expect(address()).toBe("/c/chat-1");
    writeChatRoute({ chatId: "chat-2", projectId: "project-1" });
    expect(address()).toBe("/p/project-1/c/chat-2");
    writeChatRoute(BLANK);
    expect(address()).toBe("/");
    expect(window.history.length).toBe(length);
  });

  it("pushes one entry for an explicit navigation, whatever it writes on the way", () => {
    window.history.replaceState(null, "", "/p/project-1/c/chat-1");
    const push = vi.spyOn(window.history, "pushState");
    const result = navigateChatRoute(() => {
      writeChatRoute(BLANK);
      navigateChatRoute(() => writeChatRoute({ chatId: "chat-2", projectId: null }));
      return "done";
    });
    expect(result).toBe("done");
    expect(push).toHaveBeenCalledExactlyOnceWith(null, "", "/c/chat-2");
    expect(address()).toBe("/c/chat-2");

    push.mockClear();
    navigateChatRoute(() => writeChatRoute({ chatId: "chat-2", projectId: null }));
    navigateChatRoute(() => undefined);
    expect(push).not.toHaveBeenCalled();
  });

  it("carries unconsumed parameters for the same chat and drops chat-scoped ones for another", () => {
    window.history.replaceState(null, "", "/c/chat-1?message=m1&library=mcp&chat=legacy#answer");
    writeChatRoute({ chatId: "chat-1", projectId: "project-1" });
    expect(address()).toBe("/p/project-1/c/chat-1?message=m1&library=mcp");
    window.history.replaceState(null, "", "/c/chat-1?message=m1&artifactEdit=edit&artifactId=a&versionId=v&oauth=connected#answer");
    writeChatRoute({ chatId: "chat-2", projectId: null });
    expect(address()).toBe("/c/chat-2?oauth=connected");
  });

  it("never rewrites a page outside the chat routes", () => {
    window.history.replaceState(null, "", "/artifacts/artifact/versions/version");
    writeChatRoute({ chatId: "chat-1", projectId: null });
    navigateChatRoute(() => writeChatRoute(BLANK));
    expect(address()).toBe("/artifacts/artifact/versions/version");
  });

  it("holds the address while it is resolved and settles once on the resulting route", () => {
    window.history.replaceState(null, "", "/p/project-1/c/chat-1?message=m1");
    const resolution = beginChatRouteResolution();
    writeChatRoute(BLANK);
    writeChatRoute({ chatId: null, projectId: "project-1" });
    expect(address()).toBe("/p/project-1/c/chat-1?message=m1");
    expect(settleChatRouteResolution(resolution, { chatId: "chat-1", projectId: "project-1" })).toBe(true);
    expect(address()).toBe("/p/project-1/c/chat-1?message=m1");
    expect(settleChatRouteResolution(resolution, BLANK)).toBe(false);
    expect(address()).toBe("/p/project-1/c/chat-1?message=m1");
  });

  it("lets explicit navigation supersede a pending resolution", () => {
    window.history.replaceState(null, "", "/c/chat-1");
    const resolution = beginChatRouteResolution();
    navigateChatRoute(() => writeChatRoute({ chatId: "chat-2", projectId: null }));
    expect(isCurrentChatRouteResolution(resolution)).toBe(false);
    expect(address()).toBe("/c/chat-2");
    expect(settleChatRouteResolution(resolution, BLANK)).toBe(false);
    expect(address()).toBe("/c/chat-2");
  });
});

describe("chat routes of state", () => {
  it("keeps an unsent draft on its blank route until its first send is under way", () => {
    const draft = summary({ id: "draft-1", pendingPersonalDraft: { folderId: "folder-1", memoryMode: "NORMAL" } });
    expect(chatRouteForChat(draft, false)).toEqual(BLANK);
    expect(chatRouteForChat(draft, true)).toEqual({ chatId: "draft-1", projectId: null });
    const projectDraft = summary({ id: "draft-2", pendingProjectDraft: { folderId: null, projectId: "project-1" }, projectId: "project-1" });
    expect(chatRouteForChat(projectDraft, false)).toEqual({ chatId: null, projectId: "project-1" });
    expect(chatRouteForChat(projectDraft, true)).toEqual({ chatId: "draft-2", projectId: "project-1" });
    expect(chatRouteForChat(summary({ id: "chat-1", projectId: "project-1" }), false))
      .toEqual({ chatId: "chat-1", projectId: "project-1" });
  });

  it("derives the shown route from the workspace and composer owners", () => {
    expect(chatRouteForState()).toEqual(BLANK);
    useComposerSessionStore.getState().activateSession(projectComposerSessionKey("project-1"));
    expect(chatRouteForState()).toEqual({ chatId: null, projectId: "project-1" });
    useWorkspaceStore.setState({ activeChatId: "chat-1", chats: [summary({ id: "chat-1", projectId: "project-1" })] });
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-1"));
    expect(chatRouteForState()).toEqual({ chatId: "chat-1", projectId: "project-1" });
  });

  it("counts an answer stream without a composer send, such as an Assistant starter prompt", () => {
    expect(chatSendUnderWay("draft-1")).toBe(false);
    useRunLifecycleStore.getState().streamStarted({ assistantMessageId: "assistant-1", chatId: "draft-1" });
    expect(chatSendUnderWay("draft-1")).toBe(true);
    useRunLifecycleStore.getState().streamFinished({ chatId: "draft-1" });
    expect(chatSendUnderWay("draft-1")).toBe(false);
  });
});

describe("the shown chat's own route", () => {
  function showDraft(draft: WorkspaceChatSummary) {
    useWorkspaceStore.setState({ activeChatId: draft.id, chats: [draft] });
    useComposerSessionStore.getState().activateSession(composerSessionKey(draft.id));
  }

  it("addresses a starter-prompt first send while it streams and keeps the address after admission", () => {
    const draft = summary({ id: "draft-1", pendingPersonalDraft: { folderId: null, memoryMode: "NORMAL" } });
    showDraft(draft);
    const length = window.history.length;
    renderHook(() => useShownChatRoute(), { wrapper: StrictMode });
    expect(address()).toBe("/");

    act(() => useRunLifecycleStore.getState().streamStarted({ assistantMessageId: "assistant-1", chatId: "draft-1" }));
    expect(address()).toBe("/c/draft-1");
    act(() => useWorkspaceStore.setState({ chats: [{ ...draft, pendingPersonalDraft: undefined }] }));
    act(() => useRunLifecycleStore.getState().streamFinished({ chatId: "draft-1" }));
    expect(address()).toBe("/c/draft-1");
    expect(window.history.length).toBe(length);
  });

  it("returns a failed first send to the blank route it came from", () => {
    const draft = summary({
      id: "draft-2",
      pendingProjectDraft: { folderId: null, projectId: "project-1" },
      projectId: "project-1"
    });
    showDraft(draft);
    window.history.replaceState(null, "", "/p/project-1");
    renderHook(() => useShownChatRoute());
    act(() => useRunLifecycleStore.getState().streamStarted({ assistantMessageId: "assistant-2", chatId: "draft-2" }));
    expect(address()).toBe("/p/project-1/c/draft-2");
    act(() => useRunLifecycleStore.getState().streamFinished({ chatId: "draft-2" }));
    expect(address()).toBe("/p/project-1");
  });

  it("leaves the address alone while it is being resolved", () => {
    window.history.replaceState(null, "", "/c/chat-9");
    const resolution = beginChatRouteResolution();
    useWorkspaceStore.setState({ activeChatId: "chat-1", chats: [summary({ id: "chat-1" })] });
    renderHook(() => useShownChatRoute());
    expect(address()).toBe("/c/chat-9");
    cancelChatRouteResolution(resolution);
  });
});

describe("resolving an address", () => {
  it("opens a personal chat and settles on it", async () => {
    window.history.replaceState(null, "", "/c/chat-1");
    const fake = targets();
    const resolution = beginChatRouteResolution();
    await expect(resolveChatRoute({ chatId: "chat-1", projectId: null }, resolution, fake))
      .resolves.toEqual({ chatId: "chat-1", projectId: null });
    expect(fake.showUnavailable).not.toHaveBeenCalled();
    expect(isCurrentChatRouteResolution(resolution)).toBe(false);
    expect(address()).toBe("/c/chat-1");
  });

  it("shows one privacy-neutral notice for missing, foreign and malformed chats and lands on the new chat", async () => {
    for (const [route, pathname] of [[{ chatId: "gone", projectId: null }, "/c/gone?message=m"], [null, "/c/%00"]] as const) {
      window.history.replaceState(null, "", pathname);
      const fake = targets({ openChat: vi.fn(async () => "missing" as const) });
      await resolveChatRoute(route, beginChatRouteResolution(), fake);
      expect(fake.openBlank).toHaveBeenCalledOnce();
      expect(fake.showUnavailable).toHaveBeenCalledExactlyOnceWith("chat");
      expect(address()).toBe("/");
    }
  });

  it("lands an unavailable address on the new chat in place, without a document navigation or history entry", async () => {
    window.history.replaceState(null, "", "/c/gone");
    const length = window.history.length;
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const fake = targets({ openChat: vi.fn(async () => "missing" as const) });
    await resolveChatRoute({ chatId: "gone", projectId: null }, beginChatRouteResolution(), fake);
    expect(replace).toHaveBeenCalledExactlyOnceWith(null, "", "/");
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
    expect(address()).toBe("/");
  });

  it("keeps the address when loading failed so a retry can resolve it", async () => {
    window.history.replaceState(null, "", "/c/chat-1");
    const fake = targets({ openChat: vi.fn(async () => "failed" as const) });
    const resolution = beginChatRouteResolution();
    await expect(resolveChatRoute({ chatId: "chat-1", projectId: null }, resolution, fake)).resolves.toBeNull();
    expect(fake.showUnavailable).not.toHaveBeenCalled();
    expect(isCurrentChatRouteResolution(resolution)).toBe(false);
    expect(address()).toBe("/c/chat-1");
  });

  it("moves a readable Project chat to its Project address", async () => {
    window.history.replaceState(null, "", "/c/chat-1?message=m1");
    const fake = targets({ openChat: vi.fn(async () => ({ projectId: "project-1" })) });
    await resolveChatRoute({ chatId: "chat-1", projectId: null }, beginChatRouteResolution(), fake);
    expect(fake.openProject).toHaveBeenCalledExactlyOnceWith("project-1", "chat-1");
    expect(fake.showUnavailable).not.toHaveBeenCalled();
    expect(address()).toBe("/p/project-1/c/chat-1?message=m1");
  });

  it("keeps an accessible Project open when its chat is unavailable", async () => {
    window.history.replaceState(null, "", "/p/project-1/c/other");
    let shown: ChatRoute = BLANK;
    const fake = targets({
      openProject: vi.fn(async (projectId: string) => {
        shown = { chatId: null, projectId };
        return "project" as const;
      }),
      stateRoute: () => shown
    });
    await resolveChatRoute({ chatId: "other", projectId: "project-1" }, beginChatRouteResolution(), fake);
    expect(fake.showUnavailable).toHaveBeenCalledExactlyOnceWith("projectChat");
    expect(fake.openBlank).not.toHaveBeenCalled();
    expect(address()).toBe("/p/project-1");
  });

  it.each([
    [{ chatId: "chat-1", projectId: "project-1" }, "projectChat"],
    [{ chatId: null, projectId: "project-1" }, "project"]
  ] as const)("falls back to the new chat when the Project is unavailable", async (route, notice) => {
    window.history.replaceState(null, "", route.chatId ? "/p/project-1/c/chat-1" : "/p/project-1");
    const fake = targets({ openProject: vi.fn(async () => "unavailable" as const) });
    await resolveChatRoute(route, beginChatRouteResolution(), fake);
    expect(fake.openBlank).toHaveBeenCalledOnce();
    expect(fake.showUnavailable).toHaveBeenCalledExactlyOnceWith(notice);
    expect(address()).toBe("/");
  });

  it("opens an Assistant entry on the new chat and replaces the entry address with it", async () => {
    window.history.replaceState(null, "", "/assistant/assistant-1?message=m&library=assistants");
    const length = window.history.length;
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const fake = targets();
    const resolution = beginChatRouteResolution();
    await expect(resolveChatRoute({ assistantId: "assistant-1" }, resolution, fake)).resolves.toEqual(BLANK);
    expect(fake.openBlank).toHaveBeenCalledOnce();
    expect(fake.openAssistant).toHaveBeenCalledExactlyOnceWith("assistant-1");
    expect(vi.mocked(fake.openBlank).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fake.openAssistant).mock.invocationCallOrder[0]!);
    expect(fake.showUnavailable).not.toHaveBeenCalled();
    expect(isCurrentChatRouteResolution(resolution)).toBe(false);
    expect(replace).toHaveBeenCalledExactlyOnceWith(null, "", "/?library=assistants");
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
  });

  it("shows one neutral notice on the new chat for every Assistant entry it can't open", async () => {
    for (const assistantId of ["missing-or-foreign", null]) {
      window.history.replaceState(null, "", "/assistant/x");
      const fake = targets({ openAssistant: vi.fn(async () => "unavailable" as const) });
      await resolveChatRoute({ assistantId }, beginChatRouteResolution(), fake);
      expect(fake.openAssistant).toHaveBeenCalledExactlyOnceWith(assistantId);
      expect(fake.showUnavailable).toHaveBeenCalledExactlyOnceWith("assistant");
      expect(address()).toBe("/");
    }
  });

  it("drops an Assistant entry that resolves after another navigation", async () => {
    window.history.replaceState(null, "", "/assistant/assistant-1");
    let finish!: (outcome: "unavailable") => void;
    const fake = targets({ openAssistant: vi.fn(() => new Promise<"unavailable">((resolve) => { finish = resolve; })) });
    const pending = resolveChatRoute({ assistantId: "assistant-1" }, beginChatRouteResolution(), fake);
    navigateChatRoute(() => writeChatRoute({ chatId: "chat-2", projectId: null }));
    finish("unavailable");
    await expect(pending).resolves.toBeNull();
    expect(fake.showUnavailable).not.toHaveBeenCalled();
    expect(address()).toBe("/c/chat-2");
  });

  it("ignores a result that arrives after another navigation", async () => {
    window.history.replaceState(null, "", "/c/chat-1");
    let finish!: (outcome: "missing") => void;
    const fake = targets({ openChat: vi.fn(() => new Promise<"missing">((resolve) => { finish = resolve; })) });
    const pending = resolveChatRoute({ chatId: "chat-1", projectId: null }, beginChatRouteResolution(), fake);
    navigateChatRoute(() => writeChatRoute({ chatId: "chat-2", projectId: null }));
    finish("missing");
    await expect(pending).resolves.toBeNull();
    expect(fake.openBlank).not.toHaveBeenCalled();
    expect(fake.showUnavailable).not.toHaveBeenCalled();
    expect(address()).toBe("/c/chat-2");
  });
});

describe("browser history", () => {
  function renderHistory(input: {
    currentRoute(): ChatRoute;
    requestNavigation(proceed: () => void): void;
  }) {
    const resolve = vi.fn();
    const hook = renderHook(() => useChatRouteHistory({ ...input, resolve }), { wrapper: StrictMode });
    return { ...hook, resolve };
  }

  function traverse(to: string) {
    window.history.replaceState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  it("resolves a traversed chat route once, even under Strict Mode", () => {
    const { resolve } = renderHistory({ currentRoute: () => ({ chatId: "chat-2", projectId: null }), requestNavigation: (proceed) => proceed() });
    traverse("/c/chat-1");
    expect(resolve).toHaveBeenCalledOnce();
    const [route, resolution] = resolve.mock.calls[0]!;
    expect(route).toEqual({ chatId: "chat-1", projectId: null });
    expect(isCurrentChatRouteResolution(resolution)).toBe(true);
    traverse("/p/project-1");
    expect(resolve.mock.calls[1]![0]).toEqual({ chatId: null, projectId: "project-1" });
    expect(isCurrentChatRouteResolution(resolution)).toBe(false);
    traverse("/c/%00");
    expect(resolve.mock.calls[2]![0]).toBeNull();
  });

  it("resolves a traversed Assistant entry, even from the new chat it settles on", () => {
    const { resolve } = renderHistory({ currentRoute: () => BLANK, requestNavigation: (proceed) => proceed() });
    traverse("/assistant/assistant-1");
    traverse("/assistant/%00");
    expect(resolve.mock.calls.map(([route]) => route)).toEqual([{ assistantId: "assistant-1" }, { assistantId: null }]);
  });

  it("adds the new chat, not the entry address, when a confirmation releases a traversed entry", () => {
    let release!: () => void;
    const { resolve } = renderHistory({
      currentRoute: () => ({ chatId: "chat-2", projectId: null }),
      requestNavigation: (proceed) => { release = proceed; }
    });
    traverse("/assistant/assistant-1");
    const push = vi.spyOn(window.history, "pushState");
    release();
    expect(push).toHaveBeenCalledExactlyOnceWith(null, "", "/");
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ assistantId: "assistant-1" }, expect.anything());
  });

  it("ignores traversals that keep the shown route or leave the chat pages", () => {
    const { resolve } = renderHistory({ currentRoute: () => ({ chatId: "chat-1", projectId: null }), requestNavigation: (proceed) => proceed() });
    traverse("/c/chat-1?message=m1");
    traverse("/artifacts/artifact/versions/version");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("puts the shown route back when a guard blocks the traversal", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { resolve } = renderHistory({ currentRoute: () => ({ chatId: "chat-2", projectId: null }), requestNavigation: () => undefined });
    traverse("/c/chat-1");
    expect(resolve).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledExactlyOnceWith(null, "", "/c/chat-2");
    expect(address()).toBe("/c/chat-2");
  });

  it("adds the traversed route as a new entry when a confirmation releases it later", () => {
    let release!: () => void;
    const { resolve } = renderHistory({
      currentRoute: () => ({ chatId: "chat-2", projectId: null }),
      requestNavigation: (proceed) => { release = proceed; }
    });
    traverse("/c/chat-1");
    expect(address()).toBe("/c/chat-2");
    const push = vi.spyOn(window.history, "pushState");
    release();
    release();
    expect(push).toHaveBeenCalledExactlyOnceWith(null, "", "/c/chat-1");
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ chatId: "chat-1", projectId: null }, expect.anything());
  });

  it("stops following history after unmount", () => {
    const { resolve, unmount } = renderHistory({ currentRoute: () => BLANK, requestNavigation: (proceed) => proceed() });
    unmount();
    traverse("/c/chat-1");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("links that return to the shown chat", () => {
  it("renders the new chat's link on the server so hydration stays stable", () => {
    window.history.replaceState(null, "", "/c/chat-1");
    function Probe() {
      return createElement("a", { href: useControlCenterHref() }, useChatRoutePath());
    }
    expect(renderToString(createElement(Probe))).toBe('<a href="/admin">/</a>');
  });

  it("follows route writes and history", () => {
    window.history.replaceState(null, "", "/c/chat-1");
    const { result } = renderHook(() => ({ href: useControlCenterHref(), path: useChatRoutePath() }));
    expect(result.current).toEqual({ href: "/admin?return=%2Fc%2Fchat-1", path: "/c/chat-1" });
    act(() => writeChatRoute({ chatId: "chat-2", projectId: "project-1" }));
    expect(result.current.path).toBe("/p/project-1/c/chat-2");
    act(() => {
      window.history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toEqual({ href: "/admin", path: "/" });
  });
});
