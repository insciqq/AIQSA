import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF_CHUNK_MAX_CHARS,
  DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
  DEFAULT_PDF_EXTRACTION_TIMEOUT_MS,
  DEFAULT_PDF_MAX_PAGES,
  getPdfExtractionConfig,
  PDF_WORKER_RESOURCE_LIMITS
} from "./pdfConfig";

describe("PDF extraction configuration", () => {
  it("uses the bounded product defaults", () => {
    expect(getPdfExtractionConfig({})).toEqual({
      chunkMaxChars: DEFAULT_PDF_CHUNK_MAX_CHARS,
      extractedTextMaxChars: DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
      maxPages: DEFAULT_PDF_MAX_PAGES,
      timeoutMs: DEFAULT_PDF_EXTRACTION_TIMEOUT_MS,
      workerResourceLimits: PDF_WORKER_RESOURCE_LIMITS
    });
  });

  it("accepts reduction-only positive integer overrides", () => {
    expect(
      getPdfExtractionConfig({
        AIQSA_PDF_EXTRACTED_TEXT_MAX_CHARS: "1234",
        AIQSA_PDF_EXTRACTION_TIMEOUT_MS: "5678",
        AIQSA_PDF_MAX_PAGES: "42"
      })
    ).toMatchObject({
      extractedTextMaxChars: 1234,
      maxPages: 42,
      timeoutMs: 5678
    });
  });

  it.each(["", "0", "-1", "1.5", " 4", "4 ", "1e2", "NaN", "Infinity"])(
    "falls back for invalid value %j",
    (value) => {
      expect(
        getPdfExtractionConfig({
          AIQSA_PDF_EXTRACTED_TEXT_MAX_CHARS: value,
          AIQSA_PDF_EXTRACTION_TIMEOUT_MS: value,
          AIQSA_PDF_MAX_PAGES: value
        })
      ).toMatchObject({
        extractedTextMaxChars: DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
        maxPages: DEFAULT_PDF_MAX_PAGES,
        timeoutMs: DEFAULT_PDF_EXTRACTION_TIMEOUT_MS
      });
    }
  );

  it("falls back when an override exceeds its hard ceiling", () => {
    expect(
      getPdfExtractionConfig({
        AIQSA_PDF_EXTRACTED_TEXT_MAX_CHARS: String(DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS + 1),
        AIQSA_PDF_EXTRACTION_TIMEOUT_MS: String(DEFAULT_PDF_EXTRACTION_TIMEOUT_MS + 1),
        AIQSA_PDF_MAX_PAGES: String(DEFAULT_PDF_MAX_PAGES + 1)
      })
    ).toMatchObject({
      extractedTextMaxChars: DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
      maxPages: DEFAULT_PDF_MAX_PAGES,
      timeoutMs: DEFAULT_PDF_EXTRACTION_TIMEOUT_MS
    });
  });
});
