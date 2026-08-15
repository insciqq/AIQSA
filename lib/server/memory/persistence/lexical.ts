import { createHash } from "node:crypto";

export const MEMORY_LEXICAL_LANGUAGE_PROFILE = "UNICODE_SIMPLE_V3";
export const MEMORY_LEXICAL_NORMALIZATION_VERSION = "memory-search-normalization-v3";
export const MEMORY_LEXICAL_CHUNKING_VERSION = "memory-no-chunking-v1";
export const MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION = "memory-retrieval-v2";

function canonicalJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)])
    );
  }
  return value;
}

export function memoryStableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export function memorySha256(value: unknown): string {
  const payload = typeof value === "string" ? value : memoryStableJson(value);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function normalizeMemorySearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е")
    .trim()
    .replace(/\s+/gu, " ");
}
