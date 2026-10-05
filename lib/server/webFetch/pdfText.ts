import { extractPdfTextChunks } from "../uploads/pdf";
import { defaultUploadMaxBytes } from "../uploads/validation";
import { PAGE_TEXT_MAX_CHARACTERS, PAGE_TITLE_MAX_CHARACTERS, type FetchedPage } from "./pageKinds";
import type { FetchedPageInput } from "./pageText";

/**
 * Where a fetched PDF becomes page text: only in the chat upload PDF
 * extractor's isolated, resource-limited worker (`extractPdfTextChunks`),
 * never in the application and never in the HTML page-parser process. The
 * worker holds the one local PDF worker slot that chat uploads share, so one
 * deadline covers the wait for that slot and the extraction. Text layers
 * only: a scanned PDF has no readable text.
 */
export const FETCHED_PDF_LIMITS = Object.freeze({
  /** The wait for the PDF worker slot and the extraction, like a page parse. */
  deadlineMs: 30_000,
  /** Raw and decoded bytes. Papers and datasheets are often 5-20 MB; never above the chat upload limit. */
  maxBytes: 20 * 1024 * 1024,
  /**
   * Only the first pages fit the page text bound; a longer document is
   * refused before its pages are read, so sparse or scanned documents cannot
   * spend the deadline page by page.
   */
  maxPages: 300
});

/** The PDF byte bound: `FETCHED_PDF_LIMITS.maxBytes`, or the installation's smaller chat upload limit. */
export function fetchedPdfMaxBytes(env: Record<string, string | undefined> = process.env): number {
  return Math.min(FETCHED_PDF_LIMITS.maxBytes, defaultUploadMaxBytes(env));
}

export type FetchedPdfDeps = Readonly<{
  deadlineMs?: number;
  /** Test seam; production always extracts in the isolated worker. */
  extract?: typeof extractPdfTextChunks;
}>;

/**
 * The bounded text and metadata title of one fetched PDF; empty text when it
 * has no text layer. Rejects with the caller's abort reason when the run
 * stopped, a `TimeoutError` when the deadline passed, or the extractor's
 * `PdfExtractionError` (password, damaged, page limit, its own timeout).
 */
export async function extractFetchedPdf(input: FetchedPageInput, deps: FetchedPdfDeps = {}): Promise<FetchedPage> {
  const deadlineMs = deps.deadlineMs ?? FETCHED_PDF_LIMITS.deadlineMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deadlineMs)]);
  const result = await (deps.extract ?? extractPdfTextChunks)(
    Buffer.from(input.body.buffer, input.body.byteOffset, input.body.byteLength),
    {
      config: { extractedTextMaxChars: PAGE_TEXT_MAX_CHARACTERS, maxPages: FETCHED_PDF_LIMITS.maxPages, timeoutMs: deadlineMs },
      readTitle: true,
      signal
    }
  );
  return {
    kind: "pdf",
    text: result.text,
    title: result.title ? result.title.slice(0, PAGE_TITLE_MAX_CHARACTERS) : null,
    truncated: result.status === "partial"
  };
}
