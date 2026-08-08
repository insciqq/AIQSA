import { KNOWLEDGE_QUERY_MAX_CHARACTERS } from "./retrievalTypes";

export type KnowledgeQueryValidationResult =
  | Readonly<{ ok: true; query: string }>
  | Readonly<{
      code:
        | "knowledge_query_arguments_invalid"
        | "knowledge_query_required"
        | "knowledge_query_too_long";
      ok: false;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeControlCharacters(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Provider-generated arguments are untrusted. Knowledge accepts one bounded
 * query and rejects extra fields or oversized values before any DB/provider I/O. */
export function validateKnowledgeToolArguments(
  value: unknown,
  maxCharacters = KNOWLEDGE_QUERY_MAX_CHARACTERS
): KnowledgeQueryValidationResult {
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > 1_000 ||
    !isRecord(value)
  ) {
    return { code: "knowledge_query_arguments_invalid", ok: false };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "query" || typeof value.query !== "string") {
    return { code: "knowledge_query_arguments_invalid", ok: false };
  }
  if (value.query.length > maxCharacters) {
    return { code: "knowledge_query_too_long", ok: false };
  }
  const query = normalizeControlCharacters(value.query);
  if (!query) return { code: "knowledge_query_required", ok: false };
  return query.length <= maxCharacters
    ? { ok: true, query }
    : { code: "knowledge_query_too_long", ok: false };
}
