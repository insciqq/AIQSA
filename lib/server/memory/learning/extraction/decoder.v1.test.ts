import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../../tools/types";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  type MemoryFactExtractionInput
} from "./contract";
import {
  decodeMemoryFactExtraction,
  decodeMemoryFactExtractionV1
} from "./decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

function input(text: string): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: null,
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-21T09:00:00.000Z",
      id: "current-user-message",
      languageCode: "en",
      text,
      updatedAt: "2026-08-21T09:00:00.000Z"
    }],
    source: {
      activeLeafMessageId: "assistant-message",
      branchGeneration: 1,
      chatId: "chat-1",
      sourceHash: "a".repeat(64),
      sourceRevision: 2,
      userId: "user-1"
    },
    sourceProjectionHash: "b".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "c".repeat(64),
    timeZone: "UTC"
  };
  return { ...withoutHash, inputHash: memoryFactExtractionInputHash(withoutHash) };
}

function call(candidates: readonly Record<string, unknown>[]): ModelToolCall[] {
  return [{
    arguments: { candidates },
    id: "call-1",
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }];
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "preferences",
    confidence_band: "HIGH",
    correction: false,
    future_useful: true,
    quote: "I prefer concise replies.",
    reason_code: "durable_preference",
    response_preference: "concise replies",
    sensitivity: "NORMAL",
    statement: "The user prefers concise replies.",
    temporary: false,
    ...overrides
  };
}

describe("Personal Memory v1 extraction decoder", () => {
  it("computes exact UTF-16 evidence server-side and isolates an invalid sibling", () => {
    const text = "I prefer concise replies. I am testing this.";
    const plan = decodeMemoryFactExtractionV1(call([
      candidate(),
      candidate({ confidence_band: "LOW", quote: "I am testing this.", statement: "A temporary test." })
    ]), input(text));

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.evidence).toEqual([{
      endOffset: "I prefer concise replies.".length,
      messageId: "current-user-message",
      quote: "I prefer concise replies.",
      sourceTextHash: memorySha256(text),
      startOffset: 0
    }]);
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 1,
      reasonCode: "REJECT_LOW_CONFIDENCE"
    }]);
  });

  it("rejects repeated quotes as ambiguous and never widens the source window", () => {
    const text = "I prefer concise replies. I prefer concise replies.";
    const plan = decodeMemoryFactExtractionV1(call([candidate()]), input(text));
    expect(plan.candidates).toHaveLength(0);
    expect(plan.rejections?.[0]?.reasonCode).toBe("REJECT_AMBIGUOUS");

    const twoMessageInput = {
      ...input("I prefer concise replies."),
      messages: [
        ...input("I prefer concise replies.").messages,
        { ...input("I prefer concise replies.").messages[0]!, id: "older-user-message" }
      ]
    } as MemoryFactExtractionInput;
    expect(decodeMemoryFactExtractionV1(call([candidate()]), twoMessageInput).rejections)
      .toEqual([{ candidateOrdinal: 0, reasonCode: "REJECT_STALE_SOURCE" }]);
  });

  it("accepts an empty strict packet without falling back to the retired decoder", () => {
    const plan = decodeMemoryFactExtraction(call([]), input("Nothing durable here."));
    expect(plan.candidates).toEqual([]);
    expect(plan.rejections).toEqual([]);
  });

  it("reports duplicate accepted identities independently", () => {
    const plan = decodeMemoryFactExtractionV1(
      call([candidate(), candidate()]),
      input("I prefer concise replies.")
    );
    expect(plan.candidates).toHaveLength(1);
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 1,
      reasonCode: "REJECT_DUPLICATE"
    }]);
  });

  it("accepts legacy SENSITIVE output as an ordinary fact", () => {
    const plan = decodeMemoryFactExtractionV1(
      call([candidate({ sensitivity: "SENSITIVE" })]),
      input("I prefer concise replies.")
    );

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toMatchObject([{
      category: "preferences",
      sensitivity: "NORMAL"
    }]);
  });

  it("rejects a structurally secret model output without discarding a valid sibling", () => {
    const validQuote = "I prefer concise replies.";
    const supportingQuote = "I work remotely.";
    const plan = decodeMemoryFactExtractionV1(call([
      candidate({
        category: "work",
        quote: supportingQuote,
        response_preference: null,
        statement: "API key: sk-abcdefghijklmnopqrstuvwxyz123456"
      }),
      candidate({ quote: validQuote })
    ]), input(`${validQuote} ${supportingQuote}`));

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.statement).toBe("The user prefers concise replies.");
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 0,
      reasonCode: "REJECT_SECRET"
    }]);
  });
});
