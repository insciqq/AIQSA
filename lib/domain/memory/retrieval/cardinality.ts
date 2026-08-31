import { normalizeUnicodeDecimalDigits } from "./unicodeDecimal";

export const MEMORY_CARDINALITY_PARSER_VERSION =
  "memory-cardinality-parser-v2";

export const MEMORY_CARDINALITY_REJECTION_REASONS = [
  "AMBIGUOUS_NOUN_COUNT_CONTEXT",
  "CONFLICTING_CARDINALS",
  "CURRENCY",
  "DATE_OR_TIME",
  "DECIMAL",
  "DURATION",
  "EMPTY",
  "FRACTION",
  "IDENTIFIER",
  "INPUT_TOO_LONG",
  "INVALID_CARDINAL_SYNTAX",
  "INVALID_INPUT",
  "LIST_POSITION",
  "NO_CARDINAL",
  "ORDINAL",
  "OUT_OF_RANGE",
  "PERCENTAGE",
  "RANGE",
  "RATE",
  "UNSUPPORTED_CONTEXT",
  "UNSUPPORTED_NUMBER_WORD",
  "VAGUE_QUANTIFIER"
] as const;

export type MemoryCardinalityRejectionReason =
  (typeof MEMORY_CARDINALITY_REJECTION_REASONS)[number];

export type MemoryCardinalityParserInput = Readonly<{
  context: "EXACT_NOUN_COUNT";
  exactText: string;
  languageTag: string;
}>;

export type MemoryCardinalityParseResult =
  | Readonly<{
      normalizedText: string;
      parserVersion: typeof MEMORY_CARDINALITY_PARSER_VERSION;
      status: "ACCEPTED";
      value: number;
    }>
  | Readonly<{
      parserVersion: typeof MEMORY_CARDINALITY_PARSER_VERSION;
      reason: MemoryCardinalityRejectionReason;
      status: "REJECTED";
    }>;

const MAX_CARDINALITY_INPUT_CHARACTERS = 256;
const MAX_CARDINALITY = 1_000_000;
const languageCodePattern =
  /^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|mixed)$/u;
const numericCandidatePattern = /(?<!\d)(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?!\d)/gu;
const singleNounPattern =
  /^[\p{Zs}\s]*[\p{L}\p{M}\u200c\u200d]+(?:['’‐‑-][\p{L}\p{M}\u200c\u200d]+)*[\p{Zs}\s]*$/u;

type CardinalCandidate = Readonly<{
  end: number;
  start: number;
  value: number;
}>;

function rejected(reason: MemoryCardinalityRejectionReason): MemoryCardinalityParseResult {
  return Object.freeze({
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    reason,
    status: "REJECTED" as const
  });
}

function normalizeCardinalityText(value: string): string | null {
  return normalizeUnicodeDecimalDigits(value)?.replace(/[\p{Zs}\s]+/gu, " ").trim() ??
    null;
}

function digitCandidates(value: string): readonly CardinalCandidate[] {
  return Object.freeze(Array.from(value.matchAll(numericCandidatePattern), (match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
    value: Number.parseInt(match[0].replace(/[ ,]/gu, ""), 10)
  })));
}

function hasDecimal(value: string): boolean {
  for (const match of value.matchAll(/\d+[.,]\d+/gu)) {
    if (match[0].includes(",") && /^\d{1,3}(?:,\d{3})+$/u.test(match[0])) continue;
    return true;
  }
  return false;
}

function rejectionFromStructure(
  value: string
): MemoryCardinalityRejectionReason | null {
  if (/(?<!\d)\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)|(?<!\d)\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/gu.test(value)) {
    return "DATE_OR_TIME";
  }
  if (/(?<!\d)\d+\s*(?:-|–|—|…|\.\.)\s*\d+(?!\d)/gu.test(value)) {
    return "RANGE";
  }
  if (hasDecimal(value)) return "DECIMAL";
  if (/(?<!\d)\d+\s*[\/⁄]\s*\d+(?!\d)|[¼-¾⅐-⅟]/gu.test(value)) {
    return "FRACTION";
  }
  if (/[%٪‰‱]/u.test(value)) return "PERCENTAGE";
  if (/^\s*\d+\s*[.)](?:\s|$)/u.test(value)) return "LIST_POSITION";
  if (/\p{Sc}/u.test(value)) return "CURRENCY";
  if (/[\/⁄]/u.test(value)) return "RATE";
  if (/(?:^|\s)[−-]\s*\d+/u.test(value)) return "OUT_OF_RANGE";
  if (/_/u.test(value)) return "IDENTIFIER";
  return null;
}

/**
 * Parses only a caller-attested exact noun-count span. Numeric syntax is
 * derived from source-bound Unicode decimal digits. Number words are rejected
 * uniformly because no broadly qualified data-driven locale provider exists.
 */
export function parseMemoryCardinality(
  input: MemoryCardinalityParserInput
): MemoryCardinalityParseResult {
  if (input.context !== "EXACT_NOUN_COUNT") return rejected("UNSUPPORTED_CONTEXT");
  if (typeof input.languageTag !== "string" || input.languageTag.length > 35 ||
    !languageCodePattern.test(input.languageTag)) {
    return rejected("UNSUPPORTED_CONTEXT");
  }
  if (typeof input.exactText !== "string" || input.exactText.includes("\u0000")) {
    return rejected("INVALID_INPUT");
  }
  if (Array.from(input.exactText).length > MAX_CARDINALITY_INPUT_CHARACTERS) {
    return rejected("INPUT_TOO_LONG");
  }
  const normalizedText = normalizeCardinalityText(input.exactText);
  if (normalizedText === null) return rejected("INVALID_INPUT");
  if (Array.from(normalizedText).length > MAX_CARDINALITY_INPUT_CHARACTERS) {
    return rejected("INPUT_TOO_LONG");
  }
  if (!normalizedText) return rejected("EMPTY");

  const structuralRejection = rejectionFromStructure(normalizedText);
  if (structuralRejection) return rejected(structuralRejection);
  const candidates = digitCandidates(normalizedText);
  if (candidates.length > 1) return rejected("CONFLICTING_CARDINALS");
  if (candidates.length === 0) {
    return /\p{L}/u.test(normalizedText)
      ? rejected("UNSUPPORTED_NUMBER_WORD")
      : rejected("NO_CARDINAL");
  }

  const candidate = candidates[0]!;
  if (!Number.isSafeInteger(candidate.value) || candidate.value < 1 ||
    candidate.value > MAX_CARDINALITY) {
    return rejected("OUT_OF_RANGE");
  }
  const noun = normalizedText.slice(candidate.end);
  if (candidate.start !== 0 || !/\p{L}/u.test(noun) ||
    !singleNounPattern.test(noun)) {
    return rejected("AMBIGUOUS_NOUN_COUNT_CONTEXT");
  }
  return Object.freeze({
    normalizedText,
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    status: "ACCEPTED" as const,
    value: candidate.value
  });
}
