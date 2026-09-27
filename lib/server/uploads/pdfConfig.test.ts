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
        AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS: "1234",
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
    "rejects invalid timeout %j without silently selecting a different deadline",
    (value) => {
      expect(() =>
        getPdfExtractionConfig({
          AIQSA_PDF_EXTRACTION_TIMEOUT_MS: value
        })
      ).toThrow("pdf_extraction_timeout_config_invalid");
    }
  );

  it("treats empty optional values as unset and accepts longer extraction", () => {
    expect(
      getPdfExtractionConfig({
        AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS: "",
        AIQSA_PDF_EXTRACTION_TIMEOUT_MS: "900000",
        AIQSA_PDF_MAX_PAGES: ""
      })
    ).toMatchObject({
      extractedTextMaxChars: DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
      maxPages: DEFAULT_PDF_MAX_PAGES,
      timeoutMs: 900_000
    });
  });

  it.each([
    String(DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS + 1), "0", "-1", "1.5", " 4", "1e2"
  ])("rejects extracted-text limit %j instead of silently applying the default", (value) => {
    expect(() => getPdfExtractionConfig({ AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS: value }))
      .toThrow(expect.objectContaining({
        code: "attachment_text_config_invalid",
        message: expect.stringContaining("AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS")
      }));
  });

  it.each([String(DEFAULT_PDF_MAX_PAGES + 1), "0", "1.5", "NaN"])(
    "rejects page limit %j instead of silently applying the default",
    (value) => {
      expect(() => getPdfExtractionConfig({ AIQSA_PDF_MAX_PAGES: value }))
        .toThrow(expect.objectContaining({ code: "pdf_page_limit_config_invalid" }));
    }
  );

  it("rejects a duration that would overflow the runtime timer", () => {
    expect(() => getPdfExtractionConfig({ AIQSA_PDF_EXTRACTION_TIMEOUT_MS: "2147483648" }))
      .toThrow("pdf_extraction_timeout_config_invalid");
  });
});
