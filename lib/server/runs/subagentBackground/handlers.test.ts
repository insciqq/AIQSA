import { describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_API_PATHS,
  decodeSubagentChatThreads,
  decodeSubagentStopAllResponse,
  decodeSubagentStopResponse,
  type SubagentThreadSummary
} from "@/lib/contracts/subagentViews";
import type { AuthConfig } from "@/lib/server/auth/config";
import {
  createSubagentChatThreadsHandler,
  createSubagentStopAllHandler,
  createSubagentStopHandler,
  createSubagentSummaryHandler,
  createSubagentThreadViewHandler,
  type SubagentRouteDeps
} from "./handlers";
import type { SubagentViews } from "./views";

const thread: SubagentThreadSummary = { createdAt: "2026-10-30T10:00:00.000Z", currentStep: null, endedAt: null, id: "thread-1", latestAnswerMessageId: null, mode: "background",
  model: null, name: "researcher", outcome: null, reason: null, state: "running", turnCount: 1, type: null, updatedAt: "2026-10-30T10:01:00.000Z" };

function setup(owner = "owner") {
  // Every view reads only the owner's own chat: another user's reads as missing.
  const views: SubagentViews = {
    chatThreads: vi.fn(async ({ userId }) => userId === owner ? { chatId: "chat-1", running: 1, threads: [thread], truncated: false } : null),
    ownsChat: vi.fn(async ({ userId }) => userId === owner),
    summary: vi.fn(async ({ userId }) => ({ chats: userId === owner ? [{ chatId: "chat-1", running: 1, threads: [thread], truncated: false }] : [] })),
    thread: vi.fn(async ({ userId }) => userId === owner ? thread : null),
    threadView: vi.fn(async () => null)
  };
  const control = { stopAll: vi.fn(async () => 25), stopThread: vi.fn(async () => 1) };
  const deps = (userId: string | null): SubagentRouteDeps => ({ control, getConfig: () => ({ configured: true }) as AuthConfig,
    resolveAuth: async () => userId ? { expiresAt: new Date(), id: "session", user: { displayName: "U", email: null, id: userId,
      role: "admin", status: "active" }, userId } : null, views });
  return { control, deps, views };
}

const url = (path: string) => `http://localhost${path}`;

describe("sub-agent routes", () => {
  it("lists the owner's threads and refuses everyone else with the same not-found", async () => {
    const { deps } = setup();
    const ok = await createSubagentChatThreadsHandler(deps("owner"))(new Request(url(SUBAGENT_API_PATHS.chatThreads("chat-1"))),
      { params: { chatId: "chat-1" } });
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(decodeSubagentChatThreads(await ok.json())).toMatchObject({ running: 1, threads: [{ name: "researcher" }] });
    // An administrator who does not own the chat, a malformed id and a missing chat read alike.
    for (const [user, chatId] of [["admin", "chat-1"], ["owner", "../x"]] as const) {
      const refused = await createSubagentChatThreadsHandler(deps(user))(new Request(url("/x")), { params: { chatId } });
      expect([refused.status, await refused.json()]).toEqual([404, { error: "subagent_not_found" }]);
    }
    const anonymous = await createSubagentChatThreadsHandler(deps(null))(new Request(url("/x")), { params: { chatId: "chat-1" } });
    expect(anonymous.status).toBe(401);
  });

  it("validates the summary query and leaves out chats the caller does not own", async () => {
    const { deps } = setup();
    const ok = await createSubagentSummaryHandler(deps("admin"))(new Request(url(SUBAGENT_API_PATHS.summary(["chat-1"]))), { params: {} });
    expect(await ok.json()).toEqual({ chats: [] });
    const bad = await createSubagentSummaryHandler(deps("owner"))(new Request(url("/api/subagents?other=1")), { params: {} });
    expect(bad.status).toBe(400);
  });

  it("says when nothing could be stopped while a sub-agent still runs, and answers an ended one as stopped already", async () => {
    const { control, deps, views } = setup();
    control.stopThread.mockResolvedValue(0);
    control.stopAll.mockResolvedValue(0);
    const stop = await createSubagentStopHandler(deps("owner"))(new Request(url("/x"), { method: "POST" }),
      { params: { chatId: "chat-1", threadId: "thread-1" } });
    expect([stop.status, await stop.json()]).toEqual([409, { error: "subagent_stop_unavailable" }]);
    const all = await createSubagentStopAllHandler(deps("owner"))(new Request(url("/x"), { method: "POST" }), { params: { chatId: "chat-1" } });
    expect([all.status, await all.json()]).toEqual([409, { error: "subagent_stop_unavailable" }]);
    // Nothing runs any more: a repeated Stop is idempotent.
    const ended = { ...thread, endedAt: "2026-10-30T10:02:00.000Z", outcome: null, reason: "user_stop", state: "stopped" as const };
    vi.mocked(views.thread).mockResolvedValue(ended);
    vi.mocked(views.chatThreads).mockResolvedValue({ chatId: "chat-1", running: 0, threads: [ended], truncated: false });
    const again = await createSubagentStopHandler(deps("owner"))(new Request(url("/x"), { method: "POST" }),
      { params: { chatId: "chat-1", threadId: "thread-1" } });
    expect(decodeSubagentStopResponse(await again.json())).toMatchObject({ thread: { state: "stopped" } });
    const none = await createSubagentStopAllHandler(deps("owner"))(new Request(url("/x"), { method: "POST" }), { params: { chatId: "chat-1" } });
    expect(decodeSubagentStopAllResponse(await none.json())).toEqual({ stopped: 0 });
  });

  it("stops one thread and all of a chat's sub-agents, idempotently, for the owner only", async () => {
    const { control, deps } = setup();
    const stop = await createSubagentStopHandler(deps("owner"))(new Request(url("/x"), { method: "POST" }),
      { params: { chatId: "chat-1", threadId: "thread-1" } });
    expect(decodeSubagentStopResponse(await stop.json())).toMatchObject({ thread: { id: "thread-1" } });
    expect(control.stopThread).toHaveBeenCalledWith({ chatId: "chat-1", threadId: "thread-1", userId: "owner" });
    const all = await createSubagentStopAllHandler(deps("owner"))(new Request(url("/x"), { method: "POST" }), { params: { chatId: "chat-1" } });
    expect(decodeSubagentStopAllResponse(await all.json())).toEqual({ stopped: 20 });
    const refused = await createSubagentStopAllHandler(deps("admin"))(new Request(url("/x"), { method: "POST" }), { params: { chatId: "chat-1" } });
    expect(refused.status).toBe(404);
    expect(control.stopAll).toHaveBeenCalledTimes(1);
    const view = await createSubagentThreadViewHandler(deps("owner"))(new Request(url("/x")), { params: { chatId: "chat-1", threadId: "t" } });
    expect(view.status).toBe(404);
  });
});
