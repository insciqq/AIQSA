// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { chatSearchEligibleWhere } from "../chatSearch/eligibility";
import { loadPastChatSourcesByRun, recordedPastChatSources } from "./pastChatSources";

const source = (chatId: string, messageId: string) => ({ chatId, chatTitle: `Chat ${chatId}`, date: "2026-11-20T10:00:00.000Z",
  excerpt: `Excerpt of ${messageId}.`, messageId });

/** A `search_past_chats` call as its record keeps it (`ModelRunToolCall`). */
const searchCall = (results: readonly ReturnType<typeof source>[], extra: Record<string, unknown> = {}) => ({
  result: { callId: "call", content: [{ text: "Excerpts…", type: "text" }, { type: "json", value: { mode: "relevance", results } }],
    name: "search_past_chats", status: "complete" },
  subagentThreadId: null, toolName: "search_past_chats", ...extra
});

describe("past-chat sources under an answer", () => {
  it("reads only the main agent's completed searches of the run", () => {
    const failed = { ...searchCall([source("c3", "m3")]), result: { callId: "call", content: [], name: "search_past_chats", status: "error" } };
    expect(recordedPastChatSources({ id: "run-1", toolCalls: [
      searchCall([source("c1", "m1"), source("c2", "m2")]),
      searchCall([source("c1", "m1"), source("c4", "m4")]),
      failed,
      searchCall([source("c5", "m5")], { subagentThreadId: "thread-1" }),
      { result: { content: [{ type: "json", value: { mode: "relevance", results: [source("c6", "m6")] } }], name: "read_past_chat",
        status: "complete" }, toolName: "read_past_chat" }
    ] })).toEqual([source("c1", "m1"), source("c2", "m2"), source("c4", "m4")]);
  });

  it("keeps only chats that still exist and are eligible for their owner, checked when the chat loads", async () => {
    const findMany = vi.fn(async () => [{ id: "c2" }]);
    const byRun = await loadPastChatSourcesByRun({ chat: { findMany } } as never, { runs: [
      { id: "run-1", toolCalls: [searchCall([source("c1", "m1"), source("c2", "m2")])], userId: "owner" },
      { id: "run-2", toolCalls: [searchCall([source("c1", "m9")])], userId: "owner" },
      { id: "run-3", toolCalls: [], userId: "owner" }
    ], viewerUserId: "owner" });
    // One query for the page, under the one rule the index and the search tools share.
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({ select: { id: true },
      where: { AND: [{ id: { in: ["c1", "c2"] } }, chatSearchEligibleWhere("owner")] } });
    // A chat deleted, made Temporary or excluded since shows neither its title nor its excerpt.
    expect(byRun.get("run-1")).toEqual([source("c2", "m2")]);
    expect(byRun.has("run-2")).toBe(false);
    expect(byRun.has("run-3")).toBe(false);
  });

  it("shows nothing to anyone but the run's owner, and asks nothing when no answer searched", async () => {
    const findMany = vi.fn(async () => [{ id: "c1" }]);
    const db = { chat: { findMany } } as never;
    const runs = [{ id: "run-1", toolCalls: [searchCall([source("c1", "m1")])], userId: "owner" }];
    expect((await loadPastChatSourcesByRun(db, { runs, viewerUserId: "someone-else" })).size).toBe(0);
    expect((await loadPastChatSourcesByRun(db, { runs: [{ id: "run-2", toolCalls: [], userId: "owner" }], viewerUserId: "owner" })).size)
      .toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
