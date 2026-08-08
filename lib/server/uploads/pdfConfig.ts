import {
  ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS,
  PDF_PROCESSING_MAX_PAGES
} from "../../contracts/uploads";

export const DEFAULT_PDF_MAX_PAGES = PDF_PROCESSING_MAX_PAGES;
export const DEFAULT_PDF_EXTRACTION_TIMEOUT_MS = 20_000;
export const DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS = ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS;
export const DEFAULT_PDF_CHUNK_MAX_CHARS = 1_200;

export const PDF_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8
});

export type PdfWorkerResourceLimits = typeof PDF_WORKER_RESOURCE_LIMITS;

export type PdfExtractionConfig = {
  chunkMaxChars: number;
  extractedTextMaxChars: number;
  maxPages: number;
  timeoutMs: number;
  workerResourceLimits: PdfWorkerResourceLimits;
};

export type PdfExtractionEnvironment = Readonly<Record<string, string | undefined>>;

function reductionOnlyPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= fallback ? parsed : fallback;
}

export function getPdfExtractionConfig(env: PdfExtractionEnvironment = process.env): PdfExtractionConfig {
  return {
    chunkMaxChars: DEFAULT_PDF_CHUNK_MAX_CHARS,
    extractedTextMaxChars: reductionOnlyPositiveInteger(
      env.AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS,
      DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS
    ),
    maxPages: reductionOnlyPositiveInteger(env.AIQSA_PDF_MAX_PAGES, DEFAULT_PDF_MAX_PAGES),
    timeoutMs: reductionOnlyPositiveInteger(
      env.AIQSA_PDF_EXTRACTION_TIMEOUT_MS,
      DEFAULT_PDF_EXTRACTION_TIMEOUT_MS
    ),
    workerResourceLimits: PDF_WORKER_RESOURCE_LIMITS
  };
}
