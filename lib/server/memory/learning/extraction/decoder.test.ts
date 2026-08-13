import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  type MemoryFactExtractionInput
} from "./contract";
import { decodeMemoryFactExtraction, MemoryFactDecodeError } from "./decoder";
import {
  MEMORY_FACT_EXTRACTION_TOOL_NAME,
  memoryFactExtractionPromptPayload
} from "./prompt";

function input(text: string, id = "message-1"): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: "folder-1",
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      id,
      languageCode: "und",
      text,
      updatedAt: "2026-08-11T09:00:00.000Z"
    }],
    source: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 2,
      chatId: "chat-1",
      sourceHash: "a".repeat(64),
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

function candidate(
  sourceText: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    core_eligible: true,
    core_salience: "HIGH",
    directness: "DIRECT",
    display_text: "The user prefers concise answers.",
    evidence: [{
      end_offset: sourceText.length,
      message_id: "message-1",
      start_offset: 0
    }],
    language: "und",
    modality: "PREFERENCE",
    raw_temporal_expression: null,
    scope: { target_id: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    structured_value: JSON.stringify({ answerStyle: "concise" }),
    valid_from: null,
    valid_to: null,
    ...overrides
  };
}

function calls(
  candidates: readonly Record<string, unknown>[],
  decision: "ABSTAIN" | "STORE" = "STORE"
): ModelToolCall[] {
  return [{
    arguments: { candidates, decision },
    id: "call-1",
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }];
}

describe("Memory fact extraction decoder", () => {
  it("supplies exact source scope targets to the semantic extractor", () => {
    const payload = JSON.parse(
      memoryFactExtractionPromptPayload(input("回答は短くしてください。"))
    ) as Record<string, unknown>;

    expect(payload).toMatchObject({ chat_id: "chat-1", folder_id: "folder-1" });
  });

  it("accepts structurally grounded multilingual output without lexical reinterpretation", () => {
    const sourceText = "回答は短くしてください。";
    const plan = decodeMemoryFactExtraction(calls([candidate(sourceText, {
      directness: "PARAPHRASED",
      display_text: "The user prefers concise answers.",
      language: "ja",
      structured_value: JSON.stringify({ style: "brief" })
    })]), input(sourceText));

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      canonicalKey: expect.stringMatching(/^auto\.[a-f0-9]{64}$/u),
      coreEligible: true,
      coreSalience: "HIGH",
      directness: "PARAPHRASED",
      displayText: "The user prefers concise answers.",
      languageCode: "ja",
      proposedValue: { style: "brief" },
      scope: { targetId: null, type: "GLOBAL_USER" },
      state: "PENDING"
    });
    expect(plan.candidates[0]?.evidence).toEqual([{
      endOffset: sourceText.length,
      messageId: "message-1",
      sourceTextHash: memorySha256(sourceText),
      startOffset: 0
    }]);
  });

  it("accepts an explicit ABSTAIN decision with no candidates", () => {
    expect(decodeMemoryFactExtraction(calls([], "ABSTAIN"), input("一時的な雑談")))
      .toMatchObject({ candidates: [] });
  });

  it.each([
    ["bad evidence offsets", { evidence: [{ end_offset: 500, message_id: "message-1", start_offset: 0 }] }],
    ["invented scope target", { scope: { target_id: "another-chat", type: "CHAT" } }],
    ["invalid language tag", { language: "not_a_locale" }],
    ["inconsistent Core fields", { core_eligible: false, core_salience: "HIGH" }],
    ["non-normal sensitivity", { sensitivity: "SECRET" }]
  ])("rejects %s structurally", (_label, overrides) => {
    const sourceText = "Any script remains eligible.";
    expect(() => decodeMemoryFactExtraction(
      calls([candidate(sourceText, overrides)]),
      input(sourceText)
    )).toThrow(MemoryFactDecodeError);
  });

  it("rejects extra semantic fields and inconsistent STORE/ABSTAIN shape", () => {
    const sourceText = "I prefer concise replies.";
    expect(() => decodeMemoryFactExtraction(calls([candidate(sourceText, {
      canonical_key: "model.owned.key"
    })]), input(sourceText))).toThrow(MemoryFactDecodeError);
    expect(() => decodeMemoryFactExtraction(calls([], "STORE"), input(sourceText)))
      .toThrowError(expect.objectContaining({ code: "memory_fact_decision_invalid" }));
  });
});
