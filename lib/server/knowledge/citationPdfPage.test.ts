import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { preparePdfModelBatch } from "../parsing/pdfPreparation";
import {
  citationBoxPixelRectangle,
  renderKnowledgeSourcePdfPage
} from "./citationPdfPage";

describe("citation PDF page geometry", () => {
  it("maps bottom-left PDF coordinates into top-left image pixels", () => {
    expect(citationBoxPixelRectangle({
      bottom: 100,
      coordinateOrigin: "bottom_left",
      left: 50,
      page: 1,
      right: 250,
      top: 180
    }, {
      height: 1_600,
      sourceHeight: 800,
      sourceWidth: 600,
      width: 1_200
    })).toEqual({ height: 160, width: 400, x: 100, y: 1_240 });
  });

  it("rejects degenerate or fully out-of-page coordinates", () => {
    expect(citationBoxPixelRectangle({
      bottom: 900,
      coordinateOrigin: "bottom_left",
      left: 50,
      page: 1,
      right: 250,
      top: 950
    }, {
      height: 1_600,
      sourceHeight: 800,
      sourceWidth: 600,
      width: 1_200
    })).toBeNull();
  });

  it("renders one requested source page as a bounded PNG without citation boxes", async () => {
    const pageBytes = await sharp({
      create: {
        background: { alpha: 1, b: 255, g: 255, r: 255 },
        channels: 4,
        height: 4,
        width: 4
      }
    }).png().toBuffer();
    const prepare = vi.fn(async () => ({
      images: [{
        bytes: pageBytes,
        height: 4,
        mimeType: "image/png" as const,
        page: 2,
        sourceHeight: 4,
        sourceWidth: 4,
        width: 4
      }],
      kind: "images" as const,
      pageEnd: 2,
      pageStart: 2
    })) as unknown as typeof preparePdfModelBatch;

    const rendered = await renderKnowledgeSourcePdfPage({
      bytes: Buffer.from("%PDF-private"),
      maxPages: 8,
      page: 2
    }, { prepare });

    expect(rendered.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(prepare).toHaveBeenCalledWith({
      bytes: Buffer.from("%PDF-private"),
      mode: "system_model_vision",
      pageEnd: 2,
      pageStart: 2
    }, { maxPages: 8 });
  });

  it.each([0, 9, 1.5])("rejects an out-of-bounds source page before PDF work: %s", async (page) => {
    const prepare = vi.fn() as unknown as typeof preparePdfModelBatch;

    await expect(renderKnowledgeSourcePdfPage({
      bytes: Buffer.from("%PDF-private"),
      maxPages: 8,
      page
    }, { prepare })).rejects.toThrow("knowledge_citation_page_invalid");
    expect(prepare).not.toHaveBeenCalled();
  });
});
