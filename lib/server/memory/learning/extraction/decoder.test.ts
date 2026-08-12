import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  type MemoryFactExtractionInput
} from "./contract";
import {
  decodeMemoryFactExtraction,
  MemoryFactDecodeError
} from "./decoder";
import {
  MEMORY_FACT_EXTRACTION_TOOL_NAME,
  memoryFactExtractionPromptPayload
} from "./prompt";
import { memorySha256 } from "../../persistence/lexical";
import { detectMemoryTextLanguage } from "../../history/language";

function input(text: string, id = "message-1"): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: "folder-1",
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-11T09:00:00.000Z",
      id,
      languageCode: detectMemoryTextLanguage(text),
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
  text: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    canonical_key: "user.preference.drink",
    category: "preference",
    confidence: 0.92,
    directness: "DIRECT",
    display_text: text,
    evidence: [{ message_id: "message-1", quote: text }],
    importance: 0.6,
    language: detectMemoryTextLanguage(text),
    modality: "PREFERENCE",
    negated: false,
    raw_temporal_expression: null,
    reason_code: null,
    scope: { target_id: "chat-1", type: "CHAT" },
    sensitivity: "NORMAL",
    state: "PENDING",
    structured_value: { value: text },
    valid_from: null,
    valid_to: null,
    ...overrides
  };
}

function calls(value: Record<string, unknown>): ModelToolCall[] {
  return [{
    arguments: { candidates: [value] },
    id: "call-1",
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }];
}

describe("Memory fact extraction decoder", () => {
  it("supplies exact chat and folder scope targets to the model", () => {
    const extractionInput = input("I prefer tea.");
    const payload = JSON.parse(
      memoryFactExtractionPromptPayload(extractionInput)
    ) as Record<string, unknown>;

    expect(payload).toMatchObject({
      chat_id: "chat-1",
      folder_id: "folder-1"
    });
  });

  it("accepts an exact durable RU preference with relational evidence bounds", () => {
    const text = "Я всегда предпочитаю зелёный чай.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      scope: { target_id: null, type: "GLOBAL_USER" },
      structured_value: { drink: "зелёный чай" }
    })), input(text));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      directness: "DIRECT",
      displayText: text,
      languageCode: "ru",
      scope: { targetId: null, type: "GLOBAL_USER" },
      sensitivity: "NORMAL",
      state: "PENDING"
    });
    expect(plan.candidates[0]?.evidence).toEqual([{
      endOffset: text.length,
      messageId: "message-1",
      sourceTextHash: memorySha256(text),
      startOffset: 0
    }]);
  });

  it("decodes schema-v2 canonical JSON text before grounding the value", () => {
    const text = "I always prefer cedar tea.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      language: "en",
      scope: { target_id: null, type: "GLOBAL_USER" },
      structured_value: JSON.stringify({ drink: "cedar tea" })
    })), input(text));

    expect(plan.candidates[0]?.proposedValue).toEqual({ drink: "cedar tea" });
  });

  it("normalizes an unescaped grounded scalar structured value", () => {
    const text = "For the backend API I prefer PostgreSQL + TypeScript.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      language: "en",
      structured_value: "PostgreSQL + TypeScript"
    })), input(text));

    expect(plan.candidates[0]?.proposedValue).toBe("PostgreSQL + TypeScript");
  });

  it("normalizes mixed-script language metadata from the exact display quote", () => {
    const text = "Я предпочитаю TypeScript.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      language: "ru",
      structured_value: JSON.stringify({ tool: "TypeScript" })
    })), input(text));

    expect(plan.candidates[0]?.languageCode).toBe("mixed");
  });

  it("rejects consideration presented as current STATE", () => {
    const text = "Я рассматриваю покупку MacBook Pro.";
    expect(() => decodeMemoryFactExtraction(calls(candidate(text, {
      modality: "STATE",
      structured_value: { product: "MacBook Pro" }
    })), input(text))).toThrowError(
      expect.objectContaining<Partial<MemoryFactDecodeError>>({
        code: "memory_fact_modality_invalid"
      })
    );
  });

  it("does not treat uncertainty about a decision as negation of consideration", () => {
    const text = "I am only considering a MacBook purchase; I have not decided.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      canonical_key: "user.consideration.macbook",
      category: "consideration",
      language: "en",
      modality: "CONSIDERATION",
      structured_value: JSON.stringify({ product: "MacBook" })
    })), input(text));

    expect(plan.candidates[0]?.negated).toBe(false);
  });

  it("derives explicit RU negation instead of trusting model metadata", () => {
    const text = "Я не люблю кофе.";
    const normalized = decodeMemoryFactExtraction(calls(candidate(text, {
      negated: false,
      structured_value: { drink: "кофе" }
    })), input(text));
    expect(normalized.candidates[0]?.negated).toBe(true);
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      negated: true,
      structured_value: { drink: "кофе" }
    })), input(text));
    expect(plan.candidates[0]?.negated).toBe(true);
  });

  it("does not misclassify the Russian 'не только' construction as negation", () => {
    const text = "Я не только люблю чай, но и кофе.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      structured_value: { drinks: ["чай", "кофе"] }
    })), input(text));
    expect(plan.candidates[0]?.negated).toBe(false);
  });

  it("quarantines unresolved relative time instead of guessing a date", () => {
    const text = "Завтра я планирую купить билет.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      canonical_key: "user.plan.ticket",
      category: "plan",
      modality: "PLAN",
      raw_temporal_expression: "Завтра",
      reason_code: "temporal_unresolved",
      state: "DEFERRED",
      structured_value: { action: "купить билет" }
    })), input(text));
    expect(plan.candidates[0]).toMatchObject({
      rawTemporalExpression: "Завтра",
      reasonCode: "temporal_unresolved",
      state: "DEFERRED",
      validFrom: null,
      validTo: null
    });
  });

  it("derives deferred state and reason from unresolved temporal evidence", () => {
    const text = "I am temporarily in Kazan until Friday; it is not my permanent residence.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      canonical_key: "user.location.temporary",
      category: "location",
      language: "en",
      modality: "STATE",
      raw_temporal_expression: "until Friday",
      reason_code: null,
      state: "PENDING",
      structured_value: JSON.stringify({ city: "Kazan" })
    })), input(text));

    expect(plan.candidates[0]).toMatchObject({
      negated: false,
      rawTemporalExpression: "until Friday",
      reasonCode: "temporal_unresolved",
      state: "DEFERRED"
    });
  });

  it("rejects sensitive categories even when the model labels them NORMAL", () => {
    const text = "Мой диагноз — мигрень.";
    expect(() => decodeMemoryFactExtraction(calls(candidate(text, {
      canonical_key: "user.health.diagnosis",
      category: "health",
      modality: "STATE",
      structured_value: { diagnosis: "мигрень" }
    })), input(text))).toThrowError(
      expect.objectContaining<Partial<MemoryFactDecodeError>>({
        code: "memory_fact_sensitive_output_rejected"
      })
    );
  });

  it("rejects ambiguous quotes and model-introduced structured values", () => {
    const repeated = "чай чай";
    expect(() => decodeMemoryFactExtraction(calls(candidate("чай", {
      evidence: [{ message_id: "message-1", quote: "чай" }],
      structured_value: { drink: "чай" }
    })), input(repeated))).toThrowError(
      expect.objectContaining<Partial<MemoryFactDecodeError>>({
        code: "memory_fact_evidence_ungrounded"
      })
    );

    const text = "I prefer tea.";
    expect(() => decodeMemoryFactExtraction(calls(candidate(text, {
      language: "en",
      structured_value: { drink: "coffee" }
    })), input(text))).toThrowError(
      expect.objectContaining<Partial<MemoryFactDecodeError>>({
        code: "memory_fact_output_ungrounded"
      })
    );
  });

  it("narrows unsupported global scope to the exact source chat", () => {
    const text = "I am considering a new laptop.";
    const plan = decodeMemoryFactExtraction(calls(candidate(text, {
      canonical_key: "user.consideration.laptop",
      category: "consideration",
      language: "en",
      modality: "CONSIDERATION",
      scope: { target_id: null, type: "GLOBAL_USER" },
      structured_value: { item: "laptop" }
    })), input(text));
    expect(plan.candidates[0]?.scope).toEqual({ targetId: "chat-1", type: "CHAT" });
  });
});
