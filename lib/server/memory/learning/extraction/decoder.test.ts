import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactEvidenceFingerprint,
  memoryFactExtractionInputHash,
  memoryFactObservationFingerprint,
  type MemoryFactExtractionInput
} from "./contract";
import { decodeMemoryFactExtraction, MemoryFactDecodeError } from "./decoder";
import {
  MEMORY_FACT_EXTRACTION_TOOL_NAME,
  memoryFactExtractionPromptPayload
} from "./prompt";

function input(text: string): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    contextRefs: [],
    folderId: null,
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      evidenceEligible: true,
      id: "message-1",
      languageCode: "und",
      role: "user",
      text,
      updatedAt: "2026-08-11T09:00:00.000Z"
    }],
    source: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 2,
      chatId: "chat-1",
      memoryGenerationSnapshot: 0,
      sourceHash: "a".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 7,
      userId: "user-1"
    },
    sourceProjectionHash: "b".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "c".repeat(64),
    timeZone: "Europe/Moscow"
  };
  return { ...withoutHash, inputHash: memoryFactExtractionInputHash(withoutHash) };
}

describe("Memory fact extraction decoder", () => {
  it("supplies the bounded direct-user source to the semantic extractor", () => {
    const payload = JSON.parse(
      memoryFactExtractionPromptPayload(input("回答は短くしてください。"))
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      chat_id: "chat-1",
      context_after: [],
      context_before: [],
      folder_id: null
    });
  });

  it("domains stable observation and evidence fingerprints over UTF-16 offsets", () => {
    const text = "Note: 😀 cafe\u0301 is my favorite.";
    const quote = "😀 cafe\u0301";
    const source = input(text);
    const plan = decodeMemoryFactExtraction([{
      arguments: {
        observations: [{
          confidence_band: "HIGH",
          correction: false,
          dependency_refs: [],
          entities: [],
          future_useful: true,
          identity: {
            dimension_key: null,
            mode: "PROPOSITION",
            predicate_key: null,
            subject: {
              canonical_label: null,
              entity_type: "NONE",
              qualifiers: { brand: null, model: null }
            }
          },
          memory_type: "PREFERENCE",
          quote,
          reason_code: "durable_preference",
          sensitivity: "NORMAL",
          statement: "The user prefers emoji and decomposed cafe spelling.",
          temporal: {
            expected_at: null,
            expires_at: null,
            occurred_at: null,
            raw_expression: null,
            valid_from: null,
            valid_to: null
          },
          temporary: false,
          value: {
            frequency: null,
            kind: null,
            limit: null,
            place: null,
            role: null,
            schedule: null,
            state: null,
            strength: null,
            value: null
          }
        }]
      },
      id: "unicode-call",
      name: MEMORY_FACT_EXTRACTION_TOOL_NAME
    }], source);
    const candidate = plan.candidates[0]!;
    const evidence = candidate.evidence[0]!;
    expect(evidence).toMatchObject({
      endOffset: text.indexOf(quote) + quote.length,
      startOffset: text.indexOf(quote)
    });

    const observation = memoryFactObservationFingerprint(
      source,
      candidate,
      evidence
    );
    const support = memoryFactEvidenceFingerprint(source, candidate, evidence);
    const changedAuditSnapshot: MemoryFactExtractionInput = {
      ...source,
      source: {
        ...source.source,
        activeLeafMessageId: "a-later-leaf",
        branchGeneration: source.source.branchGeneration + 1,
        sourceHash: "d".repeat(64),
        sourceRevision: source.source.sourceRevision + 1
      }
    };
    expect(observation).toMatch(/^[a-f0-9]{64}$/u);
    expect(support).toMatch(/^[a-f0-9]{64}$/u);
    expect(support).not.toBe(observation);
    expect(memoryFactObservationFingerprint(
      changedAuditSnapshot,
      candidate,
      evidence
    )).toBe(observation);
    expect(memoryFactEvidenceFingerprint(
      source,
      candidate,
      { ...evidence, endOffset: evidence.endOffset - 1 }
    )).not.toBe(support);
  });

  it("rejects the retired packet instead of executing obsolete model-authored fields", () => {
    const legacy: ModelToolCall[] = [{
      arguments: { observations: [], decision: "ABSTAIN" },
      id: "legacy-call",
      name: MEMORY_FACT_EXTRACTION_TOOL_NAME
    }];
    expect(() => decodeMemoryFactExtraction(legacy, input("Temporary chat.")))
      .toThrow(MemoryFactDecodeError);
  });
});
