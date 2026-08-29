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

function accepts(exactText: string, value: number): void {
  expect(parse(exactText)).toEqual({
    normalizedText: expect.any(String),
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    status: "ACCEPTED",
    value
  });
}

function rejects(
  exactText: string,
  reason: MemoryCardinalityRejectionReason
): void {
  expect(parse(exactText)).toEqual({
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    reason,
    status: "REJECTED"
  });
}

describe("Memory source-bound cardinality parser", () => {
  it.each([
    ["3 visits", 3],
    ["3 визита", 3],
    ["three visits", 3],
    ["три визита", 3],
    ["twenty-one visits", 21],
    ["двадцать один визит", 21],
    ["one hundred and five inspections", 105],
    ["сто пять проверок", 105],
    ["1,000 visits", 1_000],
    ["1 000 визитов", 1_000],
    ["one million records", 1_000_000],
    ["один миллион записей", 1_000_000],
    ["pair of shoes", 2],
    ["a dozen eggs", 12]
  ])("parses exact English/Russian noun-count span %s", (text, value) => {
    accepts(text, value);
  });

  it.each([
    ["３ visitas", "es", 3],
    ["٣ visitas", "es-MX", 3],
    ["3 visitas", "es", 3],
    ["3 posete", "sr-Latn", 3],
    ["３ посете", "sr-Cyrl", 3]
  ])("normalizes digits independently of the surrounding language: %s", (
    text,
    languageTag,
    value
  ) => {
    expect(parse(text, languageTag)).toMatchObject({ status: "ACCEPTED", value });
  });

  it.each<[string, MemoryCardinalityRejectionReason]>([
    ["2026-08-29", "DATE_OR_TIME"],
    ["version 3", "IDENTIFIER"],
    ["модель 3", "IDENTIFIER"],
    ["3 per week", "RATE"],
    ["3 в неделю", "RATE"],
    ["for 3 weeks", "DURATION"],
    ["3 недели", "DURATION"],
    ["third visit", "ORDINAL"],
    ["третий визит", "ORDINAL"],
    ["2–4 visits", "RANGE"],
    ["about five visits", "VAGUE_QUANTIFIER"],
    ["около пяти визитов", "VAGUE_QUANTIFIER"],
    ["3.5 visits", "DECIMAL"],
    ["3,5 визита", "DECIMAL"],
    ["1/2 visit", "FRACTION"],
    ["3% visits", "PERCENTAGE"],
    ["3 dollars", "CURRENCY"],
    ["1. visit", "LIST_POSITION"],
    ["three visits and four calls", "CONFLICTING_CARDINALS"],
    ["3 visits and four calls", "CONFLICTING_CARDINALS"],
    ["0 visits", "OUT_OF_RANGE"],
    ["1000001 visits", "OUT_OF_RANGE"],
    ["-3 visits", "OUT_OF_RANGE"],
    ["three", "AMBIGUOUS_NOUN_COUNT_CONTEXT"],
    ["tres visitas", "UNSUPPORTED_NUMBER_WORD"],
    ["tri posete", "UNSUPPORTED_NUMBER_WORD"]
  ])("rejects unsafe or non-cardinal context %s", (text, reason) => {
    rejects(text, reason);
  });

  it.each([
    ["tres visitas", "es"],
    ["tri posete", "sr-Latn"],
    ["три посете", "sr-Cyrl"]
  ])("does not reinterpret unsupported-language word numbers: %s", (
    text,
    languageTag
  ) => {
    expect(parse(text, languageTag)).toMatchObject({
      reason: "UNSUPPORTED_NUMBER_WORD",
      status: "REJECTED"
    });
  });

  it("rejects unbounded input before running any grammar", () => {
    rejects(`${"9".repeat(300)} visits`, "INPUT_TOO_LONG");
  });

  it("is total and deterministic over punctuation/control-like fuzz corpus", () => {
    const alphabet = ["a", "я", "3", "٣", "-", ".", "/", "%", " ", "\n", "\t"];
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
