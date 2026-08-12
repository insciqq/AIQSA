import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "../../tools/types";
import {
  memoryProfileInputHash,
  type MemoryProfileInput
} from "./contract";
import { decodeMemoryProfile, MemoryProfileDecodeError } from "./decoder";
import { MEMORY_PROFILE_TOOL_NAME } from "./prompt";

function profileInput(text = "Я предпочитаю краткие ответы."): MemoryProfileInput {
  const value: Omit<MemoryProfileInput, "inputHash"> = {
    asOf: "2026-08-11T12:00:00.000Z",
    candidates: [{
      factId: "fact-1",
      factVersionContentHash: "1".repeat(64),
      factVersionId: "version-1",
      safetyIdentitySnapshot: "2".repeat(64),
      sourceIdentitySnapshot: "3".repeat(64),
      suppressionIdentitySnapshot: "4".repeat(64),
      temperatureClass: "HOT",
      temperatureScore: 0.9,
      text
    }],
    languageCode: /\p{Script=Cyrillic}/u.test(text) ? "ru" : "en",
    memoryGeneration: 1,
    memoryRevision: 2,
    redactionState: "NOT_NEEDED",
    safetyIdentitySnapshot: "5".repeat(64),
    scopeId: "scope-1",
    sourceIdentitySnapshot: "6".repeat(64),
    suppressionIdentitySnapshot: "7".repeat(64)
  };
  return { ...value, inputHash: memoryProfileInputHash(value) };
}

function calls(text: string, factVersionId = "version-1"): ModelToolCall[] {
  return [{
    arguments: { segments: [{ fact_version_id: factVersionId, text }] },
    id: "call-1",
    name: MEMORY_PROFILE_TOOL_NAME
  }];
}

describe("Memory profile decoder", () => {
  it.each([
    "Я предпочитаю краткие ответы.",
    "I prefer concise answers."
  ])("accepts exact grounded RU/EN text: %s", (text) => {
    const input = profileInput(text);
    expect(decodeMemoryProfile(calls(text), input)).toMatchObject({
      segments: [{ factVersionId: "version-1", text }]
    });
  });

  it("rejects paraphrases, translations, and unknown versions", () => {
    const input = profileInput();
    expect(() => decodeMemoryProfile(calls("Пользователь любит краткость."), input))
      .toThrowError(new MemoryProfileDecodeError("memory_profile_output_unsupported"));
    expect(() => decodeMemoryProfile(calls(input.candidates[0]!.text, "version-2"), input))
      .toThrowError(new MemoryProfileDecodeError("memory_profile_output_ungrounded"));
  });
});
