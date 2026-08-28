import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { imageOnlyPdfInputProbeFixture } from "../providers/pdfInputProbe";
import { extractNativePdfGeometry, parseNativeTextPdf } from "./nativePdf";

function generatedPdf(
  pageStreams: readonly string[],
  input: Readonly<{ imagePages?: readonly number[]; width?: number }> = {}
): Buffer {
  const width = input.width ?? 720;
  const fontReference = 3 + pageStreams.length * 2;
  const hasImages = (input.imagePages?.length ?? 0) > 0;
  const imageReference = fontReference + 1;
  const imagePages = new Set(input.imagePages ?? []);
  const pageReferences = pageStreams.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences.map((value) => `${value} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`
  ];
  for (const [index, stream] of pageStreams.entries()) {
    const pageReference = pageReferences[index]!;
    const imageResource = imagePages.has(index + 1)
      ? ` /XObject << /Im1 ${imageReference} 0 R >>`
      : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 800] /Resources << /Font << /F1 ${fontReference} 0 R >>${imageResource} >> /Contents ${pageReference + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (hasImages) {
    objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n0\nendstream");
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function textStream(rows: readonly Readonly<{ text: string; x: number; y: number }>[]): string {
  return [
    "BT /F1 12 Tf",
    ...rows.map((row) =>
      `1 0 0 1 ${row.x} ${row.y} Tm (${row.text.replace(/[()\\]/gu, "\\$&")}) Tj`),
    "ET"
  ].join("\n");
}

function workerMessage(message: unknown): Worker {
  const worker = new EventEmitter() as EventEmitter & {
    terminate: () => Promise<number>;
  };
  worker.terminate = async () => 0;
  queueMicrotask(() => worker.emit("message", message));
  return worker as unknown as Worker;
}

const limits = {
  maxBlocks: 100,
  maxCharacters: 10_000,
  maxPages: 10,
  timeoutMs: 10_000
};

describe("native PDF classification and geometry", () => {
  it("keeps a simple single-column text PDF on the native fast path", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      text: `A complete single column sentence number ${index + 1} with enough ordinary searchable text.`,
      x: 40,
      y: 720 - index * 36
    }));
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf([textStream(rows)]),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.classification).toBe("native_text");
    expect(parsed.reasonCode).toBeNull();
    expect(parsed.document).toMatchObject({
      engine: "native_pdf",
      pageCount: 1,
      status: "complete"
    });
    expect(parsed.document?.blocks).toHaveLength(5);
  });

  it("routes a deterministic two-column PDF away from the native fast path", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => [
      { text: `Left column sentence ${index + 1} continues here`, x: 40, y: 720 - index * 36 },
      { text: `Right column sentence ${index + 1} continues here`, x: 390, y: 720 - index * 36 }
    ]).flat();
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf([textStream(rows)]),
      fileName: "two-columns.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.document).toBeNull();
    expect(parsed.reasonCode).toBe("native_pdf_possible_multi_column");
  });

  it("routes a multi-row visual table to layout-aware fallback", async () => {
    const rows = Array.from({ length: 5 }, (_, row) => [
      { text: `Metric-${row}`, x: 40, y: 720 - row * 36 },
      { text: `Actual-${row}`, x: 300, y: 720 - row * 36 },
      { text: `Reference-${row}`, x: 520, y: 720 - row * 36 }
    ]).flat();
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf([textStream(rows)]),
      fileName: "table.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.document).toBeNull();
    expect(parsed.reasonCode).toBe("native_pdf_possible_multi_column");
  });

  it("classifies an image-only PDF without manufacturing local text", async () => {
    const fixture = imageOnlyPdfInputProbeFixture();
    const parsed = await parseNativeTextPdf({
      bytes: fixture.bytes,
      fileName: fixture.fileName,
      mimeType: fixture.mimeType
    }, limits);

    expect(parsed).toEqual({
      classification: "image_only",
      document: null,
      reasonCode: "native_pdf_image_heavy_low_text"
    });
  });

  it("does not accept a scanned page merely because it has a digital footer", async () => {
    const stream = [
      "q 720 0 0 800 0 0 cm /Im1 Do Q",
      textStream([{ text: "Page 1", x: 330, y: 20 }])
    ].join("\n");
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf([stream], { imagePages: [1] }),
      fileName: "scan-with-footer.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.document).toBeNull();
    expect(parsed.reasonCode).toBe("native_pdf_image_heavy_low_text");
  });

  it.each([3, 7])("marks PDF rendering mode %s as non-visible native text", async (mode) => {
    const stream = [
      `BT /F1 12 Tf ${mode} Tr`,
      "1 0 0 1 40 720 Tm (Hidden native text) Tj",
      "ET"
    ].join("\n");
    const extracted = await extractNativePdfGeometry({
      bytes: generatedPdf([stream]),
      fileName: "hidden-text.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(extracted.quality.pages[0]?.invisibleText).toBe(true);
  });

  it("turns visual-group overflow into explicit fallback instead of truncating text", async () => {
    const cells = Array.from({ length: 33 }, (_, index) => ({
      text: `C${index.toString().padStart(2, "0")}`,
      x: 20 + index * 42,
      y: 500
    }));
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf([textStream(cells)], { width: 1_440 }),
      fileName: "wide-table.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.document).toBeNull();
    expect(parsed.reasonCode).toBe("native_pdf_visual_group_overflow");
  });

  it("rejects an excessively fragmented visual text layer", async () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({
      text: `R${index.toString().padStart(2, "0")}`,
      x: 40,
      y: 760 - index * 34
    }));
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf([textStream(rows)]),
      fileName: "fragmented.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.document).toBeNull();
    expect(parsed.reasonCode).toBe("native_pdf_excessive_fragmentation");
  });

  it("rejects a worker projection that reports many control/replacement characters", async () => {
    const text = "Readable sentence with enough ordinary text for density checks.";
    const box = {
      bottom: 690,
      coordinateOrigin: "bottom_left",
      left: 40,
      page: 1,
      right: 400,
      top: 710
    };
    const parsed = await parseNativeTextPdf({
      bytes: Buffer.from("%PDF-deterministic-worker-projection"),
      fileName: "bad-text-layer.pdf",
      mimeType: "application/pdf"
    }, {
      ...limits,
      createWorker: () => workerMessage({
        ok: true,
        result: {
          classification: "native_text",
          pageCount: 1,
          pages: [{
            characterCount: text.length,
            imageCount: 0,
            invalidCharacterCount: 5,
            invisibleText: false,
            maxVisualGroupCount: 1,
            multiGroupRowCount: 0,
            page: 1,
            rowCount: 1,
            shortRowCount: 0
          }],
          rows: [{ box, cells: [{ box, text }], page: 1, text }],
          visualGroupOverflow: false
        }
      })
    });

    expect(parsed.document).toBeNull();
    expect(parsed.reasonCode).toBe("native_pdf_invalid_text_characters");
  });

  it("keeps a repeated header/footer fixture eligible for downstream furniture handling", async () => {
    const pages = Array.from({ length: 3 }, (_, index) => textStream([
      { text: "Example organization handbook", x: 40, y: 770 },
      {
        text: `Substantive single column body on page ${index + 1} with searchable document content.`,
        x: 40,
        y: 400
      },
      { text: "Internal use only", x: 40, y: 25 }
    ]));
    const parsed = await parseNativeTextPdf({
      bytes: generatedPdf(pages),
      fileName: "repeated-furniture.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.reasonCode).toBeNull();
    expect(parsed.document).toMatchObject({ pageCount: 3, status: "complete" });
  });

  it("rejects native output beyond the configured character bound", async () => {
    await expect(parseNativeTextPdf({
      bytes: generatedPdf([textStream([{ text: "Metric", x: 40, y: 140 }])]),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    }, { ...limits, maxCharacters: 3 })).rejects.toMatchObject({
      code: "parser_output_too_large",
      engine: "native_pdf"
    });
  });
});
