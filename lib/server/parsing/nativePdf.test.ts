import { describe, expect, it } from "vitest";
import { imageOnlyPdfInputProbeFixture } from "../providers/pdfInputProbe";
import { parseNativeTextPdf } from "./nativePdf";

function tinyPdf(content: string): Buffer {
  const stream = `BT /F1 12 Tf ${content} ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
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

const limits = {
  maxBlocks: 100,
  maxCharacters: 10_000,
  maxPages: 10,
  timeoutMs: 10_000
};

describe("native PDF classification and geometry", () => {
  it("keeps horizontally separated native text in one attributable table row", async () => {
    const parsed = await parseNativeTextPdf({
      bytes: tinyPdf("40 140 Td (Metric) Tj 160 0 Td (6.7) Tj"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    }, limits);

    expect(parsed.classification).toBe("native_text");
    expect(parsed.document).toMatchObject({
      engine: "native_pdf",
      pageCount: 1,
      status: "complete"
    });
    expect(parsed.document?.blocks).toEqual([
      expect.objectContaining({
        isTable: true,
        page: 1,
        table: expect.objectContaining({ columnCount: 2, rowCount: 1 }),
        text: "Metric\t6.7",
        type: "table"
      })
    ]);
  });

  it("classifies an image-only PDF without manufacturing local text", async () => {
    const fixture = imageOnlyPdfInputProbeFixture();
    const parsed = await parseNativeTextPdf({
      bytes: fixture.bytes,
      fileName: fixture.fileName,
      mimeType: fixture.mimeType
    }, limits);

    expect(parsed).toEqual({ classification: "image_only", document: null });
  });

  it("rejects native output beyond the configured character bound", async () => {
    await expect(parseNativeTextPdf({
      bytes: tinyPdf("40 140 Td (Metric) Tj"),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    }, { ...limits, maxCharacters: 3 })).rejects.toMatchObject({
      code: "parser_output_too_large",
      engine: "native_pdf"
    });
  });
});
