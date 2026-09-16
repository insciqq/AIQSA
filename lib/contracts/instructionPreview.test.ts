import { describe, expect, it } from "vitest";
import { decodeInstructionPreview } from "./instructionPreview";

const valid = {
  baseline: {
    renderedSystemPrompt: "You are helpful.",
    timeZone: "UTC",
    timeZoneSource: "utc_fallback"
  },
  generatedAt: "2026-06-07T12:34:00.000Z",
  visibleAnswerContract: "Answer directly."
};

describe("instruction preview contract", () => {
  it("accepts the minimal platform projection", () => {
    expect(decodeInstructionPreview(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, extra: true },
    { ...valid, baseline: { ...valid.baseline, extra: true } },
    { ...valid, baseline: { ...valid.baseline, timeZoneSource: "browser" } },
    { ...valid, baseline: { ...valid.baseline, renderedSystemPrompt: "" } },
    { ...valid, baseline: { ...valid.baseline, timeZone: "" } },
    { ...valid, visibleAnswerContract: "\0secret" },
    { ...valid, visibleAnswerContract: "" },
    { ...valid, visibleAnswerContract: "x".repeat(2_001) },
    { ...valid, generatedAt: undefined },
    { ...valid, generatedAt: "not-a-time" },
    { ...valid, generatedAt: "2026-02-30T12:34:00.000Z" }
  ])("rejects malformed or over-disclosing payloads", (value) => {
    expect(decodeInstructionPreview(value)).toBeNull();
  });
});
