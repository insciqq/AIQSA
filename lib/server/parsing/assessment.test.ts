import { describe, expect, it } from "vitest";
import {
  finalizeParsedDocument,
  parsedDocumentNeedsFallback,
  parsedLanguageHints
} from "./assessment";
import type { ParsedDocumentBlock } from "./types";

function block(
  text: string,
  page = 1,
  overrides: Partial<ParsedDocumentBlock> = {}
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: [],
    index: page - 1,
    isTable: false,
    languageHints: [],
    page,
    pageEnd: page,
    readingOrder: page - 1,
    table: null,
    text,
    type: "paragraph",
    ...overrides
  };
}

describe("parsed document assessment", () => {
  it("keeps a valid short single-page source ready without a noisy density warning", () => {
    const document = finalizeParsedDocument({
      blocks: [block("hello world")],
      engine: "inline",
      mediaType: "text/plain",
      pageCount: 1,
      status: "complete"
    });

    expect(document.warnings).toEqual([]);
    expect(parsedDocumentNeedsFallback(document)).toBe(false);
  });

  it("turns partial coverage and OCR evidence into bounded canonical warnings", () => {
    const document = finalizeParsedDocument({
      blocks: [block("Readable page content")],
      engine: "docling",
      mediaType: "application/pdf",
      ocrConfidence: 0.4,
      pageCount: 3,
      status: "partial"
    });

    expect(document.warnings).toEqual([
      "partial_parse",
      "unreadable_pages",
      "low_page_coverage",
      "low_ocr_confidence"
    ]);
    expect(parsedDocumentNeedsFallback(document)).toBe(true);
  });

  it("derives deterministic script hints without exposing detected prose", () => {
    expect(parsedLanguageHints("Русский text 2026")).toEqual(["und-Cyrl", "und-Latn"]);
    expect(parsedLanguageHints("1234")).toEqual([]);
  });
});
