import { boundedMemoryRecallRoundEvidenceText } from "./rounds";

export type MemoryUserTestimonySpan = Readonly<{
  end: number;
  ordinal: number;
  start: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Projects exact user-authored fragments from an authoritative round segment.
 * Offsets are UTF-16 indices emitted by the TypeScript history projector, so
 * slicing remains in JavaScript instead of PostgreSQL's code-point indexing.
 */
export function memoryUserTestimonyText(
  rawSafeText: string,
  value: unknown
): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
    typeof rawSafeText !== "string") return null;
  const spans = value.flatMap((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).sort().join("\u0000") !==
      "end\u0000ordinal\u0000start" ||
      !Number.isSafeInteger(candidate.ordinal) || (candidate.ordinal as number) < 0 ||
      !Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end) ||
      (candidate.start as number) < 0 ||
      (candidate.end as number) <= (candidate.start as number) ||
      (candidate.end as number) > rawSafeText.length) return [];
    return [{
      end: candidate.end as number,
      ordinal: candidate.ordinal as number,
      start: candidate.start as number
    }];
  });
  if (spans.length !== value.length ||
    new Set(spans.map(({ ordinal }) => ordinal)).size !== spans.length ||
    spans.some((span, index) => index > 0 && (
      span.ordinal <= spans[index - 1]!.ordinal ||
      span.start < spans[index - 1]!.end
    ))) return null;
  const fragments = spans.map(({ end, start }) => rawSafeText.slice(start, end).trim());
  if (fragments.some((fragment) => !fragment)) return null;
  return boundedMemoryRecallRoundEvidenceText(
    fragments.map((fragment) => `User: ${fragment}`).join("\n\n")
  );
}
