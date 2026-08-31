import {
  addMemoryCalendar,
  canonicalMemoryTimeZone,
  memoryDaysInMonth,
  memoryZonedInstant
} from "../temporal/calendar";
import { normalizeUnicodeDecimalDigits } from "./unicodeDecimal";

export const MEMORY_TEMPORAL_QUERY_PARSER_VERSION =
  "memory-temporal-query-parser-v2";
export const MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS = 8;

export const MEMORY_TEMPORAL_QUERY_EXPRESSION_TYPES = [
  "EXPLICIT_DATE"
] as const;

export type MemoryTemporalQueryExpressionType =
  (typeof MEMORY_TEMPORAL_QUERY_EXPRESSION_TYPES)[number];
export type MemoryTemporalQueryConfidence = "HIGH";
export type MemoryTemporalQueryParserState =
  | "AMBIGUOUS"
  | "INVALID"
  | "MATCHED"
  | "NO_MATCH";

export type MemoryTemporalQueryInterval = Readonly<{
  from: Date | null;
  /** Exclusive upper bound. */
  to: Date | null;
}>;

export type MemoryTemporalQueryParseResult = Readonly<{
  confidence: MemoryTemporalQueryConfidence | null;
  expressionType: MemoryTemporalQueryExpressionType | null;
  interval: MemoryTemporalQueryInterval | null;
  matchedExpressionCount: number;
  parserVersion: string;
  state: MemoryTemporalQueryParserState;
}>;

type NumericDateCandidate = Readonly<{
  interval: MemoryTemporalQueryInterval;
}>;

const numericDatePattern =
  /(?<![\p{L}\p{N}_])(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})(?![\p{L}\p{N}_])/gu;
const numericDateHintPattern =
  /(?<![\p{L}\p{N}_])\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?![\p{L}\p{N}_])/gu;

function empty(
  state: Exclude<MemoryTemporalQueryParserState, "MATCHED">,
  matchedExpressionCount = 0
): MemoryTemporalQueryParseResult {
  return Object.freeze({
    confidence: null,
    expressionType: null,
    interval: null,
    matchedExpressionCount: Math.min(
      matchedExpressionCount,
      MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS
    ),
    parserVersion: MEMORY_TEMPORAL_QUERY_PARSER_VERSION,
    state
  });
}

function matched(
  candidate: NumericDateCandidate,
  matchedExpressionCount: number
): MemoryTemporalQueryParseResult {
  return Object.freeze({
    confidence: "HIGH" as const,
    expressionType: "EXPLICIT_DATE" as const,
    interval: Object.freeze(candidate.interval),
    matchedExpressionCount: Math.min(
      matchedExpressionCount,
      MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS
    ),
    parserVersion: MEMORY_TEMPORAL_QUERY_PARSER_VERSION,
    state: "MATCHED" as const
  });
}

function localDateInterval(
  year: number,
  month: number,
  day: number,
  timeZone: string
): MemoryTemporalQueryInterval {
  const from = memoryZonedInstant({
    day,
    hour: 0,
    minute: 0,
    month,
    second: 0,
    year
  }, timeZone);
  return { from, to: addMemoryCalendar(from, 1, "DAY", timeZone) };
}

function intervalKey(interval: MemoryTemporalQueryInterval): string {
  return `${interval.from?.getTime() ?? "open"}:${interval.to?.getTime() ?? "open"}`;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  return Number.isSafeInteger(year) && year >= 1 && year <= 9999 &&
    Number.isSafeInteger(month) && month >= 1 && month <= 12 &&
    Number.isSafeInteger(day) && day >= 1 &&
    day <= memoryDaysInMonth(year, month);
}

function parseNumericDate(
  match: RegExpMatchArray,
  timeZone: string
): NumericDateCandidate | "AMBIGUOUS" | "INVALID" {
  const firstText = match[1]!;
  const separator = match[2]!;
  const secondText = match[3]!;
  const thirdText = match[4]!;
  const first = Number(firstText);
  const second = Number(secondText);
  const third = Number(thirdText);

  if (separator === "-" && firstText.length === 4 &&
    secondText.length === 2 && thirdText.length === 2) {
    if (!validCalendarDate(first, second, third)) return "INVALID";
    return { interval: localDateInterval(first, second, third, timeZone) };
  }
  if (thirdText.length !== 4 || firstText.length > 2 || secondText.length > 2) {
    return "INVALID";
  }
  if (first < 1 || second < 1 || third < 1 || third > 9999) return "INVALID";
  if (first <= 12 && second <= 12) return "AMBIGUOUS";
  const day = first > 12 ? first : second;
  const month = first > 12 ? second : first;
  if (!validCalendarDate(third, month, day)) return "INVALID";
  return { interval: localDateInterval(third, month, day, timeZone) };
}

/**
 * Parses only deterministic ISO or unambiguous numeric calendar dates. Natural
 * language temporal meaning belongs to structured control fields; unsupported
 * text remains unfiltered so every script receives the same fail-open path.
 */
export function parseMemoryTemporalQuery(input: Readonly<{
  now: Date;
  query: string;
  timeZone: string;
}>): MemoryTemporalQueryParseResult {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
    typeof input.query !== "string" || Array.from(input.query).length > 2_000) {
    return empty("INVALID");
  }
  const query = normalizeUnicodeDecimalDigits(input.query);
  const timeZone = canonicalMemoryTimeZone(input.timeZone);
  if (query === null || Array.from(query).length > 2_000 || !timeZone) {
    return empty("INVALID");
  }

  try {
    const matches = Array.from(query.matchAll(numericDatePattern));
    const hints = Array.from(query.matchAll(numericDateHintPattern));
    let syntaxRemainder = query;
    for (const dateHint of [...hints].reverse()) {
      const start = dateHint.index ?? 0;
      syntaxRemainder = `${syntaxRemainder.slice(0, start)}${" ".repeat(
        dateHint[0].length
      )}${syntaxRemainder.slice(start + dateHint[0].length)}`;
    }
    if (hints.length > 0 && /[\p{L}\p{N}_]/u.test(syntaxRemainder)) {
      return empty("NO_MATCH");
    }
    if (matches.length === 0) {
      return hints.length > 0 ? empty("INVALID", hints.length) : empty("NO_MATCH");
    }
    if (hints.length !== matches.length || hints.some((hint, index) =>
      hint.index !== matches[index]?.index || hint[0] !== matches[index]?.[0])) {
      return empty("INVALID", hints.length);
    }
    const candidates: NumericDateCandidate[] = [];
    let ambiguous = false;
    for (const dateMatch of matches) {
      const parsed = parseNumericDate(dateMatch, timeZone);
      if (parsed === "INVALID") return empty("INVALID", matches.length);
      if (parsed === "AMBIGUOUS") {
        ambiguous = true;
      } else {
        candidates.push(parsed);
      }
    }
    if (ambiguous) return empty("AMBIGUOUS", matches.length);
    const distinctIntervals = new Set(candidates.map(({ interval }) =>
      intervalKey(interval)));
    if (distinctIntervals.size !== 1) return empty("AMBIGUOUS", matches.length);
    return matched(candidates[0]!, matches.length);
  } catch {
    return empty("INVALID");
  }
}
