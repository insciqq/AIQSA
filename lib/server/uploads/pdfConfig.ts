import {
  ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS,
  PDF_PROCESSING_MAX_PAGES
} from "../../contracts/uploads";
import { getAttachmentTextConfig } from "./attachmentTextConfig";

export const DEFAULT_PDF_MAX_PAGES = PDF_PROCESSING_MAX_PAGES;
export const DEFAULT_PDF_EXTRACTION_TIMEOUT_MS = 300_000;
// Node timers overflow above this platform limit and would fire immediately.
export const MAX_PDF_EXTRACTION_TIMEOUT_MS = 2_147_483_647;
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

export function pdfExtractionTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PDF_EXTRACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PDF_EXTRACTION_TIMEOUT_MS) {
    throw Object.assign(new Error("pdf_extraction_timeout_config_invalid"), { code: "pdf_extraction_timeout_config_invalid" });
  }
  return value;
}

function configuredTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PDF_EXTRACTION_TIMEOUT_MS;
  if (!/^\d+$/u.test(value)) throw Object.assign(new Error("pdf_extraction_timeout_config_invalid"), { code: "pdf_extraction_timeout_config_invalid" });
  return pdfExtractionTimeoutMs(Number(value));
}

/** Reduction-only page bound: a malformed or larger value is rejected, never
 * silently replaced; Compose forwards an unset optional value as "". */
function configuredMaxPages(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PDF_MAX_PAGES;
  const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > DEFAULT_PDF_MAX_PAGES) {
    throw Object.assign(
      new Error(`pdf_page_limit_config_invalid: AIQSA_PDF_MAX_PAGES must be an integer from 1 to ${DEFAULT_PDF_MAX_PAGES}`),
      { code: "pdf_page_limit_config_invalid", setting: "AIQSA_PDF_MAX_PAGES" }
    );
  }
  return parsed;
}

export function getPdfExtractionConfig(env: PdfExtractionEnvironment = process.env): PdfExtractionConfig {
  return {
    chunkMaxChars: DEFAULT_PDF_CHUNK_MAX_CHARS,
    extractedTextMaxChars: getAttachmentTextConfig(env).extractedTextMaxChars,
    maxPages: configuredMaxPages(env.AIQSA_PDF_MAX_PAGES),
    timeoutMs: configuredTimeout(env.AIQSA_PDF_EXTRACTION_TIMEOUT_MS),
    workerResourceLimits: PDF_WORKER_RESOURCE_LIMITS
  };
}
