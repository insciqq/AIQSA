import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  jsonResponse,
  subagentChat,
  subagentFetch,
  subagentThread,
  subagentView
} from "@/tests/support/subagentViewFixtures";
import {
  invalidateChatSubagents,
  pruneSubagentChats,
  refreshChatSubagents,
  refreshSubagentSummary,
  refreshSubagentThreadView,
  resetSubagentStoreForTest,
  setOpenSubagentThread,
  stopAllSubagents,
  stopSubagent,
  subagentRowsExpanded,
  toggleSubagentRows,
  useSubagentStore
} from "./subagentStore";

beforeEach(() => resetSubagentStoreForTest());
afterEach(() => vi.unstubAllGlobals());

describe("sub-agent store", () => {
  it("keeps the chats the summary lists and drops the requested ones it leaves out", async () => {
    useSubagentStore.setState({ chats: { gone: subagentChat("gone", [subagentThread("thread-old", "done")]) } });
    const { calls, fetch } = subagentFetch([{ path: "/api/subagents", respond: () => jsonResponse({
      chats: [subagentChat("chat-a", [subagentThread("thread-alpha"), subagentThread("thread-beta", "done")])]
    }) }]);
    vi.stubGlobal("fetch", fetch);
    await refreshSubagentSummary(["chat-a", "gone"]);
    expect(calls[0]!.url.searchParams.getAll("chatId")).toEqual(["chat-a", "gone"]);
    const { chats } = useSubagentStore.getState();
    expect(Object.keys(chats)).toEqual(["chat-a"]);
    expect(chats["chat-a"]!.running).toBe(1);
  });

  it("drops a slower answer that an answer to a later request superseded", async () => {
    const slow = deferred<Response>();
    const { fetch } = subagentFetch([
      { path: "/api/subagents", respond: () => slow.promise },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [subagentThread("thread-alpha", "done")])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    const summary = refreshSubagentSummary(["chat-a"]);
    await refreshChatSubagents("chat-a");
    slow.resolve(jsonResponse({ chats: [subagentChat("chat-a", [subagentThread("thread-alpha", "running")])] }));
    await summary;
    expect(useSubagentStore.getState().chats["chat-a"]!.threads[0]!.state).toBe("done");
  });

  it("drops what a request sent before a branch switch says, and shows only the new branch's sub-agents", async () => {
    const oldBranch = deferred<Response>();
    let call = 0;
    const { fetch } = subagentFetch([{ path: "/api/chats/chat-a/subagents", respond: () => {
      call += 1;
      return call === 1 ? oldBranch.promise : jsonResponse(subagentChat("chat-a", [subagentThread("thread-new-branch")]));
    } }]);
    vi.stubGlobal("fetch", fetch);
    const before = refreshChatSubagents("chat-a");
    await invalidateChatSubagents("chat-a");
    oldBranch.resolve(jsonResponse(subagentChat("chat-a", [subagentThread("thread-old-branch")])));
    await before;
    expect(useSubagentStore.getState().chats["chat-a"]!.threads.map((thread) => thread.name)).toEqual(["new-branch"]);
  });

  it("keeps the last rows and marks the chat when a refresh fails, and forgets a chat the route no longer shows", async () => {
    useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-alpha")]) } });
    vi.stubGlobal("fetch", subagentFetch([{ path: "/api/chats/chat-a/subagents", respond: () => jsonResponse({ error: "boom" }, 500) }]).fetch);
    await refreshChatSubagents("chat-a");
    expect(useSubagentStore.getState().chats["chat-a"]).toBeDefined();
    expect(useSubagentStore.getState().chatErrors["chat-a"]).toBe(true);
    // A malformed answer is a failure too, never guessed state.
    vi.stubGlobal("fetch", subagentFetch([{ path: "/api/chats/chat-a/subagents", respond: () => jsonResponse({ chatId: "chat-a" }) }]).fetch);
    await refreshChatSubagents("chat-a");
    expect(useSubagentStore.getState().chats["chat-a"]).toBeDefined();
    // The chat was deleted (or is not the caller's): the one not-found answer.
    vi.stubGlobal("fetch", subagentFetch([]).fetch);
    await refreshChatSubagents("chat-a");
    expect(useSubagentStore.getState().chats["chat-a"]).toBeUndefined();
    expect(useSubagentStore.getState().chatErrors["chat-a"]).toBeUndefined();
  });

  it("drops a thread view that answers after the user moved to another thread", async () => {
    const first = deferred<Response>();
    const { fetch } = subagentFetch([
      { path: "/api/chats/chat-a/subagents/thread-alpha", respond: () => first.promise },
      { path: "/api/chats/chat-a/subagents/thread-beta", respond: () => jsonResponse(subagentView("chat-a", subagentThread("thread-beta", "done"))) }
    ]);
    vi.stubGlobal("fetch", fetch);
    setOpenSubagentThread({ chatId: "chat-a", threadId: "thread-alpha" });
    const alpha = refreshSubagentThreadView({ chatId: "chat-a", threadId: "thread-alpha" });
    setOpenSubagentThread({ chatId: "chat-a", threadId: "thread-beta" });
    await refreshSubagentThreadView({ chatId: "chat-a", threadId: "thread-beta" });
    first.resolve(jsonResponse(subagentView("chat-a", subagentThread("thread-alpha"))));
    await alpha;
    expect(useSubagentStore.getState().view?.view?.thread.id).toBe("thread-beta");
  });

  it("never shows a thread view sent before a branch switch on the new branch", async () => {
    const oldBranch = deferred<Response>();
    let call = 0;
    const target = { chatId: "chat-a", threadId: "thread-alpha" };
    const { fetch } = subagentFetch([
      { path: "/api/chats/chat-a/subagents/thread-alpha", respond: () => {
        call += 1;
        return call === 1 ? oldBranch.promise
          : jsonResponse(subagentView("chat-a", subagentThread("thread-alpha", "running", { name: "new-branch" })));
      } },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [subagentThread("thread-alpha")])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    setOpenSubagentThread(target);
    useSubagentStore.setState({ view: { key: "chat-a\0thread-alpha", status: "ready",
      view: subagentView("chat-a", subagentThread("thread-alpha", "done", { name: "shown" })) } });
    const before = refreshSubagentThreadView(target);
    const switched = invalidateChatSubagents("chat-a");
    // The old branch's view clears at once.
    expect(useSubagentStore.getState().view).toMatchObject({ status: "loading", view: null });
    oldBranch.resolve(jsonResponse(subagentView("chat-a", subagentThread("thread-alpha", "done", { name: "old-branch" }))));
    await before;
    expect(useSubagentStore.getState().view?.view?.thread.name).not.toBe("old-branch");
    await switched;
    expect(useSubagentStore.getState().view?.view?.thread.name).toBe("new-branch");
  });

  it("forgets chats that left the list, with what was in flight for them", async () => {
    const slow = deferred<Response>();
    vi.stubGlobal("fetch", subagentFetch([{ path: "/api/subagents", respond: () => slow.promise }]).fetch);
    useSubagentStore.setState({
      chats: { gone: subagentChat("gone", [subagentThread("thread-alpha")]), kept: subagentChat("kept", [subagentThread("thread-beta")]) },
      disclosure: { gone: { expanded: true, whileRunning: true } }
    });
    const pending = refreshSubagentSummary(["gone", "kept"]);
    pruneSubagentChats(new Set(["kept"]));
    expect(Object.keys(useSubagentStore.getState().chats)).toEqual(["kept"]);
    expect(useSubagentStore.getState().disclosure).toEqual({});
    slow.resolve(jsonResponse({ chats: [subagentChat("gone", [subagentThread("thread-alpha")])] }));
    await pending;
    expect(useSubagentStore.getState().chats.gone).toBeUndefined();
  });

  it("shows the routes' one not-found answer as unavailable", async () => {
    vi.stubGlobal("fetch", subagentFetch([]).fetch);
    setOpenSubagentThread({ chatId: "chat-a", threadId: "thread-alpha" });
    await refreshSubagentThreadView({ chatId: "chat-a", threadId: "thread-alpha" });
    expect(useSubagentStore.getState().view).toMatchObject({ status: "unavailable", view: null });
  });

  it("stops one sub-agent and takes the server's answer into its chat's rows", async () => {
    useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-alpha")]) } });
    const stopped = subagentThread("thread-alpha", "stopped", { updatedAt: "2026-10-30T09:06:00.000Z" });
    const { calls, fetch } = subagentFetch([
      { method: "POST", path: "/api/chats/chat-a/subagents/thread-alpha/stop", respond: () => jsonResponse({ thread: stopped }) },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [stopped])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    await expect(stopSubagent({ chatId: "chat-a", threadId: "thread-alpha" })).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(useSubagentStore.getState().chats["chat-a"]).toMatchObject({ running: 0 });
    expect(useSubagentStore.getState().stopping).toEqual({});
  });

  it("keeps a failed Stop all visible and lets it run again", async () => {
    vi.stubGlobal("fetch", subagentFetch([{ method: "POST", path: "/api/chats/chat-a/subagents/stop-all",
      respond: () => jsonResponse({ error: "unavailable" }, 503) }]).fetch);
    await expect(stopAllSubagents("chat-a")).resolves.toBe(false);
    expect(useSubagentStore.getState().stopErrors["chat-a\0*"]).toBe(true);
    const { calls, fetch } = subagentFetch([
      { method: "POST", path: "/api/chats/chat-a/subagents/stop-all", respond: () => jsonResponse({ stopped: 2 }) },
      { path: "/api/chats/chat-a/subagents", respond: () => jsonResponse(subagentChat("chat-a", [subagentThread("thread-alpha", "stopped")])) }
    ]);
    vi.stubGlobal("fetch", fetch);
    await expect(stopAllSubagents("chat-a")).resolves.toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /api/chats/chat-a/subagents/stop-all", "GET /api/chats/chat-a/subagents"
    ]);
    expect(useSubagentStore.getState().stopErrors).toEqual({});
  });

  it("opens a chat's rows while a sub-agent runs and closes them after, unless the user chose otherwise then", () => {
    useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-alpha")]) } });
    expect(subagentRowsExpanded(useSubagentStore.getState(), "chat-a")).toBe(true);
    toggleSubagentRows("chat-a");
    expect(subagentRowsExpanded(useSubagentStore.getState(), "chat-a")).toBe(false);
    // Everything ended: the rows close by themselves; the user's choice was about the running chat.
    useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-alpha", "done")]) } });
    expect(subagentRowsExpanded(useSubagentStore.getState(), "chat-a")).toBe(false);
    toggleSubagentRows("chat-a");
    expect(subagentRowsExpanded(useSubagentStore.getState(), "chat-a")).toBe(true);
    // A new sub-agent starts: open again.
    useSubagentStore.setState({ chats: { "chat-a": subagentChat("chat-a", [subagentThread("thread-alpha", "done"), subagentThread("thread-beta")]) } });
    expect(subagentRowsExpanded(useSubagentStore.getState(), "chat-a")).toBe(true);
  });
});
