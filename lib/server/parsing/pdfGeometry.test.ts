import { describe, expect, it } from "vitest";
import type { ParsedDocument, ParsedDocumentBlock } from "./types";
import type { NativePdfGeometry, NativePdfPageMetrics } from "./nativePdf";
import {
  enrichModelPdfGeometry,
  mergeModelPdfWithNativeText,
  MODEL_PDF_NATIVE_TEXT_COLLABORATION_PROFILE_VERSION,
  MODEL_PDF_NATIVE_TEXT_CORRECTION_PROFILE_VERSION
} from "./pdfGeometry";

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

function geometryBlock(
  text: string,
  index: number,
  input: Readonly<{ bottom?: number; top?: number }> = {}
): ParsedDocumentBlock {
  const bottom = input.bottom ?? 700 - index * 40;
  const top = input.top ?? bottom + 18;
  return block(text, index, [{
    bottom,
    coordinateOrigin: "bottom_left",
    left: 24,
    page: 1,
    right: 420,
    top
  }]);
}

function geometry(
  blocks: readonly ParsedDocumentBlock[],
  input: Readonly<{
    invisibleText?: boolean;
    invalidCharacterCount?: number;
    visualGroupOverflow?: boolean;
  }> = {}
): NativePdfGeometry {
  const page: NativePdfPageMetrics = {
    characterCount: blocks.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    invalidCharacterCount: input.invalidCharacterCount ?? 0,
    invisibleText: input.invisibleText ?? false,
    maxVisualGroupCount: 1,
    multiGroupRowCount: 0,
    page: 1,
    rowCount: blocks.length,
    shortRowCount: 0
  };
  return {
    blocks,
    classification: "native_text",
    pageCount: 1,
    quality: {
      pages: [page],
      visualGroupOverflow: input.visualGroupOverflow ?? false
    }
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
      pageCount: 1,
      quality: { pages: [], visualGroupOverflow: false }
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
      pageCount: 1,
      quality: { pages: [], visualGroupOverflow: false }
    });
    expect(enriched).toBe(model);
  });

  it("version-controls the native-text collaboration profile", () => {
    expect(MODEL_PDF_NATIVE_TEXT_COLLABORATION_PROFILE_VERSION).toBe(10);
    expect(MODEL_PDF_NATIVE_TEXT_CORRECTION_PROFILE_VERSION).toBe(11);
  });

  it("fills a Vision omission with one visible native row in source order", () => {
    const model = document([
      block("Visible heading", 0),
      block("Recorded result 42", 1)
    ]);
    const sourceGeometry = geometry([
      geometryBlock("Visible heading", 0),
      geometryBlock("Signed on 12.05.2024", 1),
      geometryBlock("Recorded result 42", 2)
    ]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result).toMatchObject({ addedBlockCount: 1, outcome: "augmented" });
    expect(result.document.blocks.map(({ text }) => text)).toEqual([
      "Visible heading",
      "Signed on 12.05.2024",
      "Recorded result 42"
    ]);
    expect(result.document.blocks[1]?.boundingBoxes).toEqual(
      sourceGeometry.blocks[1]?.boundingBoxes
    );
    expect(result.document.blocks.map(({ index, readingOrder }) => [index, readingOrder]))
      .toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(result.document.attempts).toContainEqual({
      engine: "native_pdf",
      errorCode: null,
      outcome: "complete"
    });
  });

  it("attaches coordinates without duplicating text already emitted by Vision", () => {
    const model = document([block("Exact native sentence 17", 0)]);
    const sourceGeometry = geometry([geometryBlock("Exact native sentence 17", 0)]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result).toMatchObject({ addedBlockCount: 0, outcome: "unchanged" });
    expect(result.document.blocks).toHaveLength(1);
    expect(result.document.blocks[0]?.boundingBoxes).toEqual(
      sourceGeometry.blocks[0]?.boundingBoxes
    );
    expect(result.document.attempts).toEqual([]);
  });

  it.each([
    ["invisible text", { invisibleText: true }],
    ["invalid native text", { invalidCharacterCount: 1 }],
    ["geometry overflow", { visualGroupOverflow: true }]
  ])("does not admit unmatched %s", (_label, quality) => {
    const model = document([block("Visible model sentence", 0)]);
    const sourceGeometry = geometry([
      geometryBlock("Visible model sentence", 0),
      geometryBlock("Native-only private value 90210", 1)
    ], quality);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result.addedBlockCount).toBe(0);
    expect(result.document.blocks.map(({ text }) => text)).toEqual(["Visible model sentence"]);
  });

  it("does not publish an unmatched row over the same physical region", () => {
    const exact = geometryBlock("Model value 42", 0, { bottom: 640, top: 660 });
    const conflict = geometryBlock("Model value 43", 1, { bottom: 640, top: 660 });
    const model = document([block("Model value 42", 0)]);

    const result = mergeModelPdfWithNativeText(model, geometry([exact, conflict]), {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result.addedBlockCount).toBe(0);
    expect(result.document.blocks.map(({ text }) => text)).toEqual(["Model value 42"]);
  });

  it("fails closed on an unlocated same-field numeric conflict", () => {
    const model = document([block("Total amount 41", 0)]);
    const sourceGeometry = geometry([geometryBlock("Total amount 42", 0)]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result.addedBlockCount).toBe(0);
    expect(result.document.blocks.map(({ text }) => text)).toEqual(["Total amount 41"]);
  });

  it("uses one clean uniquely aligned native row to correct Vision numeric tokens", () => {
    const model = document([
      block("Account owner Alex Rivera, identifier 1234567", 0)
    ]);
    const sourceGeometry = geometry([
      geometryBlock("Account owner Alex Rivera, identifier 12345678", 0)
    ]);

    const legacy = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });
    const corrected = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: true,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(legacy).toMatchObject({
      addedBlockCount: 0,
      correctedBlockCount: 0,
      outcome: "unchanged"
    });
    expect(legacy.document.blocks[0]?.text).toContain("1234567");
    expect(corrected).toMatchObject({
      addedBlockCount: 0,
      correctedBlockCount: 1,
      outcome: "augmented"
    });
    expect(corrected.document.blocks.map(({ text }) => text)).toEqual([
      "Account owner Alex Rivera, identifier 12345678"
    ]);
    expect(corrected.document.blocks[0]?.boundingBoxes).toEqual(
      sourceGeometry.blocks[0]?.boundingBoxes
    );
    expect(corrected.document.text).toBe(
      "Account owner Alex Rivera, identifier 12345678"
    );
    expect(corrected.document.attempts).toContainEqual({
      engine: "native_pdf",
      errorCode: null,
      outcome: "complete"
    });
  });

  it("does not correct an ambiguous repeated numeric field", () => {
    const model = document([
      block("Account owner Alex Rivera, identifier 1234567", 0),
      block("Account owner Alex Rivera, identifier 7654321", 1)
    ]);
    const sourceGeometry = geometry([
      geometryBlock("Account owner Alex Rivera, identifier 12345678", 0)
    ]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: true,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result.correctedBlockCount).toBe(0);
    expect(result.document.blocks.map(({ text }) => text)).toEqual([
      "Account owner Alex Rivera, identifier 1234567",
      "Account owner Alex Rivera, identifier 7654321"
    ]);
  });

  it.each([
    ["invisible text", { invisibleText: true }],
    ["invalid native text", { invalidCharacterCount: 1 }],
    ["geometry overflow", { visualGroupOverflow: true }]
  ])("does not use %s to correct Vision text", (_label, quality) => {
    const model = document([
      block("Account owner Alex Rivera, identifier 1234567", 0)
    ]);
    const sourceGeometry = geometry([
      geometryBlock("Account owner Alex Rivera, identifier 12345678", 0)
    ], quality);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: true,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result.correctedBlockCount).toBe(0);
    expect(result.document.blocks.map(({ text }) => text)).toEqual([
      "Account owner Alex Rivera, identifier 1234567"
    ]);
  });

  it("does not rewrite model table structure as a numeric correction", () => {
    const model = document([block("Account owner\t1234567", 0)]);
    const sourceGeometry = geometry([
      geometryBlock("Account owner 12345678", 0)
    ]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: true,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result.correctedBlockCount).toBe(0);
    expect(result.document.blocks.map(({ text }) => text)).toEqual([
      "Account owner\t1234567"
    ]);
  });

  it("rejects a correction rather than overflowing the character bound", () => {
    const model = document([
      block("Account owner Alex Rivera, identifier 1234567", 0)
    ]);
    const sourceGeometry = geometry([
      geometryBlock("Account owner Alex Rivera, identifier 12345678", 0)
    ]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: true,
      maxBlocks: 10,
      maxCharacters: model.quality.characterCount
    });

    expect(result).toMatchObject({
      addedBlockCount: 0,
      correctedBlockCount: 0,
      outcome: "rejected"
    });
    expect(result.document.blocks[0]?.text).toContain("1234567");
  });

  it("rejects the whole supplement instead of truncating it at parser bounds", () => {
    const model = document([block("Anchor sentence", 0)]);
    const sourceGeometry = geometry([
      geometryBlock("Anchor sentence", 0),
      geometryBlock("First omitted row 100", 1),
      geometryBlock("Second omitted row 200", 2)
    ]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 2,
      maxCharacters: 10_000
    });

    expect(result).toMatchObject({ addedBlockCount: 0, outcome: "rejected" });
    expect(result.document.blocks.map(({ text }) => text)).toEqual(["Anchor sentence"]);
  });

  it("does not overflow the normalized parser-attempt provenance bound", () => {
    const base = document([block("Anchor sentence", 0)]);
    const model: ParsedDocument = {
      ...base,
      attempts: ["docling", "tika", "inline", "system_model_vision"].map((engine) => ({
        engine: engine as ParsedDocument["engine"],
        errorCode: null,
        outcome: "complete" as const
      }))
    };
    const sourceGeometry = geometry([
      geometryBlock("Anchor sentence", 0),
      geometryBlock("Omitted visible row 300", 1)
    ]);

    const result = mergeModelPdfWithNativeText(model, sourceGeometry, {
      allowTextCorrections: false,
      maxBlocks: 10,
      maxCharacters: 10_000
    });

    expect(result).toMatchObject({ addedBlockCount: 0, outcome: "rejected" });
    expect(result.document.attempts).toHaveLength(4);
  });
});
