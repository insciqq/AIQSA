import { describe, expect, it } from "vitest";
import {
  memoryHistoryChunkEvidenceRootHash,
  memoryHistoryEvidenceRootHash
} from "./evidenceRoot";

const source = {
  messageId: "message-1",
  safeTextHash: "a".repeat(64),
  sourceMessageContentHash: "b".repeat(64),
  sourceMessageUpdatedAt: "2026-08-27T08:00:00.000Z"
} as const;

describe("memory history evidence roots", () => {
  it("groups only projections with the same ordered source coverage", () => {
    const round = memoryHistoryEvidenceRootHash({
      chatId: "chat-1",
      messageJoins: [{
        ...source,
        sourceEndOffset: 20,
        sourceStartOffset: 0
      }],
      userId: "owner-1"
    });
    const completeChunk = memoryHistoryChunkEvidenceRootHash({
      chatId: "chat-1",
      messageJoins: [{ ...source, endOffset: 20, startOffset: 0 }],
      userId: "owner-1"
    });
    const partialChunk = memoryHistoryChunkEvidenceRootHash({
      chatId: "chat-1",
      messageJoins: [{ ...source, endOffset: 20, startOffset: 10 }],
      userId: "owner-1"
    });

    expect(completeChunk).toBe(round);
    expect(partialChunk).not.toBe(round);
  });
});
