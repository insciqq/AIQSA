import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import {
  ADAPTIVE_PDF_MAX_CROP_BYTES,
  ADAPTIVE_PDF_MAX_FIGURE_CROPS_PER_PAGE,
  adaptivePdfVisionPrompt,
  prepareAdaptivePdfVisionSupplement
} from "./adaptivePdfVision";
import type { NativePdfGeometry } from "./nativePdf";
import type { PreparedPdfBatch } from "./pdfPreparation";
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
        classification: "native_text" as const,
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

function figure(box: ParsedDocumentBlock["boundingBoxes"][number]): ParsedDocumentBlock {
  return {
    ...block({ boxes: [box], table: null, text: "" }),
    assetIds: ["figure-1"],
    page: box.page,
    pageEnd: box.page,
    type: "image"
  };
}

async function figureBatch(): Promise<PreparedPdfBatch> {
  const bytes = await sharp(Buffer.from(
    '<svg width="600" height="800"><rect width="600" height="800" fill="white"/>' +
    '<rect x="100" y="200" width="200" height="200" fill="red"/></svg>'
  )).png().toBuffer();
  return {
    images: [{ bytes, height: 800, mimeType: "image/png", page: 1,
      sourceHeight: 800, sourceWidth: 600, width: 600 }],
    kind: "images", pageEnd: 1, pageStart: 1
  };
}

describe("adaptive PDF Vision supplement", () => {
  it.each(["bottom_left", "top_left"] as const)(
    "retains figure pixels and source context with %s coordinates only when enabled",
    async (coordinateOrigin) => {
      const box = { bottom: 400,
        coordinateOrigin, left: 100, page: 1, right: 300,
        top: coordinateOrigin === "bottom_left" ? 600 : 200 };
      const source = geometry(block({ table: null, text: "Figure caption and scale units" }));
      const input = { batch: await figureBatch(), docling: docling(figure(box)), geometry: source };
      const legacy = await prepareAdaptivePdfVisionSupplement(input);
      const current = await prepareAdaptivePdfVisionSupplement({ ...input, includeFigures: true });

      expect(legacy.crops).toHaveLength(0);
      expect(current.crops).toHaveLength(1);
      expect(current.crops[0]).toMatchObject({
        kind: "figure", page: 1, height: 224, width: 218,
        nativeText: "Figure caption and scale units"
      });
      const crop = current.crops[0]!;
      const pixel = await sharp(crop.bytes).extract({ height: 1, left: 109, top: 112, width: 1 })
        .removeAlpha().raw().toBuffer();
      expect([...pixel]).toEqual([255, 0, 0]);
      expect(crop.bytes.byteLength).toBeLessThanOrEqual(ADAPTIVE_PDF_MAX_CROP_BYTES);
      const prompt = adaptivePdfVisionPrompt("BASE", current);
      expect(prompt).toContain('"figureCrops":[{"attachmentId":"knowledge-pdf-page-1-figure-crop-1"');
      expect(prompt).toContain("interval caps");
      expect(prompt).toContain("full page to retain captions and relationships");
      expect(adaptivePdfVisionPrompt("BASE", legacy)).not.toContain("figureCrops");
    }
  );

  it("bounds distinct figure crops without displacing or changing a table crop", async () => {
    const tableBlock = block({ boxes: [{ bottom: 650, coordinateOrigin: "bottom_left",
      left: 30, page: 1, right: 570, top: 760 }] });
    const figures = [60, 235, 410].map((left) => figure({
      bottom: 300, coordinateOrigin: "bottom_left", left, page: 1, right: left + 130, top: 510
    }));
    const layout = finalizeParsedDocument({ blocks: [tableBlock, ...figures, figures[0]!],
      engine: "docling", mediaType: "application/pdf", pageCount: 1, status: "complete" });
    const input = { batch: await figureBatch(), docling: layout, geometry: geometry(tableBlock) };
    const prior = await prepareAdaptivePdfVisionSupplement(input);
    const current = await prepareAdaptivePdfVisionSupplement({ ...input, includeFigures: true });

    expect(current.crops.filter((crop) => crop.kind === "table")).toEqual(prior.crops);
    expect(current.crops.filter((crop) => crop.kind === "figure"))
      .toHaveLength(ADAPTIVE_PDF_MAX_FIGURE_CROPS_PER_PAGE);
    expect(current.crops.filter((crop) => crop.kind === "figure").map((crop) => crop.index))
      .toEqual([0, 1]);
  });

  it("keeps the page usable for missing, full-page, off-page, and tiny figure regions", async () => {
    const pageBox = { bottom: 0, coordinateOrigin: "bottom_left" as const,
      left: 0, page: 1, right: 600, top: 800 };
    const layout = finalizeParsedDocument({
      blocks: [
        figure(pageBox),
        figure({ ...pageBox, page: 2 }),
        figure({ ...pageBox, left: 700, right: 750, top: 200 }),
        figure({ ...pageBox, right: 1, top: 1 }),
        { ...figure(pageBox), boundingBoxes: [] }
      ],
      engine: "docling", mediaType: "application/pdf", pageCount: 2, status: "complete"
    });
    const input = { batch: await figureBatch(), docling: layout,
      geometry: geometry(block({ table: null, text: "Caption" })), includeFigures: true };
    expect((await prepareAdaptivePdfVisionSupplement(input)).crops).toEqual([]);
    expect((await prepareAdaptivePdfVisionSupplement({ ...input, docling: null })).crops).toEqual([]);
  });

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
