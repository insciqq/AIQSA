import { Worker, type WorkerOptions } from "node:worker_threads";
import {
  DEFAULT_PDF_CHUNK_MAX_CHARS,
  DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
  DEFAULT_PDF_EXTRACTION_TIMEOUT_MS,
  DEFAULT_PDF_MAX_PAGES,
  getPdfExtractionConfig,
  PDF_WORKER_RESOURCE_LIMITS,
  type PdfExtractionConfig
} from "./pdfConfig";

const UNPDF_MODULE_PATH = require.resolve("unpdf");

export {
  DEFAULT_PDF_CHUNK_MAX_CHARS,
  DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
  DEFAULT_PDF_EXTRACTION_TIMEOUT_MS,
  DEFAULT_PDF_MAX_PAGES
} from "./pdfConfig";

export type PdfTextChunk = {
  index: number;
  page: number;
  text: string;
};

export type PdfExtractionResult = {
  chunks: PdfTextChunk[];
  extractedCharacterCount: number;
  pageCount: number;
  pagesProcessed: number;
  status: "complete" | "partial" | "no_text";
  text: string;
  truncationReason?: "text_limit";
};

export type PdfExtractionErrorCode =
  | "pdf_page_limit_exceeded"
  | "pdf_extraction_timeout"
  | "pdf_password_required"
  | "pdf_invalid"
  | "pdf_extraction_failed";

const PDF_EXTRACTION_ERROR_CODES = new Set<PdfExtractionErrorCode>([
  "pdf_page_limit_exceeded",
  "pdf_extraction_timeout",
  "pdf_password_required",
  "pdf_invalid",
  "pdf_extraction_failed"
]);

export class PdfExtractionError extends Error {
  readonly code: PdfExtractionErrorCode;

  constructor(code: PdfExtractionErrorCode) {
    super(code);
    this.name = "PdfExtractionError";
    this.code = code;
  }
}

export function isPdfExtractionError(error: unknown): error is PdfExtractionError {
  return error instanceof PdfExtractionError;
}

type PdfTextItem = {
  hasEOL?: boolean;
  str: string;
};

type PdfPage = {
  cleanup?: () => unknown;
  getTextContent(): Promise<{ items: unknown[] }>;
};

type PdfDocument = {
  cleanup?: () => unknown | Promise<unknown>;
  destroy?: () => unknown | Promise<unknown>;
  getPage(pageNumber: number): Promise<PdfPage>;
  numPages: number;
};

export type PdfExtractionOptions = {
  /** Test-only injection point. Production extraction always runs in the isolated worker. */
  createWorker?: (source: string, options: WorkerOptions) => Worker;
  /** Test-only injection point for deterministic page proxies. */
  getDocumentProxy?: (data: Uint8Array, options: { signal: AbortSignal }) => Promise<PdfDocument>;
  /** Backwards-compatible alias for the former per-chunk option. */
  maxChars?: number;
  config?: Partial<PdfExtractionConfig>;
  signal?: AbortSignal;
};

type NormalizedPdfExtractionOptions = {
  config: PdfExtractionConfig;
  createWorker: (source: string, options: WorkerOptions) => Worker;
  getDocumentProxy?: PdfExtractionOptions["getDocumentProxy"];
  signal?: AbortSignal;
};

function positiveIntegerAtMost(value: number | undefined, fallback: number, ceiling: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 && (value ?? 0) <= ceiling ? (value as number) : fallback;
}

function normalizeOptions(optionsOrChunkMaxChars: PdfExtractionOptions | number): NormalizedPdfExtractionOptions {
  const options = typeof optionsOrChunkMaxChars === "number" ? { maxChars: optionsOrChunkMaxChars } : optionsOrChunkMaxChars;
  const requested = options.config;
  const defaults = requested
    ? {
        chunkMaxChars: DEFAULT_PDF_CHUNK_MAX_CHARS,
        extractedTextMaxChars: DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS,
        maxPages: DEFAULT_PDF_MAX_PAGES,
        timeoutMs: DEFAULT_PDF_EXTRACTION_TIMEOUT_MS,
        workerResourceLimits: PDF_WORKER_RESOURCE_LIMITS
      }
    : getPdfExtractionConfig();

  return {
    config: {
      chunkMaxChars: positiveIntegerAtMost(
        options.maxChars ?? requested?.chunkMaxChars,
        defaults.chunkMaxChars,
        DEFAULT_PDF_CHUNK_MAX_CHARS
      ),
      extractedTextMaxChars: positiveIntegerAtMost(
        requested?.extractedTextMaxChars,
        defaults.extractedTextMaxChars,
        DEFAULT_PDF_EXTRACTED_TEXT_MAX_CHARS
      ),
      maxPages: positiveIntegerAtMost(requested?.maxPages, defaults.maxPages, DEFAULT_PDF_MAX_PAGES),
      timeoutMs: positiveIntegerAtMost(
        requested?.timeoutMs,
        defaults.timeoutMs,
        DEFAULT_PDF_EXTRACTION_TIMEOUT_MS
      ),
      workerResourceLimits: PDF_WORKER_RESOURCE_LIMITS
    },
    createWorker: options.createWorker ?? ((source, workerOptions) => new Worker(source, workerOptions)),
    getDocumentProxy: options.getDocumentProxy,
    signal: options.signal
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function errorProperty(error: unknown, property: "code" | "name"): unknown {
  return typeof error === "object" && error !== null && property in error
    ? (error as Record<string, unknown>)[property]
    : undefined;
}

function classifyPdfError(error: unknown): PdfExtractionError {
  if (isPdfExtractionError(error)) {
    return error;
  }

  const name = errorProperty(error, "name");
  const code = errorProperty(error, "code");

  if (name === "PasswordException" || code === 1 || code === 2) {
    return new PdfExtractionError("pdf_password_required");
  }

  if (
    name === "InvalidPDFException" ||
    name === "MissingPDFException" ||
    name === "UnexpectedResponseException" ||
    name === "FormatError"
  ) {
    return new PdfExtractionError("pdf_invalid");
  }

  return new PdfExtractionError("pdf_extraction_failed");
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  return typeof value === "object" && value !== null && typeof (value as { str?: unknown }).str === "string";
}

function* normalizedPageCharacters(items: unknown[]): Generator<string> {
  let emittedCharacter = false;
  let pendingWhitespace = false;

  for (const item of items) {
    if (!isPdfTextItem(item)) {
      continue;
    }

    const value = item.str + (item.hasEOL ? "\n" : "");

    for (const character of value) {
      if (/\s/.test(character)) {
        if (emittedCharacter) {
          pendingWhitespace = true;
        }
        continue;
      }

      yield `${pendingWhitespace ? " " : ""}${character}`;
      pendingWhitespace = false;
      emittedCharacter = true;
    }
  }
}

function takeUnicodePrefix(value: string, maxChars: number): string {
  let end = Math.min(maxChars, value.length);
  const endsWithHighSurrogate = end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]);
  const followedByLowSurrogate = end < value.length && /[\uDC00-\uDFFF]/.test(value[end]);

  if (endsWithHighSurrogate && followedByLowSurrogate) {
    end -= 1;
  }

  return value.slice(0, end === 0 ? Math.min(2, value.length) : end);
}

function appendChunkText(chunks: PdfTextChunk[], page: number, value: string, chunkMaxChars: number): void {
  let remaining = value;

  while (remaining.length > 0) {
    const previous = chunks.at(-1);
    const available = previous?.page === page ? chunkMaxChars - previous.text.length : 0;

    if (previous && available > 0) {
      const prefix = takeUnicodePrefix(remaining, available);
      if (prefix.length <= available) {
        previous.text += prefix;
        remaining = remaining.slice(prefix.length);
        continue;
      }
    }

    const prefix = takeUnicodePrefix(remaining, chunkMaxChars);
    chunks.push({ index: chunks.length, page, text: prefix });
    remaining = remaining.slice(prefix.length);
  }
}

async function releasePage(page: PdfPage | undefined): Promise<void> {
  try {
    await page?.cleanup?.();
  } catch {
    // Cleanup failures must not replace the bounded extraction result/error.
  }
}

async function releaseDocument(pdf: PdfDocument | undefined): Promise<void> {
  try {
    await pdf?.cleanup?.();
  } catch {
    // Continue to destroy so PDF.js resources are still released.
  }

  try {
    await pdf?.destroy?.();
  } catch {
    // Cleanup failures must not expose parser details or replace the result.
  }
}

async function extractSequentially(
  buffer: Buffer,
  getDocumentProxy: NonNullable<PdfExtractionOptions["getDocumentProxy"]>,
  config: PdfExtractionConfig,
  signal: AbortSignal
): Promise<PdfExtractionResult> {
  let pdf: PdfDocument | undefined;
  const chunks: PdfTextChunk[] = [];
  let text = "";
  let pagesProcessed = 0;

  try {
    if (signal.aborted) throw abortReason(signal);
    pdf = await getDocumentProxy(Uint8Array.from(buffer), { signal });
    if (signal.aborted) throw abortReason(signal);

    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 0) {
      throw new PdfExtractionError("pdf_invalid");
    }
    if (pdf.numPages > config.maxPages) {
      throw new PdfExtractionError("pdf_page_limit_exceeded");
    }

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (signal.aborted) throw abortReason(signal);
      let page: PdfPage | undefined;

      try {
        page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        if (signal.aborted) throw abortReason(signal);
        if (!content || !Array.isArray(content.items)) {
          throw new PdfExtractionError("pdf_extraction_failed");
        }

        let pageHasText = false;
        for (const normalizedText of normalizedPageCharacters(content.items)) {
          const addition = pageHasText ? normalizedText : `${text.length > 0 ? "\n\n" : ""}${normalizedText}`;
          if (text.length + addition.length > config.extractedTextMaxChars) {
            pagesProcessed = pageNumber;
            return {
              chunks,
              extractedCharacterCount: text.length,
              pageCount: pdf.numPages,
              pagesProcessed,
              status: "partial",
              text,
              truncationReason: "text_limit"
            };
          }

          text += addition;
          appendChunkText(chunks, pageNumber, addition, config.chunkMaxChars);
          pageHasText = true;
        }
        pagesProcessed = pageNumber;
      } finally {
        await releasePage(page);
      }
    }

    return {
      chunks,
      extractedCharacterCount: text.length,
      pageCount: pdf.numPages,
      pagesProcessed,
      status: text.length === 0 ? "no_text" : "complete",
      text
    };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw classifyPdfError(error);
  } finally {
    await releaseDocument(pdf);
  }
}

function runDirectExtraction(
  buffer: Buffer,
  getDocumentProxy: NonNullable<PdfExtractionOptions["getDocumentProxy"]>,
  config: PdfExtractionConfig,
  callerSignal?: AbortSignal
): Promise<PdfExtractionResult> {
  if (callerSignal?.aborted) return Promise.reject(abortReason(callerSignal));
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { error: unknown } | { value: PdfExtractionResult }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onCallerAbort = () => {
      const reason = abortReason(callerSignal as AbortSignal);
      controller.abort(reason);
      finish({ error: reason });
    };
    const timer = setTimeout(() => {
      const error = new PdfExtractionError("pdf_extraction_timeout");
      controller.abort(error);
      finish({ error });
    }, config.timeoutMs);

    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    void extractSequentially(buffer, getDocumentProxy, config, controller.signal).then(
      (value) => finish({ value }),
      (error) => finish({ error })
    );
  });
}

function workerSource(): string {
  return String.raw`
    const { parentPort, workerData } = require("node:worker_threads");

    const ERROR_CODES = new Set([
      "pdf_page_limit_exceeded",
      "pdf_extraction_timeout",
      "pdf_password_required",
      "pdf_invalid",
      "pdf_extraction_failed"
    ]);

    function classify(error) {
      if (error && typeof error === "object" && ERROR_CODES.has(error.code)) return error.code;

      const name = error && typeof error === "object" ? error.name : undefined;
      const code = error && typeof error === "object" ? error.code : undefined;

      if (name === "PasswordException" || code === 1 || code === 2) return "pdf_password_required";
      if (
        name === "InvalidPDFException" ||
        name === "MissingPDFException" ||
        name === "UnexpectedResponseException" ||
        name === "FormatError"
      ) return "pdf_invalid";
      return "pdf_extraction_failed";
    }

    function* normalizedCharacters(items) {
      let emittedCharacter = false;
      let pendingWhitespace = false;

      for (const item of items) {
        if (!item || typeof item !== "object" || typeof item.str !== "string") continue;
        const value = item.str + (item.hasEOL ? "\n" : "");

        for (const character of value) {
          if (/\s/.test(character)) {
            if (emittedCharacter) pendingWhitespace = true;
            continue;
          }
          yield (pendingWhitespace ? " " : "") + character;
          pendingWhitespace = false;
          emittedCharacter = true;
        }
      }
    }

    function appendChunkText(chunks, page, value, chunkMaxChars) {
      let remaining = value;
      while (remaining.length > 0) {
        const previous = chunks.at(-1);
        const available = previous && previous.page === page ? chunkMaxChars - previous.text.length : 0;
        if (previous && available > 0) {
          const prefix = takeUnicodePrefix(remaining, available);
          if (prefix.length <= available) {
            previous.text += prefix;
            remaining = remaining.slice(prefix.length);
            continue;
          }
        }
        const prefix = takeUnicodePrefix(remaining, chunkMaxChars);
        chunks.push({ index: chunks.length, page, text: prefix });
        remaining = remaining.slice(prefix.length);
      }
    }

    function takeUnicodePrefix(value, maxChars) {
      let end = Math.min(maxChars, value.length);
      const endsWithHighSurrogate = end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]);
      const followedByLowSurrogate = end < value.length && /[\uDC00-\uDFFF]/.test(value[end]);
      if (endsWithHighSurrogate && followedByLowSurrogate) end -= 1;
      return value.slice(0, end === 0 ? Math.min(2, value.length) : end);
    }

    async function releasePage(page) {
      try { await page?.cleanup?.(); } catch {}
    }

    async function releaseDocument(pdf) {
      try { await pdf?.cleanup?.(); } catch {}
      try { await pdf?.destroy?.(); } catch {}
    }

    (async () => {
      let pdf;
      const chunks = [];
      let text = "";
      let pagesProcessed = 0;

      try {
        const { getDocumentProxy } = require(workerData.unpdfModulePath);
        pdf = await getDocumentProxy(workerData.bytes);

        if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 0) {
          const error = new Error("pdf_invalid");
          error.code = "pdf_invalid";
          throw error;
        }
        if (pdf.numPages > workerData.config.maxPages) {
          const error = new Error("pdf_page_limit_exceeded");
          error.code = "pdf_page_limit_exceeded";
          throw error;
        }

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          let page;
          try {
            page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            if (!content || !Array.isArray(content.items)) throw new Error("invalid_text_content");

            let pageHasText = false;
            for (const normalizedText of normalizedCharacters(content.items)) {
              const addition = pageHasText ? normalizedText : (text.length > 0 ? "\n\n" : "") + normalizedText;
              if (text.length + addition.length > workerData.config.extractedTextMaxChars) {
                pagesProcessed = pageNumber;
                return {
                  chunks,
                  extractedCharacterCount: text.length,
                  pageCount: pdf.numPages,
                  pagesProcessed,
                  status: "partial",
                  text,
                  truncationReason: "text_limit"
                };
              }
              text += addition;
              appendChunkText(chunks, pageNumber, addition, workerData.config.chunkMaxChars);
              pageHasText = true;
            }
            pagesProcessed = pageNumber;
          } finally {
            await releasePage(page);
          }
        }

        return {
          chunks,
          extractedCharacterCount: text.length,
          pageCount: pdf.numPages,
          pagesProcessed,
          status: text.length === 0 ? "no_text" : "complete",
          text
        };
      } finally {
        await releaseDocument(pdf);
      }
    })().then(
      (result) => parentPort.postMessage({ ok: true, result }),
      (error) => parentPort.postMessage({ error: classify(error), ok: false })
    );
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseWorkerMessage(message: unknown, config: PdfExtractionConfig): PdfExtractionResult {
  if (!isRecord(message) || typeof message.ok !== "boolean") {
    throw new PdfExtractionError("pdf_extraction_failed");
  }

  if (!message.ok) {
    if (
      !hasOnlyKeys(message, ["error", "ok"]) ||
      typeof message.error !== "string" ||
      !PDF_EXTRACTION_ERROR_CODES.has(message.error as PdfExtractionErrorCode)
    ) {
      throw new PdfExtractionError("pdf_extraction_failed");
    }
    throw new PdfExtractionError(message.error as PdfExtractionErrorCode);
  }

  if (!hasOnlyKeys(message, ["ok", "result"]) || !isRecord(message.result)) {
    throw new PdfExtractionError("pdf_extraction_failed");
  }

  const result = message.result;
  const status = result.status;
  const expectedKeys = status === "partial"
    ? ["chunks", "extractedCharacterCount", "pageCount", "pagesProcessed", "status", "text", "truncationReason"]
    : ["chunks", "extractedCharacterCount", "pageCount", "pagesProcessed", "status", "text"];

  if (
    !hasOnlyKeys(result, expectedKeys) ||
    (status !== "complete" && status !== "partial" && status !== "no_text") ||
    typeof result.text !== "string" ||
    result.text.length > config.extractedTextMaxChars ||
    !isNonNegativeSafeInteger(result.extractedCharacterCount) ||
    result.extractedCharacterCount !== result.text.length ||
    !isNonNegativeSafeInteger(result.pageCount) ||
    result.pageCount > config.maxPages ||
    !isNonNegativeSafeInteger(result.pagesProcessed) ||
    result.pagesProcessed > result.pageCount ||
    !Array.isArray(result.chunks) ||
    result.chunks.length > config.extractedTextMaxChars
  ) {
    throw new PdfExtractionError("pdf_extraction_failed");
  }

  if (
    (status === "partial" && result.truncationReason !== "text_limit") ||
    (status !== "partial" && "truncationReason" in result) ||
    (status === "partial" &&
      (result.pageCount === 0 ||
        result.pagesProcessed === 0)) ||
    ((status === "complete" || status === "no_text") && result.pagesProcessed !== result.pageCount) ||
    (status === "no_text" && (result.text !== "" || result.chunks.length !== 0)) ||
    (status === "complete" && result.text.length === 0)
  ) {
    throw new PdfExtractionError("pdf_extraction_failed");
  }

  let combinedText = "";
  let previousPage = 0;

  for (let index = 0; index < result.chunks.length; index += 1) {
    const chunk = result.chunks[index];
    if (
      !isRecord(chunk) ||
      !hasOnlyKeys(chunk, ["index", "page", "text"]) ||
      chunk.index !== index ||
      !Number.isSafeInteger(chunk.page) ||
      (chunk.page as number) < 1 ||
      (chunk.page as number) > result.pageCount ||
      (chunk.page as number) > result.pagesProcessed ||
      (chunk.page as number) < previousPage ||
      typeof chunk.text !== "string" ||
      chunk.text.length === 0 ||
      (chunk.text.length > config.chunkMaxChars &&
        !(config.chunkMaxChars === 1 && chunk.text.length === 2 && Array.from(chunk.text).length === 1))
    ) {
      throw new PdfExtractionError("pdf_extraction_failed");
    }

    previousPage = chunk.page as number;
    combinedText += chunk.text;
    if (combinedText.length > config.extractedTextMaxChars) {
      throw new PdfExtractionError("pdf_extraction_failed");
    }
  }

  if (combinedText !== result.text) {
    throw new PdfExtractionError("pdf_extraction_failed");
  }

  return result as PdfExtractionResult;
}

function runWorkerExtraction(buffer: Buffer, options: NormalizedPdfExtractionOptions): Promise<PdfExtractionResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));

  return new Promise((resolve, reject) => {
    const bytes = Uint8Array.from(buffer);
    let worker: Worker;

    try {
      worker = options.createWorker(workerSource(), {
        eval: true,
        resourceLimits: options.config.workerResourceLimits,
        stderr: true,
        stdout: true,
        transferList: [bytes.buffer],
        workerData: {
          bytes,
          config: {
            chunkMaxChars: options.config.chunkMaxChars,
            extractedTextMaxChars: options.config.extractedTextMaxChars,
            maxPages: options.config.maxPages
          },
          unpdfModulePath: UNPDF_MODULE_PATH
        }
      });
    } catch {
      reject(new PdfExtractionError("pdf_extraction_failed"));
      return;
    }

    worker.stdout?.resume();
    worker.stderr?.resume();

    let settled = false;
    const removeListeners = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      worker.removeListener("message", onMessage);
    };
    const terminate = async () => {
      try {
        await worker.terminate();
      } catch {
        // The stable outcome must not expose worker termination details.
      }
    };
    const finish = async (result: { error: unknown } | { value: PdfExtractionResult }) => {
      if (settled) return;
      settled = true;
      removeListeners();
      await terminate();
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onAbort = () => {
      void finish({ error: abortReason(options.signal as AbortSignal) });
    };
    const onError = () => {
      void finish({ error: new PdfExtractionError("pdf_extraction_failed") });
    };
    const onExit = () => {
      if (!settled) void finish({ error: new PdfExtractionError("pdf_extraction_failed") });
    };
    const onMessage = (message: unknown) => {
      try {
        void finish({ value: parseWorkerMessage(message, options.config) });
      } catch (error) {
        void finish({ error: classifyPdfError(error) });
      }
    };
    const timer = setTimeout(() => {
      void finish({ error: new PdfExtractionError("pdf_extraction_timeout") });
    }, options.config.timeoutMs);

    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.once("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

export function extractPdfTextChunks(
  buffer: Buffer,
  optionsOrChunkMaxChars: PdfExtractionOptions | number = {}
): Promise<PdfExtractionResult> {
  const options = normalizeOptions(optionsOrChunkMaxChars);
  if (options.getDocumentProxy) {
    return runDirectExtraction(buffer, options.getDocumentProxy, options.config, options.signal);
  }
  return runWorkerExtraction(buffer, options);
}
