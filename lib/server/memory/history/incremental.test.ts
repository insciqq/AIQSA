import { describe, expect, it } from "vitest";
import type { MemoryRecallChunkMessageJoin } from "./chunking";
import {
  alignMemoryHistoryIndexPageEnd,
  boundMemoryHistoryIndexPageEnd,
  DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS,
  MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES,
  memoryHistoryIndexMinimumPageEnd,
  memoryHistoryIndexPageLimitsAreValid,
  memoryHistoryIndexWriteCost,
  planMemoryHistoryTailUpdate,
  shrinkMemoryHistoryIndexPageEnd,
  type MemoryHistoryCheckpointMessageIdentity,
  type MemoryHistoryIncrementalChunk
} from "./incremental";

function messages(turnCount: number): MemoryHistoryCheckpointMessageIdentity[] {
  return Array.from({ length: turnCount * 2 }, (_, ordinal) => ({
    messageId: `${ordinal % 2 === 0 ? "user" : "assistant"}-${Math.floor(ordinal / 2)}`,
    sourceMessageUpdatedAt: new Date(Date.UTC(2026, 7, 10, 10, ordinal)).toISOString()
  }));
}

function join(
  message: MemoryHistoryCheckpointMessageIdentity,
  ordinal: number
): MemoryRecallChunkMessageJoin {
  return {
    endOffset: 20,
    messageId: message.messageId,
    ordinal,
    role: ordinal === 0 ? "user" : "assistant",
    safeTextHash: "a".repeat(64),
    sourceMessageContentHash: "b".repeat(64),
    sourceMessageUpdatedAt: message.sourceMessageUpdatedAt,
    startOffset: 0
  };
}

function chunks(
  source: readonly MemoryHistoryCheckpointMessageIdentity[]
): MemoryHistoryIncrementalChunk[] {
  return Array.from({ length: Math.floor(source.length / 2) }, (_, ordinal) => ({
    id: `chunk-${ordinal}`,
    messageJoins: [
      join(source[ordinal * 2]!, 0),
      join(source[ordinal * 2 + 1]!, 1)
    ],
    ordinal
  }));
}

describe("incremental Memory history planning", () => {
  it("retains every proven chunk and reads two prior groups for an append", () => {
    const previousMessages = messages(3);
    const currentMessages = messages(4);
    const result = planMemoryHistoryTailUpdate({
      currentMessages,
      previousChunks: chunks(previousMessages),
      previousMessages
    });

    expect(result).toEqual({
      commonPathMessageCount: 6,
      mode: "APPEND",
      rebuildFromMessageOrdinal: 2,
      reusedChunkIds: ["chunk-0", "chunk-1", "chunk-2"]
    });
  });

  it("uses the exact id/update-time longest common prefix for edits and divergence", () => {
    const previousMessages = messages(4);
    const editedMessages = messages(4).map((message, ordinal) => ordinal === 4
      ? { ...message, sourceMessageUpdatedAt: "2026-08-11T00:00:00.000Z" }
      : message);
    const edited = planMemoryHistoryTailUpdate({
      currentMessages: editedMessages,
      previousChunks: chunks(previousMessages),
      previousMessages
    });
    expect(edited).toMatchObject({
      commonPathMessageCount: 4,
      mode: "DIVERGENCE",
      rebuildFromMessageOrdinal: 0,
      reusedChunkIds: []
    });

    const branchedMessages = [
      ...previousMessages.slice(0, 4),
      ...messages(2).map((message, ordinal) => ({
        ...message,
        messageId: `branch-${ordinal}`
      }))
    ];
    expect(planMemoryHistoryTailUpdate({
      currentMessages: branchedMessages,
      previousChunks: chunks(previousMessages),
      previousMessages
    })).toMatchObject({
      commonPathMessageCount: 4,
      mode: "DIVERGENCE",
      rebuildFromMessageOrdinal: 0,
      reusedChunkIds: []
    });
  });

  it("reuses every exact chunk on an unchanged retry and falls back when unbounded", () => {
    const stableMessages = messages(3);
    const stableChunks = chunks(stableMessages);
    expect(planMemoryHistoryTailUpdate({
      currentMessages: stableMessages,
      previousChunks: stableChunks,
      previousMessages: stableMessages
    })).toEqual({
      commonPathMessageCount: 6,
      mode: "UNCHANGED",
      rebuildFromMessageOrdinal: 2,
      reusedChunkIds: ["chunk-0", "chunk-1", "chunk-2"]
    });

    const unbounded = Array.from(
      { length: MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES + 1 },
      (_, ordinal) => ({
        messageId: `message-${ordinal}`,
        sourceMessageUpdatedAt: "2026-08-10T10:00:00.000Z"
      })
    );
    const nextChunks = chunks(unbounded.slice(0, -1));
    expect(planMemoryHistoryTailUpdate({
      currentMessages: unbounded,
      previousChunks: nextChunks,
      previousMessages: unbounded
    })).toMatchObject({
      commonPathMessageCount: 0,
      mode: "FULL_REBUILD",
      rebuildFromMessageOrdinal: 0,
      reusedChunkIds: []
    });
  });

  it("plans a 4,000-message append before content with two prior groups", () => {
    const previousMessages = messages(2_000);
    const currentMessages = messages(2_001);
    const result = planMemoryHistoryTailUpdate({
      currentMessages,
      previousChunks: chunks(previousMessages),
      previousMessages
    });

    expect(result.mode).toBe("APPEND");
    expect(result.commonPathMessageCount).toBe(4_000);
    expect(result.rebuildFromMessageOrdinal).toBe(3_996);
    expect(result.reusedChunkIds).toHaveLength(2_000);
  });

  it("[E08] bounds edit and branch divergence to one maximum chunk plus overlap", () => {
    const previousMessages = messages(2_000);
    const currentMessages = previousMessages.map((message, ordinal) =>
      ordinal === 3_000
        ? { ...message, sourceMessageUpdatedAt: "2026-08-12T00:00:00.000Z" }
        : message);
    const result = planMemoryHistoryTailUpdate({
      currentMessages,
      previousChunks: chunks(previousMessages),
      previousMessages
    });

    expect(result).toMatchObject({
      commonPathMessageCount: 3_000,
      mode: "DIVERGENCE",
      rebuildFromMessageOrdinal: 2_986
    });
    expect(result.reusedChunkIds).toHaveLength(1_493);
  });

  it("resumes a partial checkpoint cursor with the ordinary APPEND proof", () => {
    const all = messages(10);
    const committedPage = all.slice(0, 7);
    const result = planMemoryHistoryTailUpdate({
      currentMessages: all,
      previousChunks: chunks(committedPage.slice(0, 6)),
      previousMessages: committedPage
    });

    // The cursor may end on a user prompt; the next page still appends
    // without rebuilding the proven prefix.
    expect(result).toMatchObject({
      commonPathMessageCount: 7,
      mode: "APPEND",
      rebuildFromMessageOrdinal: 3
    });
    expect(result.reusedChunkIds).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
  });
});

describe("Memory history index pages", () => {
  const roles = ["user", "assistant", "user", "assistant", "user", "assistant"];

  it("never splits the first uncovered prompt from its reply", () => {
    expect(memoryHistoryIndexMinimumPageEnd(roles, 0)).toBe(2);
    expect(memoryHistoryIndexMinimumPageEnd(roles, 1)).toBe(2);
    expect(memoryHistoryIndexMinimumPageEnd(["user", "user"], 0)).toBe(1);
    expect(memoryHistoryIndexMinimumPageEnd(roles, roles.length)).toBe(roles.length);
  });

  it("keeps a later prompt with its reply without cutting the minimum unit", () => {
    expect(alignMemoryHistoryIndexPageEnd(roles, 2, 3)).toBe(2);
    expect(alignMemoryHistoryIndexPageEnd(roles, 2, 5)).toBe(4);
    expect(alignMemoryHistoryIndexPageEnd(roles, 2, 4)).toBe(4);
    expect(alignMemoryHistoryIndexPageEnd(roles, 2, roles.length)).toBe(roles.length);
  });

  it("bounds cumulative page cost from the rewind and always admits one unit", () => {
    const costs = [5, 5, 5, 5, 5, 5];
    const bound = (limit: number, costStartOrdinal = 0, minimumEnd = 2) =>
      boundMemoryHistoryIndexPageEnd({
        cost: (ordinal) => costs[ordinal]!,
        costStartOrdinal,
        limit,
        maximumEnd: costs.length,
        minimumEnd
      });

    expect(bound(30)).toBe(6);
    expect(bound(12)).toBe(2);
    expect(bound(1)).toBe(2);
    expect(bound(17)).toBe(3);
    // Rewind cost counts, but the first uncovered unit is still admitted.
    expect(bound(12, 0, 6)).toBe(6);
    expect(bound(12, 2, 5)).toBe(5);
    expect(bound(20, 2, 5)).toBe(6);
  });

  it("halves only the uncovered part and stops at the indivisible unit", () => {
    expect(shrinkMemoryHistoryIndexPageEnd(roles, 0, 2, 6)).toBe(2);
    expect(shrinkMemoryHistoryIndexPageEnd(roles, 2, 4, 6)).toBe(4);
    expect(shrinkMemoryHistoryIndexPageEnd(roles, 1, 2, 6)).toBe(4);
    expect(shrinkMemoryHistoryIndexPageEnd(roles, 2, 4, 4)).toBeNull();
    expect(shrinkMemoryHistoryIndexPageEnd(["assistant", "user"], 0, 1, 1)).toBeNull();
  });

  it("estimates a page's locked writes from its content and settled tool calls", () => {
    // A reprojected message joins its round; its text becomes chunks and
    // round segments; every settled call becomes an observation.
    expect(memoryHistoryIndexWriteCost({ contentBytes: 0, toolCalls: 0 })).toBe(3);
    expect(memoryHistoryIndexWriteCost({ contentBytes: 220, toolCalls: 0 })).toBe(4);
    expect(memoryHistoryIndexWriteCost({ contentBytes: 221, toolCalls: 0 })).toBe(5);
    expect(memoryHistoryIndexWriteCost({ contentBytes: 5_040, toolCalls: 2 })).toBe(3 + 23 + 6);
    // A message the page does not reproject costs only its rebuilt calls.
    expect(memoryHistoryIndexWriteCost({ contentBytes: null, toolCalls: 4 })).toBe(12);
    expect(memoryHistoryIndexWriteCost({ contentBytes: null, toolCalls: 0 })).toBe(0);
    // A long chat's first page stops at the write budget, not at the chunk,
    // byte or message bounds: about fifteen turns of 1.5 KB prompts, 5 KB
    // answers and two settled calls.
    const turnCost = memoryHistoryIndexWriteCost({ contentBytes: 1_540, toolCalls: 0 }) +
      memoryHistoryIndexWriteCost({ contentBytes: 5_040, toolCalls: 2 });
    const roles = Array.from({ length: 600 }, (_, ordinal) => ordinal % 2 === 0 ? "user" : "assistant");
    const end = alignMemoryHistoryIndexPageEnd(roles, 2, boundMemoryHistoryIndexPageEnd({
      cost: (ordinal) => memoryHistoryIndexWriteCost({
        contentBytes: ordinal % 2 === 0 ? 1_540 : 5_040,
        toolCalls: ordinal % 2 === 0 ? 0 : 2
      }),
      costStartOrdinal: 0,
      limit: DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS.maxIndexWrites,
      maximumEnd: roles.length,
      minimumEnd: 2
    }));
    expect(end % 2).toBe(0);
    expect(end / 2).toBe(Math.floor(DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS.maxIndexWrites / turnCost));
    expect(end / 2).toBeGreaterThanOrEqual(10);
    expect(end / 2).toBeLessThanOrEqual(20);
  });

  it("keeps per-job limits positive and within the per-call chunk bound", () => {
    expect(memoryHistoryIndexPageLimitsAreValid(DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS))
      .toBe(true);
    expect(memoryHistoryIndexPageLimitsAreValid({
      ...DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS,
      maxChunks: 0
    })).toBe(false);
    expect(memoryHistoryIndexPageLimitsAreValid({
      ...DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS,
      maxChunks: DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS.maxChunks + 1
    })).toBe(false);
    expect(memoryHistoryIndexPageLimitsAreValid({
      ...DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS,
      maxToolCalls: 1.5
    })).toBe(false);
    expect(memoryHistoryIndexPageLimitsAreValid({
      ...DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS,
      maxIndexWrites: 0
    })).toBe(false);
  });
});
