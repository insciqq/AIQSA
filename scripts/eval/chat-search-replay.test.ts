import { describe, expect, it } from "vitest";
import { parseReplaySnapshot, replayAggregates, replaySearchInput, type ReplayObservation } from "./chat-search-replay-support";

const line = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  chats: [{ chatId: "chat-a", messageIds: ["m-a1", "m-a2"], rank: 1 }, { chatId: "chat-b", messageIds: ["m-b1"], rank: 3 }],
  oldDurationMs: 4_800, oldOutcome: "RESULTS", ownerId: "owner-1", query: "synthetic template query", searchChatId: "chat-now",
  searchedAt: "2026-11-12T21:30:00.000Z", v: 1, ...overrides
});

function observation(overrides: Partial<ReplayObservation> = {}): ReplayObservation {
  return { clipped: false, degraded: null, latencyMs: 1_200, newResults: [], oldChats: [], oldDurationMs: 4_000, oldHitsInSearchChat: 0,
    oldMessagesMissing: 0, outcome: "searched", rerank: "used", ...overrides };
}

describe("the production replay's snapshot", () => {
  it("keeps the JSON lines psql printed and counts what it skipped", () => {
    const parsed = parseReplaySnapshot(["SET", line(), "", "{not json", line({ v: 2 }), line({ chats: [] })].join("\n"));
    expect(parsed.lines.map((entry) => entry.chats.length)).toEqual([2, 0]);
    expect(parsed).toMatchObject({ invalid: 1, notJson: 2 });
  });

  it("searches as of the day after the recorded search, within the tool's query bound", () => {
    const [entry] = parseReplaySnapshot(line()).lines;
    expect(replaySearchInput(entry!, "as_of")).toEqual({ clipped: false,
      input: { after: null, before: "2026-11-13", limit: 8, query: "synthetic template query" } });
    expect(replaySearchInput(entry!, "none").input.before).toBeNull();
    const [long] = parseReplaySnapshot(line({ query: "word ".repeat(150) })).lines;
    const clipped = replaySearchInput(long!, "none");
    expect(clipped.clipped).toBe(true);
    expect(clipped.input.query!.length).toBeLessThanOrEqual(500);
    expect(clipped.input.query!.endsWith("word")).toBe(true);
  });
});

describe("the production replay's aggregates", () => {
  it("compares old chats and turns with the new results and names why an old hit is missing", () => {
    const aggregates = replayAggregates([
      observation({ newResults: [{ chatId: "chat-a", turnId: "t-a1" }, { chatId: "chat-x", turnId: "t-x" }],
        oldChats: [{ chatId: "chat-a", status: "searchable", turnIds: ["t-a1"] }, { chatId: "chat-b", status: "not_indexed", turnIds: ["t-b1"] }] }),
      observation({ newResults: [{ chatId: "chat-y", turnId: "t-y" }, { chatId: "chat-z", turnId: "t-z" }, { chatId: "chat-c", turnId: "t-c" }],
        oldChats: [{ chatId: "chat-c", status: "searchable", turnIds: ["t-c0"] }], oldHitsInSearchChat: 1 }),
      observation({ newResults: [{ chatId: "chat-q", turnId: "t-q" }] }),
      observation({ latencyMs: null, outcome: "owner_missing", rerank: null })
    ]);
    expect(aggregates).toMatchObject({
      allOldChatsInNewTop8: 0.5, meanOldChatRecallAt8: 0.75, oldEmptyNewFound: 1, oldFoundNewEmpty: 0, oldHitsInSearchChat: 1,
      oldChatHits: { missingBecause: { notIndexed: 1, notSearchable: 0, rankedOut: 0 }, missingFromNewTop8: 1, total: 3 },
      oldTopChatInNewTop: { at1: 0.5, at3: 1, at5: 1, at8: 1 },
      oldTurns: { inNewResults: 1, share: 0.333, total: 3 },
      outcomes: { owner_missing: 1, searched: 3 }, searches: 4, withOldHits: 2
    });
    const text = JSON.stringify(aggregates);
    for (const value of ["chat-a", "chat-b", "t-a1", "owner-1", "synthetic"]) expect(text).not.toContain(value);
  });
});
