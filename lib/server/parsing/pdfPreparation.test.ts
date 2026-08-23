import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  inspectPdfForModelProcessing,
  PDF_MODEL_MAX_IMAGE_PIXELS,
  preparePdfModelBatch
} from "./pdfPreparation";

async function threePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const rasterBytes = await sharp({
    create: {
      background: { alpha: 1, b: 220, g: 120, r: 40 },
      channels: 4,
      height: 12,
      width: 12
    }
  }).png().toBuffer();
  const raster = await document.embedPng(Uint8Array.from(rasterBytes));
  for (let index = 0; index < 3; index += 1) {
    const page = document.addPage([600, 800]);
    page.drawRectangle({
      borderColor: rgb(0, 0, 0),
      borderWidth: 2,
      height: 100,
      width: 300,
      x: 50 + index,
      y: 500
    });
    page.drawImage(raster, { height: 12, width: 12, x: 55, y: 505 });
  }
  return Buffer.from(await document.save());
}

describe("bounded model PDF preparation", () => {
  it("inspects and copies only the requested direct-input page range", async () => {
    const bytes = await threePagePdf();
    await expect(inspectPdfForModelProcessing({
      bytes,
      mode: "system_model_direct_pdf"
    }, { maxPages: 10 })).resolves.toEqual({ pageCount: 3 });

    const batch = await preparePdfModelBatch({
      bytes,
      mode: "system_model_direct_pdf",
      pageEnd: 3,
      pageStart: 2
    }, { maxPages: 10 });
    expect(batch.kind).toBe("pdf");
    if (batch.kind !== "pdf") return;
    const copied = await PDFDocument.load(Uint8Array.from(batch.bytes));
    expect(copied.getPageCount()).toBe(2);
    expect(batch.bytes.equals(bytes)).toBe(false);
  });

  it("renders bounded PNG page images for Vision", async () => {
    const batch = await preparePdfModelBatch({
      bytes: await threePagePdf(),
      mode: "system_model_vision",
      pageEnd: 2,
      pageStart: 1
    }, { maxPages: 10 });
    expect(batch.kind).toBe("images");
    if (batch.kind !== "images") return;
    expect(batch.images).toHaveLength(2);
    expect(batch.images.map(({ page }) => page)).toEqual([1, 2]);
    for (const image of batch.images) {
      expect(image.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(image.width * image.height).toBeLessThanOrEqual(PDF_MODEL_MAX_IMAGE_PIXELS);
    }
  });
});
