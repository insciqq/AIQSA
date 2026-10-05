import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialThreadStoreState, useThreadStore } from "@/components/app-shell/threadStore";
import { BROWSER_PUSH_SHOWN_RUNS_PATH } from "@/lib/contracts/browserPush";
import type { ThreadMessage } from "@/lib/contracts/chats";
import type { BrowserPushEnvironment } from "./browserNotificationsClient";
import { pageOnScreen, useShownRunReports } from "./useShownRunReports";

const chatId = "chat-on-screen";

function answer(id: string, status: ThreadMessage["status"], runId?: string): ThreadMessage {
  return { content: "", id, parentMessageId: null, role: "assistant", status, ...(runId ? { runId } : {}) };
}

function setMessages(messages: ThreadMessage[], chat = chatId) {
  act(() => {
    useThreadStore.getState().replaceThread(chat, { activeLeafId: null, messages, usageStats: null });
  });
}

function harness(options: Readonly<{ active?: boolean; chat?: string | null }> = {}) {
  const reported: unknown[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe(BROWSER_PUSH_SHOWN_RUNS_PATH);
    expect(init).toMatchObject({ credentials: "same-origin", keepalive: true, method: "POST" });
    reported.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  const environment = { fetch, notification: null, serviceWorker: null } as unknown as BrowserPushEnvironment;
  const screen = { on: true };
  const onScreen = () => screen.on;
  const hook = renderHook(({ chat }) => useShownRunReports({
    active: options.active ?? true, chatId: chat, environment, onScreen
  }), { initialProps: { chat: options.chat === undefined ? chatId : options.chat } });
  return { hook, reported, screen };
}

describe("shown run reports", () => {
  beforeEach(() => {
    useThreadStore.setState(initialThreadStoreState);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useThreadStore.setState(initialThreadStoreState);
  });

  it("reports once an answer this page saw streaming completes on screen, also after its id is confirmed", () => {
    const h = harness();
    setMessages([answer("assistant-optimistic", "streaming", "run-1")]);
    setMessages([answer("assistant-saved", "complete", "run-1")]);
    setMessages([answer("assistant-saved", "complete", "run-1")]);
    expect(h.reported).toEqual([{ runId: "run-1" }]);
  });

  it("matches an answer whose run id arrives only with its completion", () => {
    const h = harness();
    setMessages([answer("assistant-1", "streaming")]);
    setMessages([answer("assistant-1", "complete", "run-1")]);
    expect(h.reported).toEqual([{ runId: "run-1" }]);
  });

  it("leaves the push to answers that completed off screen, were done before, failed or were stopped", () => {
    const h = harness();
    setMessages([answer("done-before", "complete", "run-0"), answer("assistant-1", "streaming", "run-1")]);
    h.screen.on = false;
    setMessages([answer("done-before", "complete", "run-0"), answer("assistant-1", "complete", "run-1")]);
    h.screen.on = true;
    setMessages([answer("done-before", "complete", "run-0"), answer("assistant-1", "complete", "run-1"),
      answer("assistant-2", "streaming", "run-2"), answer("assistant-3", "streaming", "run-3")]);
    setMessages([answer("assistant-2", "error", "run-2"), answer("assistant-3", "cancelled", "run-3")]);
    expect(h.reported).toEqual([]);
  });

  it("reports a run whose lost connection showed a failure once it resumes and completes", () => {
    const h = harness();
    setMessages([answer("assistant-1", "streaming", "run-1")]);
    setMessages([answer("assistant-1", "error", "run-1")]);
    setMessages([answer("assistant-1", "streaming", "run-1")]);
    setMessages([answer("assistant-1", "complete", "run-1")]);
    expect(h.reported).toEqual([{ runId: "run-1" }]);
  });

  it("watches only the open chat, and nothing while push is off on this device", () => {
    const h = harness();
    setMessages([answer("elsewhere", "streaming", "run-9")], "another-chat");
    setMessages([answer("elsewhere", "complete", "run-9")], "another-chat");
    setMessages([answer("assistant-1", "streaming", "run-1")]);
    h.hook.rerender({ chat: "another-chat" });
    setMessages([answer("assistant-1", "complete", "run-1")]);
    expect(h.reported).toEqual([]);

    useThreadStore.setState(initialThreadStoreState);
    const off = harness({ active: false });
    setMessages([answer("assistant-2", "streaming", "run-2")]);
    setMessages([answer("assistant-2", "complete", "run-2")]);
    expect(off.reported).toEqual([]);
  });
});

describe("page on screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function page(visibility: DocumentVisibilityState, focused: boolean, touch: boolean) {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: touch && query === "(pointer: coarse)" }));
  }

  it("needs a visible page that is focused or on a touch-first device", () => {
    page("visible", true, false);
    expect(pageOnScreen()).toBe(true);
    page("visible", false, true);
    expect(pageOnScreen()).toBe(true);
    page("visible", false, false);
    expect(pageOnScreen()).toBe(false);
    page("hidden", true, true);
    expect(pageOnScreen()).toBe(false);
  });
});
