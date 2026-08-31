import { describe, expect, it } from "vitest";
import {
  MEMORY_CARDINALITY_PARSER_VERSION,
  parseMemoryCardinality,
  type MemoryCardinalityRejectionReason
} from "./cardinality";

function parse(exactText: string, languageTag = "und") {
  return parseMemoryCardinality({
    context: "EXACT_NOUN_COUNT",
    exactText,
    languageTag
  });
}

function accepts(exactText: string, value: number, languageTag = "und"): void {
  expect(parse(exactText, languageTag)).toEqual({
    normalizedText: expect.any(String),
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    status: "ACCEPTED",
    value
  });
}

function rejects(
  exactText: string,
  reason: MemoryCardinalityRejectionReason,
  languageTag = "und"
): void {
  expect(parse(exactText, languageTag)).toEqual({
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    reason,
    status: "REJECTED"
  });
}

describe("Memory source-bound language-neutral cardinality parser", () => {
  it.each([
    ["3 visits", "en", 3],
    ["3 визита", "ru", 3],
    ["３ visitas", "es", 3],
    ["٣ زيارات", "ar", 3],
    ["३ यात्राएँ", "hi", 3],
    ["৩ সফর", "bn", 3],
    ["3回", "ja", 3],
    ["𝟛 επισκέψεις", "el", 3],
    ["1,000 records", "en", 1_000],
    ["1 000 записей", "ru", 1_000]
  ])("normalizes Unicode decimal noun-count syntax %s", (
    text,
    languageTag,
    value
  ) => {
    accepts(text, value, languageTag);
  });

  it.each([
    ["three visits", "en"],
    ["три визита", "ru"],
    ["tres visitas", "es"],
    ["tri posete", "sr-Latn"],
    ["ثلاث زيارات", "ar"],
    ["तीन यात्राएँ", "hi"],
    ["三回", "ja"],
    ["pair of shoes", "en"]
  ])("rejects number words uniformly without a locale dictionary: %s", (
    text,
    languageTag
  ) => {
    rejects(text, "UNSUPPORTED_NUMBER_WORD", languageTag);
  });

  it.each<[string, MemoryCardinalityRejectionReason]>([
    ["2026-08-29", "DATE_OR_TIME"],
    ["version 3", "AMBIGUOUS_NOUN_COUNT_CONTEXT"],
    ["3 per week", "AMBIGUOUS_NOUN_COUNT_CONTEXT"],
    ["3 visits and four calls", "AMBIGUOUS_NOUN_COUNT_CONTEXT"],
    ["2–4 visits", "RANGE"],
    ["about 5 visits", "AMBIGUOUS_NOUN_COUNT_CONTEXT"],
    ["3.5 visits", "DECIMAL"],
    ["3,5 visits", "DECIMAL"],
    ["1/2 visit", "FRACTION"],
    ["3% visits", "PERCENTAGE"],
    ["$3", "CURRENCY"],
    ["1. visit", "LIST_POSITION"],
    ["3 visits and 4 calls", "CONFLICTING_CARDINALS"],
    ["3_visits", "IDENTIFIER"],
    ["0 visits", "OUT_OF_RANGE"],
    ["1000001 visits", "OUT_OF_RANGE"],
    ["-3 visits", "OUT_OF_RANGE"],
    ["3", "AMBIGUOUS_NOUN_COUNT_CONTEXT"],
    ["/", "RATE"]
  ])("rejects structurally unsafe or non-exact context %s", (text, reason) => {
    rejects(text, reason);
  });

  it("validates metadata structurally without routing on its language", () => {
    expect(parse("3 visits", "not_a_language")).toMatchObject({
      reason: "UNSUPPORTED_CONTEXT",
      status: "REJECTED"
    });
    for (const languageTag of ["en", "ru", "es", "sr-Cyrl", "zh-Hant", "und"]) {
      expect(parse("٣ visits", languageTag)).toMatchObject({ status: "ACCEPTED", value: 3 });
    }
  });

  it("rejects unbounded input before running any grammar", () => {
    rejects(`${"9".repeat(300)} visits`, "INPUT_TOO_LONG");
  });

  it("is total and deterministic over punctuation/control-like fuzz corpus", () => {
    const alphabet = ["a", "я", "क", "3", "٣", "-", ".", "/", "%", " ", "\n", "\t"];
    let state = 0x5eed;
    for (let sample = 0; sample < 500; sample += 1) {
      let text = "";
      const length = sample % 80;
      for (let index = 0; index < length; index += 1) {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        text += alphabet[state % alphabet.length];
      }
      const first = parse(text);
      expect(parse(text)).toEqual(first);
      expect(["ACCEPTED", "REJECTED"]).toContain(first.status);
    }
  });
});
