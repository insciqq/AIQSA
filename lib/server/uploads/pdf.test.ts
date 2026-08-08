import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PDF_MAX_PAGES,
  extractPdfTextChunks,
  PdfExtractionError,
  type PdfExtractionOptions,
  type PdfExtractionResult
} from "./pdf";
import { PDF_WORKER_RESOURCE_LIMITS } from "./pdfConfig";

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
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function createDocument(pageItems: unknown[][]) {
  const pageCleanups = pageItems.map(() => vi.fn());
  const getTextContents = pageItems.map((items) => vi.fn(async () => ({ items })));
  const getPage = vi.fn(async (pageNumber: number) => ({
    cleanup: pageCleanups[pageNumber - 1],
    getTextContent: getTextContents[pageNumber - 1]
  }));
  const cleanup = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);

  return {
    cleanup,
    destroy,
    getPage,
    getTextContents,
    pageCleanups,
    proxy: { cleanup, destroy, getPage, numPages: pageItems.length }
  };
}

function injectedOptions(
  document: ReturnType<typeof createDocument>["proxy"],
  config: NonNullable<PdfExtractionOptions["config"]> = {}
): PdfExtractionOptions {
  return {
    config,
    getDocumentProxy: async () => document
  };
}

class FakeWorker extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly terminate = vi.fn(async () => 1);
}

function workerOptions(message?: unknown, capture?: (source: string, options: WorkerOptions) => void) {
  const fakeWorker = new FakeWorker();
  const createWorker = (source: string, options: WorkerOptions) => {
    capture?.(source, options);
    if (message !== undefined) queueMicrotask(() => fakeWorker.emit("message", message));
    return fakeWorker as unknown as Worker;
  };

  return { createWorker, fakeWorker };
}

function validWorkerResult(text = "ok"): PdfExtractionResult {
  return {
    chunks: [{ index: 0, page: 1, text }],
    extractedCharacterCount: text.length,
    pageCount: 1,
    pagesProcessed: 1,
    status: "complete",
    text
  };
}

describe("PDF extraction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts a real PDF in the isolated worker", async () => {
    const result = await extractPdfTextChunks(createTinyPdf("Hello AIQSA PDF"), 20);

    expect(result).toMatchObject({
      extractedCharacterCount: 15,
      pageCount: 1,
      pagesProcessed: 1,
      status: "complete",
      text: "Hello AIQSA PDF"
    });
    expect(result.chunks).toEqual([{ index: 0, page: 1, text: "Hello AIQSA PDF" }]);
  });

  it("keeps exact-limit semantics in the production worker", async () => {
    await expect(
      extractPdfTextChunks(createTinyPdf("12345"), { config: { extractedTextMaxChars: 5 } })
    ).resolves.toMatchObject({
      extractedCharacterCount: 5,
      pagesProcessed: 1,
      status: "complete",
      text: "12345"
    });
  });

  it("stops one character over the limit in the production worker", async () => {
    await expect(
      extractPdfTextChunks(createTinyPdf("123456"), { config: { extractedTextMaxChars: 5 } })
    ).resolves.toEqual({
      chunks: [{ index: 0, page: 1, text: "12345" }],
      extractedCharacterCount: 5,
      pageCount: 1,
      pagesProcessed: 1,
      status: "partial",
      text: "12345",
      truncationReason: "text_limit"
    });
  });

  it("reports no_text from the production worker", async () => {
    await expect(extractPdfTextChunks(createTinyPdf(""))).resolves.toEqual({
      chunks: [],
      extractedCharacterCount: 0,
      pageCount: 1,
      pagesProcessed: 1,
      status: "no_text",
      text: ""
    });
  });

  it("normalizes non-empty pages into one bounded canonical text and deterministic chunks", async () => {
    const document = createDocument([
      [{ str: "  First\n\tpage  " }],
      [{ str: "  \n " }],
      [{ hasEOL: true, str: "Second" }, { str: " page " }]
    ]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { chunkMaxChars: 5 })
    );

    expect(result).toEqual({
      chunks: [
        { index: 0, page: 1, text: "First" },
        { index: 1, page: 1, text: " page" },
        { index: 2, page: 3, text: "\n\nSec" },
        { index: 3, page: 3, text: "ond p" },
        { index: 4, page: 3, text: "age" }
      ],
      extractedCharacterCount: 23,
      pageCount: 3,
      pagesProcessed: 3,
      status: "complete",
      text: "First page\n\nSecond page"
    });
    expect(result.chunks.map((chunk) => chunk.text).join("")).toBe(result.text);
    expect(document.getPage).toHaveBeenCalledTimes(3);
    expect(document.pageCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(document.cleanup).toHaveBeenCalledOnce();
    expect(document.destroy).toHaveBeenCalledOnce();
  });

  it("marks exact-limit plus EOF complete", async () => {
    const document = createDocument([[{ str: "12345" }]]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { extractedTextMaxChars: 5 })
    );

    expect(result).toMatchObject({
      extractedCharacterCount: 5,
      pagesProcessed: 1,
      status: "complete",
      text: "12345"
    });
    expect(result).not.toHaveProperty("truncationReason");
  });

  it("marks partial only after observing the first character beyond the limit", async () => {
    const document = createDocument([[{ str: "123456" }], [{ str: "must not run" }]]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { extractedTextMaxChars: 5 })
    );

    expect(result).toEqual({
      chunks: [{ index: 0, page: 1, text: "12345" }],
      extractedCharacterCount: 5,
      pageCount: 2,
      pagesProcessed: 1,
      status: "partial",
      text: "12345",
      truncationReason: "text_limit"
    });
    expect(document.getPage).toHaveBeenCalledTimes(1);
  });

  it("counts page separators in the limit and does not emit a trailing separator", async () => {
    const document = createDocument([[{ str: "1234" }], [{ str: "AB" }]]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { extractedTextMaxChars: 6 })
    );

    expect(result).toMatchObject({
      extractedCharacterCount: 4,
      pagesProcessed: 2,
      status: "partial",
      text: "1234",
      truncationReason: "text_limit"
    });
    expect(result.chunks.map((chunk) => chunk.text).join("")).toBe("1234");
  });

  it("does not emit normalized whitespace when the following character would exceed the limit", async () => {
    const document = createDocument([[{ str: "A B" }]]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { extractedTextMaxChars: 2 })
    );

    expect(result).toMatchObject({
      extractedCharacterCount: 1,
      status: "partial",
      text: "A",
      truncationReason: "text_limit"
    });
  });

  it("does not split an astral character at a one-code-unit reduction limit", async () => {
    const document = createDocument([[{ str: "😀" }]]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { extractedTextMaxChars: 1 })
    );

    expect(result).toEqual({
      chunks: [],
      extractedCharacterCount: 0,
      pageCount: 1,
      pagesProcessed: 1,
      status: "partial",
      text: "",
      truncationReason: "text_limit"
    });
  });

  it("does not split an astral character across chunk boundaries", async () => {
    const document = createDocument([[{ str: "A😀B" }]]);
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { chunkMaxChars: 2 })
    );

    expect(result.chunks).toEqual([
      { index: 0, page: 1, text: "A" },
      { index: 1, page: 1, text: "😀" },
      { index: 2, page: 1, text: "B" }
    ]);
    expect(result.chunks.map((chunk) => chunk.text).join("")).toBe("A😀B");
  });

  it("returns no_text only after examining every permitted page", async () => {
    const document = createDocument([[{ str: "  " }], [], [{ str: "\n\t" }]]);
    const result = await extractPdfTextChunks(Buffer.from("pdf"), injectedOptions(document.proxy));

    expect(result).toEqual({
      chunks: [],
      extractedCharacterCount: 0,
      pageCount: 3,
      pagesProcessed: 3,
      status: "no_text",
      text: ""
    });
    expect(document.getPage).toHaveBeenCalledTimes(3);
  });

  it("processes page text sequentially", async () => {
    let active = 0;
    let maximumActive = 0;
    const pageItems = Array.from({ length: 20 }, (_, pageIndex) => [{ str: `page-${pageIndex + 1}` }]);
    const document = createDocument(pageItems);
    for (const getTextContent of document.getTextContents) {
      getTextContent.mockImplementation(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return { items: [{ str: "text" }] };
      });
    }

    await extractPdfTextChunks(Buffer.from("pdf"), injectedOptions(document.proxy));
    expect(maximumActive).toBe(1);
  });

  it("allows the exact page cap and rejects one page over before extraction", async () => {
    const allowed = createDocument([[{ str: "one" }], [{ str: "two" }]]);
    await expect(
      extractPdfTextChunks(Buffer.from("pdf"), injectedOptions(allowed.proxy, { maxPages: 2 }))
    ).resolves.toMatchObject({ pageCount: 2, status: "complete" });

    const rejected = createDocument([[{ str: "one" }], [{ str: "two" }], [{ str: "three" }]]);
    await expect(
      extractPdfTextChunks(Buffer.from("pdf"), injectedOptions(rejected.proxy, { maxPages: 2 }))
    ).rejects.toMatchObject({ code: "pdf_page_limit_exceeded", message: "pdf_page_limit_exceeded" });
    expect(rejected.getPage).not.toHaveBeenCalled();
    expect(rejected.cleanup).toHaveBeenCalledOnce();
    expect(rejected.destroy).toHaveBeenCalledOnce();
  });

  it("allows 500 pages and rejects 501 pages before requesting the first page", async () => {
    const allowedGetPage = vi.fn(async () => ({
      getTextContent: async () => ({ items: [{ str: "AB" }] })
    }));
    await expect(
      extractPdfTextChunks(Buffer.from("pdf"), {
        config: { extractedTextMaxChars: 1 },
        getDocumentProxy: async () => ({ getPage: allowedGetPage, numPages: 500 })
      })
    ).resolves.toMatchObject({ pageCount: 500, pagesProcessed: 1, status: "partial" });
    expect(allowedGetPage).toHaveBeenCalledOnce();

    const rejectedGetPage = vi.fn();
    await expect(
      extractPdfTextChunks(Buffer.from("pdf"), {
        getDocumentProxy: async () => ({ getPage: rejectedGetPage, numPages: 501 })
      })
    ).rejects.toEqual(new PdfExtractionError("pdf_page_limit_exceeded"));
    expect(rejectedGetPage).not.toHaveBeenCalled();
  });

  it("bounds many text-heavy pages and stops within the partially included page", async () => {
    const document = createDocument(Array.from({ length: 100 }, () => [{ str: "x".repeat(100) }]));
    const result = await extractPdfTextChunks(
      Buffer.from("pdf"),
      injectedOptions(document.proxy, { chunkMaxChars: 50, extractedTextMaxChars: 250 })
    );

    expect(result).toMatchObject({
      extractedCharacterCount: 250,
      pageCount: 100,
      pagesProcessed: 3,
      status: "partial",
      truncationReason: "text_limit"
    });
    expect(result.text).toHaveLength(250);
    expect(result.chunks.map((chunk) => chunk.text).join("")).toBe(result.text);
    expect(result.chunks.every((chunk) => chunk.text.length <= 50)).toBe(true);
    expect(document.getPage).toHaveBeenCalledTimes(3);
    expect(document.pageCleanups.slice(0, 3).every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(document.pageCleanups.slice(3).every((cleanup) => cleanup.mock.calls.length === 0)).toBe(true);
  });

  it("keeps the product hard page ceiling", () => {
    expect(DEFAULT_PDF_MAX_PAGES).toBe(500);
  });

  it.each([
    ["PasswordException", "pdf_password_required"],
    ["InvalidPDFException", "pdf_invalid"],
    ["FormatError", "pdf_invalid"],
    ["UnknownParserExplosion", "pdf_extraction_failed"]
  ] as const)("maps %s to a stable sanitized error", async (name, code) => {
    const raw = Object.assign(new Error("private parser detail"), { name });
    const extraction = extractPdfTextChunks(Buffer.from("pdf"), {
      getDocumentProxy: async () => {
        throw raw;
      }
    });

    await expect(extraction).rejects.toEqual(new PdfExtractionError(code));
  });

  it("does not reinterpret the ambiguous legacy pdf_too_complex message as a page limit", async () => {
    await expect(
      extractPdfTextChunks(Buffer.from("pdf"), {
        getDocumentProxy: async () => {
          throw new Error("pdf_too_complex");
        }
      })
    ).rejects.toEqual(new PdfExtractionError("pdf_extraction_failed"));
  });

  it("maps corrupt production input without returning the parser message", async () => {
    await expect(extractPdfTextChunks(Buffer.from("not-a-pdf"))).rejects.toEqual(
      new PdfExtractionError("pdf_invalid")
    );
  });

  it("times out, aborts direct extraction, and releases acquired resources", async () => {
    vi.useFakeTimers();
    const pageCleanup = vi.fn();
    const documentCleanup = vi.fn();
    const destroy = vi.fn();
    const extraction = extractPdfTextChunks(Buffer.from("pdf"), {
      config: { timeoutMs: 20 },
      getDocumentProxy: async (_data, { signal }) => ({
        cleanup: documentCleanup,
        destroy,
        getPage: async () => ({
          cleanup: pageCleanup,
          getTextContent: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
        }),
        numPages: 1
      })
    });

    const rejection = expect(extraction).rejects.toEqual(new PdfExtractionError("pdf_extraction_timeout"));
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    await vi.waitFor(() => {
      expect(pageCleanup).toHaveBeenCalledOnce();
      expect(documentCleanup).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
    });
  });

  it("rethrows the caller cancellation reason and cleans up", async () => {
    const controller = new AbortController();
    const reason = new Error("caller_cancelled");
    const pageCleanup = vi.fn();
    const destroy = vi.fn();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const extraction = extractPdfTextChunks(Buffer.from("pdf"), {
      signal: controller.signal,
      getDocumentProxy: async (_data, { signal }) => ({
        destroy,
        getPage: async () => ({
          cleanup: pageCleanup,
          getTextContent: () => {
            markStarted?.();
            return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
          }
        }),
        numPages: 1
      })
    });

    await started;
    controller.abort(reason);
    await expect(extraction).rejects.toBe(reason);
    await vi.waitFor(() => {
      expect(pageCleanup).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
    });
  });

  it("starts workers with finite resources, bounded data, and captured output", async () => {
    let capturedSource = "";
    let capturedOptions: WorkerOptions | undefined;
    const result = validWorkerResult();
    const { createWorker, fakeWorker } = workerOptions({ ok: true, result }, (source, options) => {
      capturedSource = source;
      capturedOptions = options;
    });

    await expect(extractPdfTextChunks(Buffer.from("pdf"), { createWorker })).resolves.toEqual(result);
    expect(capturedSource).toContain("pdf.getPage(pageNumber)");
    expect(capturedSource).not.toContain("extractText(");
    expect(capturedSource).toContain("require(workerData.unpdfModulePath)");
    expect(capturedOptions).toMatchObject({
      eval: true,
      resourceLimits: PDF_WORKER_RESOURCE_LIMITS,
      stderr: true,
      stdout: true,
      workerData: {
        config: {
          chunkMaxChars: 1_200,
          extractedTextMaxChars: 1_000_000,
          maxPages: 500
        },
        unpdfModulePath: expect.stringMatching(/unpdf[/\\]dist[/\\]index\.cjs$/)
      }
    });
    expect(fakeWorker.stdout.readableFlowing).toBe(true);
    expect(fakeWorker.stderr.readableFlowing).toBe(true);
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    { ok: true, result: { ...validWorkerResult(), extra: "not allowed" } },
    { ok: true, result: { ...validWorkerResult(), extractedCharacterCount: 99 } },
    { ok: true, result: { ...validWorkerResult(), chunks: [{ index: 0, page: 1, text: "different" }] } },
    {
      ok: true,
      result: {
        chunks: [{ index: 0, page: 1, text: "x".repeat(20_001) }],
        extractedCharacterCount: 20_001,
        pageCount: 1,
        pagesProcessed: 1,
        status: "complete",
        text: "x".repeat(20_001)
      }
    },
    {
      ok: true,
      result: {
        chunks: [],
        extractedCharacterCount: 0,
        pageCount: 0,
        pagesProcessed: 0,
        status: "complete",
        text: ""
      }
    },
    {
      ok: true,
      result: {
        chunks: [],
        extractedCharacterCount: 0,
        pageCount: 1,
        pagesProcessed: 0,
        status: "partial",
        text: "",
        truncationReason: "text_limit"
      }
    },
    {
      ok: true,
      result: {
        chunks: [{ index: 0, page: 2, text: "x" }],
        extractedCharacterCount: 1,
        pageCount: 2,
        pagesProcessed: 1,
        status: "partial",
        text: "x",
        truncationReason: "text_limit"
      }
    },
    { error: "private parser detail", ok: false }
  ])("rejects malformed or inconsistent worker messages", async (message) => {
    const { createWorker, fakeWorker } = workerOptions(message);
    await expect(extractPdfTextChunks(Buffer.from("pdf"), { createWorker })).rejects.toEqual(
      new PdfExtractionError("pdf_extraction_failed")
    );
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a timed-out worker", async () => {
    vi.useFakeTimers();
    const { createWorker, fakeWorker } = workerOptions();
    const extraction = extractPdfTextChunks(Buffer.from("pdf"), {
      config: { timeoutMs: 10 },
      createWorker
    });
    const rejection = expect(extraction).rejects.toEqual(new PdfExtractionError("pdf_extraction_timeout"));

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
  });

  it.each(["error", "exit"] as const)("sanitizes an unexpected worker %s", async (event) => {
    const fakeWorker = new FakeWorker();
    const createWorker = () => {
      queueMicrotask(() => {
        if (event === "error") fakeWorker.emit("error", new Error("private worker detail"));
        else fakeWorker.emit("exit", 17);
      });
      return fakeWorker as unknown as Worker;
    };

    await expect(extractPdfTextChunks(Buffer.from("pdf"), { createWorker })).rejects.toEqual(
      new PdfExtractionError("pdf_extraction_failed")
    );
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a worker and preserves an abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("request_cancelled");
    const { createWorker, fakeWorker } = workerOptions();
    const extraction = extractPdfTextChunks(Buffer.from("pdf"), { createWorker, signal: controller.signal });

    controller.abort(reason);
    await expect(extraction).rejects.toBe(reason);
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
  });
});
