import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PDF_MAX_PAGES, extractPdfTextChunks } from "./pdf";

function createTinyPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length + 35} >>\nstream\nBT /F1 12 Tf 40 140 Td (${text}) Tj ET\nendstream`,
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

describe("PDF extraction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts deterministic chunks with page metadata", async () => {
    const result = await extractPdfTextChunks(createTinyPdf("Hello AIQSA PDF"), 20);

    expect(result.pageCount).toBe(1);
    expect(result.text).toContain("Hello AIQSA PDF");
    expect(result.chunks[0]).toMatchObject({
      page: 1,
      text: "Hello AIQSA PDF"
    });
  });

  it("rejects PDFs over the configured page cap before text extraction", async () => {
    const extractText = vi.fn(async () => ({
      text: ["should not run"],
      totalPages: DEFAULT_PDF_MAX_PAGES + 1
    }));

    await expect(
      extractPdfTextChunks(Buffer.from("%PDF-1.4\n"), {
        extractText,
        getDocumentProxy: async () => ({
          numPages: DEFAULT_PDF_MAX_PAGES + 1
        })
      })
    ).rejects.toThrow("pdf_too_complex");

    expect(extractText).not.toHaveBeenCalled();
  });

  it("rejects PDFs when extraction exceeds the wall-clock timeout", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const extraction = extractPdfTextChunks(Buffer.from("%PDF-1.4\n"), {
      extractText: (_pdf, { signal }) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            cancelled = true;
          });
        }),
      getDocumentProxy: async () => ({
        numPages: 1
      }),
      timeoutMs: 20
    });
    const rejection = expect(extraction).rejects.toThrow("pdf_too_complex");

    await vi.advanceTimersByTimeAsync(20);

    await rejection;
    expect(cancelled).toBe(true);
  });
});
