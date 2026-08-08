import { MAX_UPLOAD_MAX_BYTES } from "../uploads/validation";

export const DEFAULT_KNOWLEDGE_MAX_FILE_BYTES = 25_000_000;
export const DEFAULT_KNOWLEDGE_MAX_PAGES = 2_000;
export const DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS = 5_000_000;
export const DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT = 10_000;

export const KNOWLEDGE_MAX_PAGES_CEILING = 10_000;
export const KNOWLEDGE_MAX_NORMALIZED_CHARS_CEILING = 8_000_000;
export const KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT_CEILING = 50_000;
export const KNOWLEDGE_NORMALIZED_OBJECT_MAX_BYTES_CEILING = 64 * 1_024 * 1_024;

export type KnowledgeExtractionConfig = Readonly<{
  maxChunksPerDocument: number;
  maxFileBytes: number;
  maxNormalizedChars: number;
  maxNormalizedObjectBytes: number;
  maxPages: number;
}>;

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  ceiling: number
): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling
    ? parsed
    : fallback;
}

export function getKnowledgeExtractionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): KnowledgeExtractionConfig {
  const maxFileBytes = boundedPositiveInteger(
    environment.AIQSA_KNOWLEDGE_MAX_FILE_BYTES,
    DEFAULT_KNOWLEDGE_MAX_FILE_BYTES,
    MAX_UPLOAD_MAX_BYTES
  );
  const maxPages = boundedPositiveInteger(
    environment.AIQSA_KNOWLEDGE_MAX_PAGES,
    DEFAULT_KNOWLEDGE_MAX_PAGES,
    KNOWLEDGE_MAX_PAGES_CEILING
  );
  const maxNormalizedChars = boundedPositiveInteger(
    environment.AIQSA_KNOWLEDGE_MAX_NORMALIZED_CHARS,
    DEFAULT_KNOWLEDGE_MAX_NORMALIZED_CHARS,
    KNOWLEDGE_MAX_NORMALIZED_CHARS_CEILING
  );
  const maxChunksPerDocument = boundedPositiveInteger(
    environment.AIQSA_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
    DEFAULT_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT,
    KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT_CEILING
  );
  const maxNormalizedObjectBytes = Math.min(
    KNOWLEDGE_NORMALIZED_OBJECT_MAX_BYTES_CEILING,
    maxNormalizedChars * 4 + 4 * 1_024 * 1_024
  );

  return Object.freeze({
    maxChunksPerDocument,
    maxFileBytes,
    maxNormalizedChars,
    maxNormalizedObjectBytes,
    maxPages
  });
}
