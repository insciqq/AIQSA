import { createHash } from "node:crypto";

export const LONGMEMEVAL_PREPARED_CASE_CACHE_VERSION =
  "longmemeval-prepared-case-cache-v1";
export const LONGMEMEVAL_PREPARED_CASE_IMPORT_VERSION =
  "longmemeval-settled-history-import-v1";
export const LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX =
  "@prepared.longmemeval.benchmark.invalid";

type CanonicalValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalValue[]
  | Readonly<{ [key: string]: CanonicalValue }>;

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(
      value as Readonly<Record<string, unknown>>
    ).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [
      key,
      canonicalValue(item)
    ]))) as Readonly<{ [key: string]: CanonicalValue }>;
  }
  throw new Error("longmemeval_prepared_case_fingerprint_invalid");
}

export function longMemEvalPreparedCaseFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function assertFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("longmemeval_prepared_case_fingerprint_invalid");
  }
}

export function longMemEvalPreparedCaseReadyEmail(fingerprint: string): string {
  assertFingerprint(fingerprint);
  return `ready.${fingerprint.slice(0, 57)}${LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX}`;
}

export function longMemEvalPreparedCaseBuildingEmail(
  fingerprint: string,
  nonce: string
): string {
  assertFingerprint(fingerprint);
  if (!/^[a-f0-9-]{36}$/u.test(nonce)) {
    throw new Error("longmemeval_prepared_case_nonce_invalid");
  }
  return `building.${fingerprint.slice(0, 12)}.${nonce}` +
    LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX;
}

export function longMemEvalPreparedCaseDisplayName(
  questionId: string,
  fingerprint: string
): string {
  assertFingerprint(fingerprint);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(questionId)) {
    throw new Error("longmemeval_prepared_case_question_id_invalid");
  }
  return `LongMemEval prepared ${questionId} ${fingerprint}`;
}

export function longMemEvalPreparedCaseAdvisoryKey(
  fingerprint: string
): readonly [number, number] {
  assertFingerprint(fingerprint);
  const bytes = Buffer.from(fingerprint, "hex");
  return Object.freeze([bytes.readInt32BE(0), bytes.readInt32BE(4)]);
}
