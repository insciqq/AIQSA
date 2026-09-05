import { describe, expect, it } from "vitest";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryRecallRoundProjection } from "./rounds";
import {
  MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS,
  MEMORY_RECALL_ROUND_SEGMENT_MAX_PER_ROUND,
  MEMORY_RECALL_ROUND_SEGMENT_OVERLAP_CHARACTERS,
  projectMemoryRecallRoundSegments
} from "./segments";

function round(rawSafeText: string): MemoryRecallRoundProjection {
  const labelLength = "User: ".length;
  const sourceText = rawSafeText.slice(labelLength);
  return {
    approxTokens: rawSafeText.length,
    branchGeneration: 1,
    chatId: "chat-segments",
    contextualKeyPolicyVersion: "memory-contextual-test-v1",
    contextualKeyState: "GENERATED",
    contextualNarrativeText: "User described the durable launch evidence.",
    contextualSearchHash: memorySha256(rawSafeText),
    contextualSearchText: rawSafeText,
    contentHash: memorySha256({ rawSafeText }),
    evidenceRootHash: "e".repeat(64),
    folderId: null,
    groupId: "group-segments",
    groupKind: "STANDALONE",
    id: "round-segments",
    languageCode: "en",
    messageJoins: [{
      messageId: "message-segments",
      ordinal: 0,
      role: "user",
      roundEndOffset: rawSafeText.length,
      roundStartOffset: labelLength,
      safeTextHash: memorySha256(sourceText),
      sourceEndOffset: sourceText.length,
      sourceMessageContentHash: "c".repeat(64),
      sourceMessageUpdatedAt: "2026-08-28T10:00:00.000Z",
      sourceStartOffset: 0
    }],
    occurredFrom: "2026-08-28T10:00:00.000Z",
    occurredTo: "2026-08-28T10:00:00.000Z",
    ordinal: 0,
    parentChunkId: "chunk-segments",
    projectionVersion: "memory-recall-round-projection-v1",
    rawSafeText,
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safetyClass: "NORMAL",
    sourceAssistantId: null,
    sourceContentHash: "d".repeat(64),
    sourceProjectionVersion: "memory-history-source-projection-v6",
    sourceRevision: 2,
    supportingRoundIds: [],
    userId: "owner"
  };
}

describe("recall round segments", () => {
  it("keeps a short round as one exact deterministic authoritative segment", () => {
    const source = round("User: The launch code is cedar-47.");
    const first = projectMemoryRecallRoundSegments(source);
    const second = projectMemoryRecallRoundSegments(source);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      position: "SINGLE",
      rawEndOffsetUtf16: source.rawSafeText.length,
      rawSafeText: source.rawSafeText,
      rawStartOffsetUtf16: 0,
      roundId: source.id
    });
    expect(first[0]?.messageJoins).toEqual([
      expect.objectContaining({
        segmentEndOffset: source.rawSafeText.length,
        segmentStartOffset: "User: ".length,
        sourceEndOffset: source.rawSafeText.length - "User: ".length,
        sourceStartOffset: 0
      })
    ]);
  });

  it("covers prefix, middle, and suffix facts in a 100k round with bounded overlap", () => {
    const raw = `User: PREFIX_FACT ${"a".repeat(49_000)} MIDDLE_FACT ` +
      `${"b".repeat(50_000)} SUFFIX_FACT`;
    const projected = projectMemoryRecallRoundSegments(round(raw));

    expect(projected.length).toBeGreaterThan(3);
    expect(projected.length).toBeLessThanOrEqual(
      MEMORY_RECALL_ROUND_SEGMENT_MAX_PER_ROUND
    );
    expect(projected[0]?.position).toBe("PREFIX");
    expect(projected.at(-1)?.position).toBe("SUFFIX");
    expect(projected.some(({ position }) => position === "MIDDLE")).toBe(true);
    expect(projected.every(({ contextualSearchText, rawSafeText }) =>
      contextualSearchText.includes(rawSafeText.toLocaleLowerCase("und")) &&
      rawSafeText.length <= MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS)).toBe(true);
    for (const fact of ["PREFIX_FACT", "MIDDLE_FACT", "SUFFIX_FACT"]) {
      expect(projected.some(({ rawSafeText }) => rawSafeText.includes(fact))).toBe(true);
    }
    for (let index = 1; index < projected.length; index += 1) {
      const previous = projected[index - 1]!;
      const current = projected[index]!;
      expect(previous.rawEndOffsetUtf16 - current.rawStartOffsetUtf16)
        .toBeGreaterThanOrEqual(MEMORY_RECALL_ROUND_SEGMENT_OVERLAP_CHARACTERS);
      expect(current.rawSafeText).toBe(raw.slice(
        current.rawStartOffsetUtf16,
        current.rawEndOffsetUtf16
      ));
    }
  });

  it("never splits a surrogate pair or redaction placeholder", () => {
    const raw = `User: ${"x".repeat(2_990)}😀[REDACTED:JWT]${"y".repeat(4_000)}`;
    const projected = projectMemoryRecallRoundSegments(round(raw));
    const placeholderStart = raw.indexOf("[REDACTED:JWT]");
    const placeholderEnd = placeholderStart + "[REDACTED:JWT]".length;

    expect(projected.every(({ rawSafeText }) =>
      !rawSafeText.match(/[\uD800-\uDBFF]$/u) &&
      !rawSafeText.match(/^[\uDC00-\uDFFF]/u))).toBe(true);
    expect(projected.every(({ rawEndOffsetUtf16, rawStartOffsetUtf16 }) =>
      !(rawStartOffsetUtf16 > placeholderStart && rawStartOffsetUtf16 < placeholderEnd) &&
      !(rawEndOffsetUtf16 > placeholderStart && rawEndOffsetUtf16 < placeholderEnd)
    )).toBe(true);
  });

  it("maps exact intersections when a segment crosses message boundaries", () => {
    const raw = `User: ${"u".repeat(2_700)}\n\nAssistant: ${"a".repeat(3_500)}`;
    const userStart = "User: ".length;
    const userEnd = userStart + 2_700;
    const assistantStart = userEnd + "\n\nAssistant: ".length;
    const source = {
      ...round(raw),
      groupKind: "TURN" as const,
      messageJoins: [{
        messageId: "user-message",
        ordinal: 0,
        role: "user" as const,
        roundEndOffset: userEnd,
        roundStartOffset: userStart,
        safeTextHash: memorySha256("u".repeat(2_700)),
        sourceEndOffset: 2_700,
        sourceMessageContentHash: "1".repeat(64),
        sourceMessageUpdatedAt: "2026-08-28T10:00:00.000Z",
        sourceStartOffset: 0
      }, {
        messageId: "assistant-message",
        ordinal: 1,
        role: "assistant" as const,
        roundEndOffset: raw.length,
        roundStartOffset: assistantStart,
        safeTextHash: memorySha256("a".repeat(3_500)),
        sourceEndOffset: 3_500,
        sourceMessageContentHash: "2".repeat(64),
        sourceMessageUpdatedAt: "2026-08-28T10:01:00.000Z",
        sourceStartOffset: 0
      }]
    };
    const projected = projectMemoryRecallRoundSegments(source);
    const crossing = projected.find(({ messageJoins }) => messageJoins.length === 2);

    expect(crossing).toBeDefined();
    for (const join of crossing!.messageJoins) {
      expect(join.segmentEndOffset - join.segmentStartOffset)
        .toBe(join.sourceEndOffset - join.sourceStartOffset);
      expect(crossing!.rawSafeText.slice(join.segmentStartOffset, join.segmentEndOffset))
        .toBe(raw.slice(
          crossing!.rawStartOffsetUtf16 + join.segmentStartOffset,
          crossing!.rawStartOffsetUtf16 + join.segmentEndOffset
      ));
    }
  });

  it("keeps the largest permitted round within the hard segment-count bound", () => {
    const raw = `User: ${"x".repeat(200_000 - "User: ".length)}`;
    const projected = projectMemoryRecallRoundSegments(round(raw));

    expect(projected.length).toBeGreaterThan(1);
    expect(projected.length).toBeLessThanOrEqual(
      MEMORY_RECALL_ROUND_SEGMENT_MAX_PER_ROUND
    );
    expect(projected[0]?.rawStartOffsetUtf16).toBe(0);
    expect(projected.at(-1)?.rawEndOffsetUtf16).toBe(raw.length);
    expect(projected.every(({ rawSafeTextHash, rawSafeText }) =>
      rawSafeTextHash === memorySha256(rawSafeText))).toBe(true);
  });
});
