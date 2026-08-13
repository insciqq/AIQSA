import { memoryExplicitStatementContainsSecret } from "../explicit/safety";

export const MEMORY_HISTORY_SAFETY_POLICY_VERSION = "memory-history-safety-v1";
export const MEMORY_HISTORY_REDACTION_MARKER = "⟦…⟧";

export const MEMORY_DERIVED_SAFETY_CLASSES = [
  "NORMAL",
  "SENSITIVE",
  "HIGHLY_SENSITIVE",
  "SECRET_TAINTED"
] as const;

export type MemoryDerivedSafetyClass =
  (typeof MEMORY_DERIVED_SAFETY_CLASSES)[number];

export type MemoryRedactionState = "EXCLUDED" | "NOT_NEEDED" | "REDACTED";

export type MemorySafeTextProjection = Readonly<
  | {
      eligible: false;
      providerSafeText: null;
      redactionReasonCodes: readonly string[];
      redactionState: "EXCLUDED";
      safetyClass: "HIGHLY_SENSITIVE" | "SECRET_TAINTED";
      safeText: null;
    }
  | {
      eligible: true;
      providerSafeText: string;
      redactionReasonCodes: readonly string[];
      redactionState: "NOT_NEEDED" | "REDACTED";
      safetyClass: "NORMAL" | "SENSITIVE";
      safeText: string;
    }
>;

const MAX_MEMORY_SOURCE_TEXT_CODE_UNITS = 100_000;
const unsafeControlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu;
const phoneCandidatePattern = /\+?\d(?:[\d ()\u00A0.-]{7,}\d)/gu;
const dateLikePattern = /(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/gu;

type RedactionRange = Readonly<{
  end: number;
  reasonCode: string;
  start: number;
}>;

function containsPlausibleDate(value: string): boolean {
  for (const match of value.matchAll(dateLikePattern)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const third = Number(match[3]);
    if (
      (match[1]?.length === 4 && second >= 1 && second <= 12 &&
        third >= 1 && third <= 31) ||
      (first >= 1 && first <= 31 && second >= 1 && second <= 12 &&
        (match[3]?.length === 2 || match[3]?.length === 4))
    ) {
      return true;
    }
  }
  return false;
}

function normalizedSourceText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function phoneRanges(value: string): RedactionRange[] {
  const ranges: RedactionRange[] = [];
  for (const match of value.matchAll(phoneCandidatePattern)) {
    const candidate = match[0];
    const digits = candidate.replace(/\D/gu, "");
    const separatorCount = [...candidate].filter((character) =>
      /[ ()\u00A0.-]/u.test(character)).length;
    if (
      match.index === undefined ||
      digits.length < 10 ||
      digits.length > 15 ||
      containsPlausibleDate(candidate) ||
      (!candidate.startsWith("+") && !candidate.includes("(") && separatorCount < 3)
    ) {
      continue;
    }
    ranges.push({
      end: match.index + candidate.length,
      reasonCode: "CONTACT_PHONE_REDACTED",
      start: match.index
    });
  }
  return ranges;
}

function emailRanges(value: string): RedactionRange[] {
  return [...value.matchAll(emailPattern)].flatMap((match) =>
    match.index === undefined
      ? []
      : [{
          end: match.index + match[0].length,
          reasonCode: "CONTACT_EMAIL_REDACTED",
          start: match.index
        }]);
}

function mergeRedactionRanges(ranges: readonly RedactionRange[]): RedactionRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.start - right.start || left.end - right.end ||
    left.reasonCode.localeCompare(right.reasonCode));
  const merged: RedactionRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      merged[merged.length - 1] = {
        end: Math.max(previous.end, range.end),
        reasonCode: [previous.reasonCode, range.reasonCode].sort().join("+"),
        start: previous.start
      };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

function redactRanges(value: string, ranges: readonly RedactionRange[]): string {
  if (ranges.length === 0) return value;
  let cursor = 0;
  let result = "";
  for (const range of ranges) {
    result += value.slice(cursor, range.start);
    result += MEMORY_HISTORY_REDACTION_MARKER;
    cursor = range.end;
  }
  return result + value.slice(cursor);
}

function redactionReasonCodes(ranges: readonly RedactionRange[]): readonly string[] {
  return [...new Set(ranges.flatMap((range) => range.reasonCode.split("+")))].sort();
}

export function projectMemoryHistorySafeText(value: string): MemorySafeTextProjection {
  const sourceText = normalizedSourceText(value);
  if (
    sourceText.length === 0 ||
    sourceText.length > MAX_MEMORY_SOURCE_TEXT_CODE_UNITS ||
    unsafeControlPattern.test(sourceText)
  ) {
    return {
      eligible: false,
      providerSafeText: null,
      redactionReasonCodes: [
        sourceText.length === 0
          ? "EMPTY_TEXT"
          : sourceText.length > MAX_MEMORY_SOURCE_TEXT_CODE_UNITS
            ? "SOURCE_TEXT_LIMIT"
            : "UNSAFE_CONTROL"
      ],
      redactionState: "EXCLUDED",
      safetyClass: "HIGHLY_SENSITIVE",
      safeText: null
    };
  }

  if (memoryExplicitStatementContainsSecret(sourceText)) {
    return {
      eligible: false,
      providerSafeText: null,
      redactionReasonCodes: ["SECRET_PATTERN"],
      redactionState: "EXCLUDED",
      safetyClass: "SECRET_TAINTED",
      safeText: null
    };
  }

  const ranges = mergeRedactionRanges([
    ...emailRanges(sourceText),
    ...phoneRanges(sourceText)
  ]);
  const safeText = redactRanges(sourceText, ranges);
  if (ranges.length > 0) {
    return {
      eligible: true,
      providerSafeText: safeText,
      redactionReasonCodes: redactionReasonCodes(ranges),
      redactionState: "REDACTED",
      safetyClass: "SENSITIVE",
      safeText
    };
  }

  return {
    eligible: true,
    providerSafeText: sourceText,
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safetyClass: "NORMAL",
    safeText: sourceText
  };
}
