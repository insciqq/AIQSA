import type { ValidatedSearchQuery } from "../../domain/search";

export const DEFAULT_SEARCH_QUERY_MAX_CHARACTERS = 500;

export type SearchQueryValidationResult =
  | Readonly<{ ok: true; query: ValidatedSearchQuery }>
  | Readonly<{
      code:
        | "search_query_arguments_invalid"
        | "search_query_required"
        | "search_query_too_long";
      ok: false;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMaxCharacters(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000;
}

function normalizeControlCharacters(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Tool arguments are provider-generated, untrusted input. Search accepts one
 * exact field and rejects rather than truncates input outside the reviewed
 * integration limit.
 */
export function validateSearchToolArguments(
  value: unknown,
  maxCharacters = DEFAULT_SEARCH_QUERY_MAX_CHARACTERS
): SearchQueryValidationResult {
  if (!validMaxCharacters(maxCharacters) || !isRecord(value)) {
    return { code: "search_query_arguments_invalid", ok: false };
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "query" || typeof value.query !== "string") {
    return { code: "search_query_arguments_invalid", ok: false };
  }

  if (value.query.length > maxCharacters) {
    return { code: "search_query_too_long", ok: false };
  }

  const query = normalizeControlCharacters(value.query);
  if (!query) {
    return { code: "search_query_required", ok: false };
  }
  if (query.length > maxCharacters) {
    return { code: "search_query_too_long", ok: false };
  }

  return { ok: true, query: query as ValidatedSearchQuery };
}
