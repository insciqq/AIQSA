import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { MemoryRecallChunkMessageJoin } from "./chunking";
import {
  MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES,
  planMemoryHistoryIncrementalUpdate,
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
  it("rewinds one complete turn for an append and reuses only the stable prefix", () => {
    const previousMessages = messages(3);
    const currentMessages = messages(4);
    const result = planMemoryHistoryIncrementalUpdate({
      currentMessages,
      nextChunks: chunks(currentMessages),
      previousChunks: chunks(previousMessages),
      previousMessages
    });

    expect(result).toEqual({
      commonPathMessageCount: 6,
      mode: "APPEND",
      rebuildFromMessageOrdinal: 4,
      rebuiltChunkIds: ["chunk-2", "chunk-3"],
      reusedChunkIds: ["chunk-0", "chunk-1"]
    });
  });

  it("uses the exact id/update-time longest common prefix for edits and divergence", () => {
    const previousMessages = messages(4);
    const editedMessages = messages(4).map((message, ordinal) => ordinal === 4
      ? { ...message, sourceMessageUpdatedAt: "2026-08-11T00:00:00.000Z" }
      : message);
    const edited = planMemoryHistoryIncrementalUpdate({
      currentMessages: editedMessages,
      nextChunks: chunks(editedMessages),
      previousChunks: chunks(previousMessages),
      previousMessages
    });
    expect(edited).toMatchObject({
      commonPathMessageCount: 4,
      mode: "DIVERGENCE",
      rebuildFromMessageOrdinal: 2,
      rebuiltChunkIds: ["chunk-1", "chunk-2", "chunk-3"],
      reusedChunkIds: ["chunk-0"]
    });

    const branchedMessages = [
      ...previousMessages.slice(0, 4),
      ...messages(2).map((message, ordinal) => ({
        ...message,
        messageId: `branch-${ordinal}`
      }))
    ];
    expect(planMemoryHistoryIncrementalUpdate({
      currentMessages: branchedMessages,
      nextChunks: chunks(branchedMessages),
      previousChunks: chunks(previousMessages),
      previousMessages
    })).toMatchObject({
      commonPathMessageCount: 4,
      mode: "DIVERGENCE",
      rebuildFromMessageOrdinal: 2,
      reusedChunkIds: ["chunk-0"]
    });
  });

  it("reuses every exact chunk on an unchanged retry and falls back when unbounded", () => {
    const stableMessages = messages(3);
    const stableChunks = chunks(stableMessages);
    expect(planMemoryHistoryIncrementalUpdate({
      currentMessages: stableMessages,
      nextChunks: stableChunks,
      previousChunks: stableChunks,
      previousMessages: stableMessages
    })).toEqual({
      commonPathMessageCount: 6,
      mode: "UNCHANGED",
      rebuildFromMessageOrdinal: 4,
      rebuiltChunkIds: [],
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
    expect(planMemoryHistoryIncrementalUpdate({
      currentMessages: unbounded,
      nextChunks,
      previousChunks: nextChunks,
      previousMessages: unbounded
    })).toMatchObject({
      commonPathMessageCount: 0,
      mode: "FULL_REBUILD",
      rebuildFromMessageOrdinal: 0,
      rebuiltChunkIds: nextChunks.map(({ id }) => id),
      reusedChunkIds: []
    });
  });

  it("keeps a 4,000-turn append's rebuild set bounded to the overlap tail", () => {
    const previousMessages = messages(4_000);
    const currentMessages = messages(4_001);
    const startedAt = performance.now();
    const result = planMemoryHistoryIncrementalUpdate({
      currentMessages,
      nextChunks: chunks(currentMessages),
      previousChunks: chunks(previousMessages),
      previousMessages
    });
    const durationMs = performance.now() - startedAt;

    expect(result.mode).toBe("APPEND");
    expect(result.commonPathMessageCount).toBe(8_000);
    expect(result.reusedChunkIds).toHaveLength(3_999);
    expect(result.rebuiltChunkIds).toEqual(["chunk-3999", "chunk-4000"]);
    expect(durationMs).toBeLessThan(1_000);
  });
});
