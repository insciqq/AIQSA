import { describe, expect, it } from "vitest";
import {
  finalizeParsedDocument,
  parsedDocumentNeedsFallback,
  parsedLanguageHints
} from "./assessment";
import type { ParsedDocumentBlock } from "./types";

function box(page: number, top: number, bottom: number) {
  return {
    bottom,
    coordinateOrigin: "top_left" as const,
    left: 20,
    page,
    right: 500,
    top
  };
}

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

  it("does not classify a two-page textual repeat as filtered furniture", () => {
    const document = finalizeParsedDocument({
      blocks: [1, 2].flatMap((page) => [
        block("Quarterly report", page, {
          boundingBoxes: [box(page, 0, 10)],
          index: page * 2,
          readingOrder: page * 2
        }),
        block(`Detailed results for page ${page}`, page, {
          boundingBoxes: [box(page, 20, 100)],
          index: page * 2 + 1,
          readingOrder: page * 2 + 1
        })
      ]),
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 2,
      status: "complete"
    });

    expect(document.quality.duplicateFurnitureRatio).toBe(0);
    expect(document.warnings).not.toContain("repeated_header_footer");
  });

  it("records only repeated furniture proven at a stable page edge", () => {
    const document = finalizeParsedDocument({
      blocks: [1, 2, 3].flatMap((page) => [
        block("Quarterly report", page, {
          boundingBoxes: [box(page, 0, 10)],
          index: page * 2,
          readingOrder: page * 2
        }),
        block(`Detailed results for page ${page}`, page, {
          boundingBoxes: [box(page, 20, 100)],
          index: page * 2 + 1,
          readingOrder: page * 2 + 1
        })
      ]),
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 3,
      status: "complete"
    });

    expect(document.quality.duplicateFurnitureRatio).toBeGreaterThan(0);
    expect(document.warnings).toContain("repeated_header_footer");
  });

  it("does not infer table degradation from an unstructured table-shaped block", () => {
    const document = finalizeParsedDocument({
      blocks: [block("Metric\tActual\nAlpha\t1.5", 1, {
        isTable: true,
        table: null,
        type: "table"
      })],
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 1,
      status: "complete"
    });

    expect(document.warnings).not.toContain("table_extraction_degraded");
  });

  it("preserves an explicit parser-proven table degradation warning", () => {
    const document = finalizeParsedDocument({
      blocks: [block("Flattened table text remains searchable")],
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 1,
      status: "complete",
      warnings: ["table_extraction_degraded"]
    });

    expect(document.warnings).toContain("table_extraction_degraded");
  });
});
