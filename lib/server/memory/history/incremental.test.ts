import { describe, expect, it } from "vitest";
import type { MemoryRecallChunkMessageJoin } from "./chunking";
import {
  MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES,
  planMemoryHistoryTailUpdate,
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
  it("retains every proven chunk and reads one overlap turn for an append", () => {
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
      rebuildFromMessageOrdinal: 4,
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
      rebuildFromMessageOrdinal: 4,
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

  it("plans a 4,000-message append before content with one overlap turn", () => {
    const previousMessages = messages(2_000);
    const currentMessages = messages(2_001);
    const result = planMemoryHistoryTailUpdate({
      currentMessages,
      previousChunks: chunks(previousMessages),
      previousMessages
    });

    expect(result.mode).toBe("APPEND");
    expect(result.commonPathMessageCount).toBe(4_000);
    expect(result.rebuildFromMessageOrdinal).toBe(3_998);
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
});
