import { describe, expect, it } from "vitest";
import { decodeThreadToolActivity } from "./chats";
import {
  SUBAGENT_API_PATHS,
  SUBAGENT_NOT_FOUND,
  SUBAGENT_VIEW_LIMITS,
  decodeSubagentChatThreads,
  decodeSubagentStopAllResponse,
  decodeSubagentStopResponse,
  decodeSubagentSummaryQuery,
  decodeSubagentSummaryResponse,
  decodeSubagentThreadSummary,
  decodeSubagentThreadView
} from "./subagentViews";

const done = {
  createdAt: "2026-10-29T10:00:00.000Z", endedAt: "2026-10-29T10:05:00.000Z", id: "thread-1", mode: "foreground",
  name: "shop-amazon", outcome: "partial", reason: null, state: "done", turnCount: 2, type: null, updatedAt: "2026-10-29T10:05:00.000Z"
};
const running = { ...done, endedAt: null, id: "thread-2", mode: "background", name: "shop-ebay", outcome: null, state: "running",
  turnCount: 1, type: "browser" };
const turn = {
  brief: "Find the five best robot vacuums on amazon.es.", endedAt: null, files: [], id: "turn-1",
  messages: [{ createdAt: "2026-10-29T10:01:00.000Z", delivery: "delivered", text: "Also check the warranty." }],
  mode: "background", model: { displayName: "GPT-6 Luna", effort: null }, outcome: null, parentMessageId: "answer-1", reason: null,
  report: null, startedAt: "2026-10-29T10:00:00.000Z", state: "running",
  toolActivity: { calls: [{ origin: "workspace", round: 1, status: "running", toolName: "workspace__exec" }] }, workspaceActivity: null
};

describe("sub-agent routes", () => {
  it("names owner-only paths with encoded segments and one refusal for missing and forbidden", () => {
    expect(SUBAGENT_API_PATHS.chatThreads("chat 1")).toBe("/api/chats/chat%201/subagents");
    expect(SUBAGENT_API_PATHS.thread("chat-1", "thread/1")).toBe("/api/chats/chat-1/subagents/thread%2F1");
    expect(SUBAGENT_API_PATHS.stopThread("chat-1", "thread-1")).toBe("/api/chats/chat-1/subagents/thread-1/stop");
    expect(SUBAGENT_API_PATHS.stopAll("chat-1")).toBe("/api/chats/chat-1/subagents/stop-all");
    expect(SUBAGENT_API_PATHS.summary(["a", "b"])).toBe("/api/subagents?chatId=a&chatId=b");
    expect(SUBAGENT_NOT_FOUND).toEqual({ error: "subagent_not_found", status: 404 });
  });

  it("decodes a summary query of distinct valid chat ids within the bound", () => {
    expect(decodeSubagentSummaryQuery(new URLSearchParams("chatId=a&chatId=b&chatId=a"))).toEqual(["a", "b"]);
    expect(decodeSubagentSummaryQuery(new URLSearchParams(""))).toBeNull();
    expect(decodeSubagentSummaryQuery(new URLSearchParams("chatId=a&leaf=b"))).toBeNull();
    expect(decodeSubagentSummaryQuery(new URLSearchParams("chatId=../a"))).toBeNull();
    const many = new URLSearchParams(Array.from({ length: SUBAGENT_VIEW_LIMITS.chatsPerSummary + 1 }, (_, index) => ["chatId", `c${index}`]));
    expect(decodeSubagentSummaryQuery(many)).toBeNull();
  });
});

describe("sub-agent list projections", () => {
  it("decodes thread rows with their state and refuses an inconsistent one", () => {
    expect(decodeSubagentThreadSummary(done)).toEqual(done);
    expect(decodeSubagentThreadSummary(running)).toEqual(running);
    for (const value of [
      { ...done, endedAt: null }, { ...running, endedAt: done.endedAt }, { ...done, outcome: null }, { ...running, outcome: "done" },
      { ...done, turnCount: 0 }, { ...done, state: "paused" }, { ...done, name: "Shop" }, { ...done, brief: "x" }, { ...done, reason: "Bad" }
    ]) expect(decodeSubagentThreadSummary(value)).toBeNull();
  });

  it("decodes a chat's threads whose running count matches its active rows", () => {
    const chat = { chatId: "chat-1", running: 1, threads: [running, done], truncated: false };
    expect(decodeSubagentChatThreads(chat)).toEqual(chat);
    expect(decodeSubagentChatThreads({ ...chat, running: 2 })).toBeNull();
    expect(decodeSubagentChatThreads({ ...chat, threads: [done, done] })).toBeNull();
    expect(decodeSubagentSummaryResponse({ chats: [chat] })).toEqual({ chats: [chat] });
    expect(decodeSubagentSummaryResponse({ chats: [chat, chat] })).toBeNull();
  });
});

describe("sub-agent thread view", () => {
  it("decodes a read-only thread view whose state is its latest turn's", () => {
    const ended = { ...turn, endedAt: "2026-10-29T09:59:00.000Z", id: "turn-0", messages: [], mode: "foreground", outcome: "done",
      report: "Earlier work.", startedAt: "2026-10-29T09:50:00.000Z", state: "done", toolActivity: null };
    const view = { chatId: "chat-1", thread: running, truncated: false, turns: [ended, turn] };
    expect(decodeSubagentThreadView(view)).toEqual(view);
    expect(decodeSubagentThreadView({ ...view, turns: [turn, ended] })).toBeNull();
    expect(decodeSubagentThreadView({ ...view, turns: [] })).toBeNull();
    expect(decodeSubagentThreadView({ ...view, turns: [{ ...turn, toolActivity: { calls: "no" } }] })).toBeNull();
    expect(decodeSubagentThreadView({ ...view, turns: [{ ...turn, model: { displayName: "", effort: null } }] })).toBeNull();
  });

  it("decodes stop responses", () => {
    expect(decodeSubagentStopResponse({ thread: done })).toEqual({ thread: done });
    expect(decodeSubagentStopAllResponse({ stopped: 3 })).toEqual({ stopped: 3 });
    expect(decodeSubagentStopAllResponse({ stopped: -1 })).toBeNull();
  });
});

describe("an answer's sub-agent steps", () => {
  it("keeps the addressed sub-agent of a call row and the thread of a nested call", () => {
    const subagent = { mode: "foreground", name: "shop-amazon", threadId: "thread-1" };
    expect(decodeThreadToolActivity({ calls: [
      { origin: "session", round: 1, status: "complete", subagent, toolName: "call_subagent" },
      { origin: "workspace", round: 1, status: "complete", subagentThreadId: "thread-1", toolName: "workspace__exec" }
    ] })?.calls).toEqual([
      { origin: "session", round: 1, status: "complete", subagent, toolName: "call_subagent" },
      { origin: "workspace", round: 1, status: "complete", subagentThreadId: "thread-1", toolName: "workspace__exec" }
    ]);
    expect(decodeThreadToolActivity({ calls: [{ round: 1, status: "complete", subagent: { ...subagent, mode: "x" }, toolName: "call_subagent" }] }))
      .toBeNull();
    expect(decodeThreadToolActivity({ calls: [{ round: 1, status: "complete", subagentThreadId: "a b", toolName: "x" }] })).toBeNull();
  });
});
