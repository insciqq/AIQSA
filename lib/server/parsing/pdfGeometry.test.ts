import { describe, expect, it } from "vitest";
import type { ParsedDocument, ParsedDocumentBlock } from "./types";
import { enrichModelPdfGeometry } from "./pdfGeometry";

function block(text: string, index: number, boxes: ParsedDocumentBlock["boundingBoxes"] = []) {
  return {
    assetIds: [],
    boundingBoxes: boxes,
    headingPath: [],
    index,
    isTable: text.includes("\t"),
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type: text.includes("\t") ? "table" as const : "paragraph" as const
  };
}

function document(blocks: ParsedDocumentBlock[]): ParsedDocument {
  return {
    assets: [],
    attempts: [],
    blocks,
    engine: "system_model_direct_pdf",
    fieldGroups: [],
    languages: ["en"],
    mediaType: "application/pdf",
    pageCount: 1,
    quality: {
      characterCount: blocks.reduce((total, item) => total + item.text.length, 0),
      coveredPageCount: 1,
      duplicateFurnitureRatio: 0,
      emptyPageRatio: 0,
      encodingValid: true,
      headingCount: 0,
      ocrConfidence: null,
      pageCoverage: 1,
      tableCount: 1,
      usableBlockCount: blocks.length
    },
    status: "complete",
    text: blocks.map(({ text }) => text).join("\n"),
    warnings: [],
    workbook: null
  };
}

describe("model PDF geometry enrichment", () => {
  it("adds exact CPU-native row boxes without changing model text", () => {
    const model = document([block("Total cholesterol\t5.3 mmol/L", 0)]);
    const box = {
      bottom: 100,
      coordinateOrigin: "bottom_left" as const,
      left: 24,
      page: 1,
      right: 320,
      top: 116
    };
    const enriched = enrichModelPdfGeometry(model, {
      blocks: [block("Total cholesterol 5.3 mmol/L", 0, [box])],
      classification: "native_text",
      pageCount: 1
    });

    expect(enriched.blocks[0]?.text).toBe("Total cholesterol\t5.3 mmol/L");
    expect(enriched.blocks[0]?.boundingBoxes).toEqual([box]);
  });

  it("does not attach geometry for a merely similar numeric row", () => {
    const model = document([block("LDL cholesterol\t3.5 mmol/L", 0)]);
    const enriched = enrichModelPdfGeometry(model, {
      blocks: [block("HDL cholesterol 1.5 mmol/L", 0, [{
        bottom: 80,
        coordinateOrigin: "bottom_left",
        left: 24,
        page: 1,
        right: 300,
        top: 96
      }])],
      classification: "native_text",
      pageCount: 1
    });
    expect(enriched).toBe(model);
  });
});
