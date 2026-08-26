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

async function noisyScanPdf(): Promise<Buffer> {
  const width = 1_200;
  const height = 1_600;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let value = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    pixels[index] = value & 0xff;
  }
  const rasterBytes = await sharp(pixels, {
    raw: { channels: 3, height, width }
  }).png().toBuffer();
  const document = await PDFDocument.create();
  const raster = await document.embedPng(Uint8Array.from(rasterBytes));
  const page = document.addPage([600, 800]);
  page.drawImage(raster, { height: 800, width: 600, x: 0, y: 0 });
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
      expect(image).toMatchObject({ height: 3_200, mimeType: "image/png", width: 2_400 });
    }

    const legacy = await preparePdfModelBatch({
      bytes: await threePagePdf(),
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1
    }, { maxPages: 10, visionQuality: "legacy" });
    expect(legacy.kind).toBe("images");
    if (legacy.kind !== "images") return;
    expect(legacy.images[0]).toMatchObject({
      height: 1_600,
      mimeType: "image/png",
      width: 1_200
    });
  });

  it("preserves high-fidelity scan dimensions with a bounded JPEG fallback", async () => {
    const maxImageBytes = 6 * 1_024 * 1_024;
    const batch = await preparePdfModelBatch({
      bytes: await noisyScanPdf(),
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1
    }, {
      maxImageBytes,
      maxPages: 10,
      visionQuality: "adaptive_high_fidelity"
    });
    expect(batch.kind).toBe("images");
    if (batch.kind !== "images") return;
    const image = batch.images[0]!;
    expect(image).toMatchObject({ height: 3_200, mimeType: "image/jpeg", width: 2_400 });
    expect(image.bytes.byteLength).toBeLessThanOrEqual(maxImageBytes);
    expect(image.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(image.bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

});
