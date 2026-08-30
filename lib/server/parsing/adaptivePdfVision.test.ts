import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import {
  ADAPTIVE_PDF_MAX_CROP_BYTES,
  adaptivePdfVisionPrompt,
  prepareAdaptivePdfVisionSupplement
} from "./adaptivePdfVision";
import type { NativePdfGeometry } from "./nativePdf";
import type { ParsedDocumentBlock, ParsedTable } from "./types";

const table = Object.freeze({
  cells: Object.freeze([
    Object.freeze({ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "Metric" }),
    Object.freeze({ column: 1, columnSpan: 1, row: 0, rowSpan: 1, text: "1,234" })
  ]),
  columnCount: 2,
  rowCount: 1
}) satisfies ParsedTable;

function block(input: Readonly<{
  boxes?: ParsedDocumentBlock["boundingBoxes"];
  table?: ParsedTable | null;
  text?: string;
}> = {}): ParsedDocumentBlock {
  const text = input.text ?? "Metric\t1,234";
  const valueTable = input.table === undefined ? table : input.table;
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: input.boxes ?? Object.freeze([{
      bottom: 380,
      coordinateOrigin: "bottom_left" as const,
      left: 80,
      page: 1,
      right: 520,
      top: 650
    }]),
    headingPath: Object.freeze([]),
    index: 0,
    isTable: valueTable !== null,
    languageHints: parsedLanguageHints(text),
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: valueTable,
    text,
    type: valueTable ? "table" : "paragraph"
  });
}

function geometry(nativeBlock = block()): NativePdfGeometry {
  return Object.freeze({
    blocks: Object.freeze([nativeBlock]),
    classification: "native_text",
    pageCount: 1,
    quality: Object.freeze({
      pages: Object.freeze([{
        characterCount: nativeBlock.text.length,
        classification: "native_text",
        duplicateTextItemCount: 0,
        imageCount: 0,
        invalidCharacterCount: 0,
        invisibleText: false,
        maxVisualGroupCount: 2,
        multiGroupRowCount: 1,
        outOfBoundsTextItemCount: 0,
        overlappingTextItemCount: 0,
        page: 1,
        pageBottom: 0,
        pageLeft: 0,
        pageRight: 600,
        pageRotation: 0,
        pageTop: 800,
        rotatedTextItemCount: 0,
        rowCount: 1,
        shortRowCount: 1,
        textAreaRatio: 0.05,
        textItemCount: 2,
        vectorGraphicsOperationCount: 8,
        visualGroupOverflow: false
      }]),
      visualGroupOverflow: false
    })
  });
}

function docling(tableBlock = block()) {
  return finalizeParsedDocument({
    attempts: [{ engine: "docling", errorCode: null, outcome: "complete" }],
    blocks: [tableBlock],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: 1,
    status: "complete"
  });
}

describe("adaptive PDF Vision supplement", () => {
  it("adds a bounded high-resolution table crop and exact native cell text", async () => {
    const bytes = await sharp({
      create: { background: "white", channels: 3, height: 1_600, width: 1_200 }
    }).png().toBuffer();
    const supplement = await prepareAdaptivePdfVisionSupplement({
      batch: {
        images: [{
          bytes,
          height: 1_600,
          mimeType: "image/png",
          page: 1,
          sourceHeight: 800,
          sourceWidth: 600,
          width: 1_200
        }],
        kind: "images",
        pageEnd: 1,
        pageStart: 1
      },
      docling: docling(),
      geometry: geometry()
    });

    expect(supplement.nativePageText).toBe("Metric\t1,234");
    expect(supplement.crops).toHaveLength(1);
    expect(supplement.crops[0]).toMatchObject({
      mimeType: "image/png",
      nativeText: "Metric\t1,234",
      page: 1
    });
    expect(supplement.crops[0]!.bytes.byteLength).toBeLessThanOrEqual(
      ADAPTIVE_PDF_MAX_CROP_BYTES
    );
    const prompt = adaptivePdfVisionPrompt("BASE", supplement);
    expect(prompt).toContain("knowledge-pdf-page-1-table-crop-1");
    expect(prompt).toContain("Metric\\t1,234");
    expect(prompt).toContain("not structural authority");
  });

  it("fails closed when a detected table has no bounded crop geometry", async () => {
    const bytes = await sharp({
      create: { background: "white", channels: 3, height: 800, width: 600 }
    }).png().toBuffer();
    const noBoxTable = block({ boxes: Object.freeze([]) });

    await expect(prepareAdaptivePdfVisionSupplement({
      batch: {
        images: [{
          bytes,
          height: 800,
          mimeType: "image/png",
          page: 1,
          sourceHeight: 800,
          sourceWidth: 600,
          width: 600
        }],
        kind: "images",
        pageEnd: 1,
        pageStart: 1
      },
      docling: docling(noBoxTable),
      geometry: geometry(noBoxTable)
    })).rejects.toMatchObject({
      code: "parser_invalid_output",
      engine: "system_model_vision"
    });
  });
});
