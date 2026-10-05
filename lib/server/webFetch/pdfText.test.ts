import { describe, expect, it, vi } from "vitest";
import { PdfExtractionError, type PdfExtractionOptions, type PdfExtractionResult } from "../uploads/pdf";
import { PAGE_TEXT_MAX_CHARACTERS, PAGE_TITLE_MAX_CHARACTERS } from "./pageKinds";
import { syntheticPdf } from "./pdf.testFixtures";
import { extractFetchedPdf, FETCHED_PDF_LIMITS, fetchedPdfMaxBytes } from "./pdfText";

const finalUrl = "https://papers.example/paper.pdf";
const input = (body: Uint8Array, signal = new AbortController().signal) => ({ body, contentType: "application/pdf", finalUrl, signal });
const result = (overrides: Partial<PdfExtractionResult> = {}): PdfExtractionResult => ({
  chunks: [], extractedCharacterCount: 5, pageCount: 1, pagesProcessed: 1, status: "complete", text: "Hello", title: null, ...overrides
});

describe("fetched PDF text", () => {
  it("reads the text layer and metadata title in the isolated PDF worker", async () => {
    const page = await extractFetchedPdf(input(syntheticPdf({ text: "Synthetic findings on page one", title: "A   Synthetic Paper" })));
    expect(page).toEqual({ kind: "pdf", text: "Synthetic findings on page one", title: "A Synthetic Paper", truncated: false });
    await expect(extractFetchedPdf(input(syntheticPdf({ text: "No title here" })))).resolves.toMatchObject({ title: null });
  });

  it("returns empty text for a PDF without a text layer and refuses a damaged one", async () => {
    await expect(extractFetchedPdf(input(syntheticPdf({ text: "" })))).resolves.toMatchObject({ kind: "pdf", text: "" });
    await expect(extractFetchedPdf(input(Buffer.from("%PDF-1.4\nnot really a document")))).rejects
      .toEqual(new PdfExtractionError("pdf_invalid"));
  });

  it("asks the extractor for the page text bound, the fetch page cap and the title, and marks a cut text truncated", async () => {
    const extract = vi.fn(async (_bytes: Buffer, _options?: PdfExtractionOptions) =>
      result({ status: "partial", title: "t".repeat(400), truncationReason: "text_limit" }));
    const body = Uint8Array.from(syntheticPdf({ text: "x" }));
    const page = await extractFetchedPdf(input(body.subarray(2)), { extract });
    expect(page).toMatchObject({ truncated: true, title: "t".repeat(PAGE_TITLE_MAX_CHARACTERS) });
    const [bytes, options] = extract.mock.calls[0]!;
    expect(Buffer.compare(bytes, Buffer.from(body.subarray(2)))).toBe(0);
    expect(options).toMatchObject({ readTitle: true, config: { extractedTextMaxChars: PAGE_TEXT_MAX_CHARACTERS,
      maxPages: FETCHED_PDF_LIMITS.maxPages, timeoutMs: FETCHED_PDF_LIMITS.deadlineMs } });
  });

  it("ends at the deadline, waiting for the PDF worker slot included, and keeps the run's cancellation", async () => {
    const waitForAbort = vi.fn((_bytes: Buffer, options: PdfExtractionOptions = {}) =>
      new Promise<PdfExtractionResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }));
    await expect(extractFetchedPdf(input(Buffer.from("%PDF-")), { deadlineMs: 20, extract: waitForAbort }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    const controller = new AbortController();
    const pending = extractFetchedPdf(input(Buffer.from("%PDF-"), controller.signal), { extract: waitForAbort });
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds PDF bytes at 20 MiB, or the installation's smaller chat upload limit", () => {
    expect(fetchedPdfMaxBytes({})).toBe(20 * 1024 * 1024);
    expect(fetchedPdfMaxBytes({ AIQSA_UPLOAD_MAX_BYTES: "67108864" })).toBe(20 * 1024 * 1024);
    expect(fetchedPdfMaxBytes({ AIQSA_UPLOAD_MAX_BYTES: "10000000" })).toBe(10_000_000);
  });
});
