import { extractText, getDocumentProxy } from "unpdf";
import { Worker } from "node:worker_threads";

export const DEFAULT_PDF_MAX_PAGES = 500;
export const DEFAULT_PDF_EXTRACTION_TIMEOUT_MS = 20_000;

export type PdfTextChunk = {
  index: number;
  page: number;
  text: string;
};

export type PdfExtractionResult = {
  chunks: PdfTextChunk[];
  pageCount: number;
  text: string;
};

type PdfDocument = {
  numPages: number;
};

type PdfTextExtraction = {
  text: string[];
  totalPages: number;
};

export type PdfExtractionOptions = {
  extractText?: (pdf: PdfDocument, options: { mergePages: false; signal: AbortSignal }) => Promise<PdfTextExtraction>;
  getDocumentProxy?: (data: Uint8Array, options: { signal: AbortSignal }) => Promise<PdfDocument>;
  maxChars?: number;
  maxPages?: number;
  timeoutMs?: number;
};

type NormalizedPdfExtractionOptions = Required<PdfExtractionOptions>;

function chunkPageText(page: number, text: string, maxChars: number): PdfTextChunk[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks: PdfTextChunk[] = [];

  for (let start = 0; start < normalized.length; start += maxChars) {
    chunks.push({
      index: chunks.length,
      page,
      text: normalized.slice(start, start + maxChars)
    });
  }

  return chunks;
}

function pdfTooComplexError(): Error {
  return new Error("pdf_too_complex");
}

function normalizeOptions(optionsOrMaxChars: PdfExtractionOptions | number = {}): NormalizedPdfExtractionOptions {
  const options = typeof optionsOrMaxChars === "number" ? { maxChars: optionsOrMaxChars } : optionsOrMaxChars;

  return {
    extractText: options.extractText ?? ((pdf, textOptions) => extractText(pdf as never, textOptions)),
    getDocumentProxy: options.getDocumentProxy ?? ((data) => getDocumentProxy(data) as Promise<PdfDocument>),
    maxChars: options.maxChars ?? 1200,
    maxPages: options.maxPages ?? DEFAULT_PDF_MAX_PAGES,
    timeoutMs: options.timeoutMs ?? DEFAULT_PDF_EXTRACTION_TIMEOUT_MS
  };
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run(abortController.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          reject(pdfTooComplexError());
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function extractPdfTextChunks(
  buffer: Buffer,
  optionsOrMaxChars: PdfExtractionOptions | number = {}
): Promise<PdfExtractionResult> {
  const rawOptions = typeof optionsOrMaxChars === "number" ? { maxChars: optionsOrMaxChars } : optionsOrMaxChars;
  const options = normalizeOptions(optionsOrMaxChars);

  if (!rawOptions.extractText && !rawOptions.getDocumentProxy) {
    return extractPdfTextChunksInWorker(buffer, options);
  }

  return withTimeout((signal) => extractPdfTextChunksWithoutTimeout(buffer, options, signal), options.timeoutMs);
}

async function extractPdfTextChunksWithoutTimeout(
  buffer: Buffer,
  options: NormalizedPdfExtractionOptions,
  signal: AbortSignal
): Promise<PdfExtractionResult> {
  const pdf = await options.getDocumentProxy(new Uint8Array(buffer), { signal });

  if (pdf.numPages > options.maxPages) {
    throw pdfTooComplexError();
  }

  const result = await options.extractText(pdf, { mergePages: false, signal });

  if (result.totalPages > options.maxPages) {
    throw pdfTooComplexError();
  }

  const chunks = result.text.flatMap((pageText, pageIndex) => chunkPageText(pageIndex + 1, pageText, options.maxChars));

  return {
    chunks,
    pageCount: result.totalPages,
    text: result.text.join("\n\n").trim()
  };
}

function workerSource(): string {
  return `
    const { parentPort, workerData } = require("node:worker_threads");

    (async () => {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(workerData.bytes));

      if (pdf.numPages > workerData.maxPages) {
        throw new Error("pdf_too_complex");
      }

      const result = await extractText(pdf, { mergePages: false });

      if (result.totalPages > workerData.maxPages) {
        throw new Error("pdf_too_complex");
      }

      parentPort.postMessage({
        ok: true,
        text: result.text,
        totalPages: result.totalPages
      });
    })().catch((error) => {
      parentPort.postMessage({
        error: error instanceof Error ? error.message : "pdf_too_complex",
        ok: false
      });
    });
  `;
}

function extractPdfTextChunksInWorker(
  buffer: Buffer,
  options: NormalizedPdfExtractionOptions
): Promise<PdfExtractionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource(), {
      eval: true,
      workerData: {
        bytes: new Uint8Array(buffer),
        maxPages: options.maxPages
      }
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(pdfTooComplexError());
    }, options.timeoutMs);

    worker.once("message", (message: unknown) => {
      clearTimeout(timer);
      void worker.terminate();

      if (!message || typeof message !== "object" || !("ok" in message)) {
        reject(pdfTooComplexError());
        return;
      }

      const result = message as { error?: string; ok: boolean; text?: string[]; totalPages?: number };
      if (!result.ok || !Array.isArray(result.text) || typeof result.totalPages !== "number") {
        reject(new Error(result.error || "pdf_too_complex"));
        return;
      }

      const chunks = result.text.flatMap((pageText, pageIndex) =>
        chunkPageText(pageIndex + 1, pageText, options.maxChars)
      );

      resolve({
        chunks,
        pageCount: result.totalPages,
        text: result.text.join("\n\n").trim()
      });
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        return;
      }

      clearTimeout(timer);
      reject(pdfTooComplexError());
    });
  });
}
