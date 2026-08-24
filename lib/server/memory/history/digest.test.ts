import { describe, expect, it } from "vitest";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  type MemoryHistoryIndexSourceIdentity,
  type MemoryHistoryPreparedChunk
} from "./contract";
import {
  MemoryChatDigestError,
  buildMemoryChatDigestRequest,
  decodeMemoryChatDigest,
  materializeMemoryChatDigest,
  selectMemoryChatDigestSourceChunks
} from "./digest";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";

const source: MemoryHistoryIndexSourceIdentity = Object.freeze({
  activeLeafMessageId: "assistant-30",
  branchGeneration: 4,
  chatId: "chat-digest",
  sourceHash: "a".repeat(64),
  sourceRevision: 9,
  userId: "user-digest"
});

function chunk(
  ordinal: number,
  overrides: Partial<MemoryHistoryPreparedChunk> = {}
): MemoryHistoryPreparedChunk {
  const text = `User: discuss topic ${ordinal}\n\nAssistant: decision ${ordinal}`;
  const updatedAt = new Date(Date.UTC(2026, 7, 10, 10, ordinal)).toISOString();
  return {
    approxTokens: 12,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
    contentHash: String((ordinal % 9) + 1).repeat(64),
    folderId: null,
    id: `chunk-${ordinal}`,
    languageCode: "en",
    messageJoins: [{
      endOffset: 20,
      messageId: `message-${ordinal}`,
      ordinal: 0,
      role: "user",
      safeTextHash: "b".repeat(64),
      sourceMessageContentHash: "c".repeat(64),
      sourceMessageUpdatedAt: updatedAt,
      startOffset: 0
    }],
    normalizedSafeSearchText: text.toLocaleLowerCase("und"),
    occurredFrom: updatedAt,
    occurredTo: updatedAt,
    ordinal,
    overlapFromPreviousTurnGroupIds: [],
    providerSafeText: text,
    publicationState: "ACTIVE",
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safeProjectedText: text,
    safetyClass: "NORMAL",
    sourceAssistantId: null,
    sourceContentHash: source.sourceHash,
    sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceRevision: source.sourceRevision,
    turnGroupIds: [`turn-${ordinal}`],
    userId: source.userId,
    ...overrides
  };
}

describe("Memory chat digests", () => {
  it("strictly decodes the bounded structured contract", () => {
    const decoded = decodeMemoryChatDigest({
      decisions: ["Use cedar deployment"],
      open_loops: ["Confirm rollout date"],
      summary: "The chat compared deployment options.",
      topics: ["Deployment"]
    });
    expect(decoded.summary).toBe("The chat compared deployment options.");
    expect(Object.isFrozen(decoded)).toBe(true);

    for (const invalid of [
      { ...decoded, extra: true, open_loops: decoded.openLoops },
      { decisions: [], open_loops: [], summary: "x".repeat(2_001), topics: [] },
      { decisions: ["x".repeat(257)], open_loops: [], summary: "summary", topics: [] },
      { decisions: [], open_loops: [], summary: "summary", topics: Array(13).fill("topic") }
    ]) {
      expect(() => decodeMemoryChatDigest(invalid)).toThrowError(
        new MemoryChatDigestError("memory_chat_digest_invalid")
      );
    }
  });

  it("selects only the bounded most-recent classified-safe source window", () => {
    const sourceChunks = Array.from({ length: 30 }, (_, ordinal) => chunk(ordinal));
    sourceChunks[29] = chunk(29, {
      publicationState: "SUPPRESSED",
      redactionState: "EXCLUDED",
      safetyClass: "SECRET_TAINTED"
    });
    const selected = selectMemoryChatDigestSourceChunks(sourceChunks);

    expect(selected).toHaveLength(24);
    expect(selected[0]?.id).toBe("chunk-5");
    expect(selected.at(-1)?.id).toBe("chunk-28");
    expect(selected.every((candidate) => candidate.publicationState === "ACTIVE"))
      .toBe(true);
    const request = buildMemoryChatDigestRequest(selected);
    expect(request.name).toBe("memory_chat_digest_v1");
    expect(request.userPrompt.length).toBeLessThan(32_000);
    expect(request.systemPrompt).toContain("untrusted quoted data");
  });

  it("materializes retry-stable source-bound digests and rejects secret output", () => {
    const selected = [chunk(0), chunk(1), chunk(2)];
    const content = decodeMemoryChatDigest({
      decisions: ["Use cedar deployment"],
      open_loops: ["Confirm rollout date"],
      summary: "The chat compared deployment options.",
      topics: ["Deployment", "Rollout"]
    });
    const first = materializeMemoryChatDigest({ chunks: selected, content, source });
    const retry = materializeMemoryChatDigest({ chunks: selected, content, source });

    expect(first).toEqual(retry);
    expect(first.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.anchorChunkId).toBe("chunk-2");
    expect(first.sourceChunkIds).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
    expect(first.sourceMessageIds).toEqual(["message-0", "message-1", "message-2"]);
    expect(first.safeDigestText).toContain("Summary:");
    expect(MEMORY_CHAT_DIGEST_PIPELINE_VERSION).toBe("memory-chat-digest-v1");

    const secret = decodeMemoryChatDigest({
      decisions: [],
      open_loops: [],
      summary: "api key: sk-digestSecret1234567890",
      topics: []
    });
    expect(() => materializeMemoryChatDigest({ chunks: selected, content: secret, source }))
      .toThrowError(new MemoryChatDigestError("memory_chat_digest_invalid"));
  });
});
