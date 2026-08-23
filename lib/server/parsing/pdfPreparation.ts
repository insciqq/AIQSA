import { Worker, type WorkerOptions } from "node:worker_threads";
import { resolveRuntimeModulePath } from "../runtimeModulePath";
import { PDF_WORKER_RESOURCE_LIMITS } from "../uploads/pdfConfig";
import { DocumentParserError } from "./errors";
import type { DocumentParserEngine } from "./types";

const PDF_LIB_MODULE_PATH = resolveRuntimeModulePath("pdf-lib");
const UNPDF_MODULE_PATH = resolveRuntimeModulePath("unpdf");
const CANVAS_MODULE_PATH = resolveRuntimeModulePath("@napi-rs/canvas");

export const PDF_MODEL_BATCH_PAGE_COUNT = 2;
export const PDF_MODEL_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PDF_MODEL_MAX_BATCH_IMAGE_BYTES = 16 * 1024 * 1024;
export const PDF_MODEL_MAX_IMAGE_PIXELS = 4_000_000;
export const PDF_MODEL_MAX_IMAGE_WIDTH = 1_800;
export const PDF_MODEL_MAX_IMAGE_HEIGHT = 2_400;
export const PDF_MODEL_PREPARATION_TIMEOUT_MS = 120_000;

export type PdfModelProcessingMode =
  | "system_model_direct_pdf"
  | "system_model_vision";

export type PreparedPdfBatch =
  | Readonly<{
      bytes: Buffer;
      kind: "pdf";
      pageEnd: number;
      pageStart: number;
    }>
  | Readonly<{
      images: readonly Readonly<{
        bytes: Buffer;
        height: number;
        page: number;
        sourceHeight: number;
        sourceWidth: number;
        width: number;
      }>[];
      kind: "images";
      pageEnd: number;
      pageStart: number;
    }>;

type PreparationWorkerOptions = Readonly<{
  createWorker?: (source: string, options: WorkerOptions) => Worker;
  maxPages: number;
  timeoutMs?: number;
}>;

function engine(mode: PdfModelProcessingMode): DocumentParserEngine {
  return mode;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function workerSource(): string {
  return String.raw`
    const { parentPort, workerData } = require("node:worker_threads");

    function boundedPageCount(value) {
      return Number.isSafeInteger(value) && value >= 1 && value <= workerData.maxPages;
    }

    function fail(code) {
      throw Object.assign(new Error(code), { code });
    }

    async function inspect() {
      const { PDFDocument } = require(workerData.pdfLibModulePath);
      const document = await PDFDocument.load(workerData.bytes, {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
        updateMetadata: false
      });
      const pageCount = document.getPageCount();
      if (!boundedPageCount(pageCount)) fail("parser_output_too_large");
      return { kind: "inspect", pageCount };
    }

    async function direct() {
      const { PDFDocument } = require(workerData.pdfLibModulePath);
      const source = await PDFDocument.load(workerData.bytes, {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
        updateMetadata: false
      });
      const pageCount = source.getPageCount();
      if (!boundedPageCount(pageCount)) fail("parser_output_too_large");
      if (workerData.pageStart < 1 || workerData.pageEnd < workerData.pageStart ||
        workerData.pageEnd > pageCount) fail("parser_rejected");
      const target = await PDFDocument.create({ updateMetadata: false });
      const indexes = [];
      for (let page = workerData.pageStart; page <= workerData.pageEnd; page += 1) {
        indexes.push(page - 1);
      }
      const pages = await target.copyPages(source, indexes);
      for (const page of pages) target.addPage(page);
      const bytes = await target.save({ addDefaultPage: false, useObjectStreams: true });
      if (bytes.byteLength < 8 || bytes.byteLength > workerData.maxOutputBytes) {
        fail("parser_output_too_large");
      }
      return { bytes, kind: "pdf", pageCount };
    }

    async function vision() {
      const unpdf = require(workerData.unpdfModulePath);
      let document;
      try {
        const canvasImport = async () => require(workerData.canvasModulePath);
        const CanvasFactory = await unpdf.createIsomorphicCanvasFactory(canvasImport);
        document = await unpdf.getDocumentProxy(workerData.bytes, { CanvasFactory });
        const pageCount = document.numPages;
        if (!boundedPageCount(pageCount)) fail("parser_output_too_large");
        if (workerData.pageStart < 1 || workerData.pageEnd < workerData.pageStart ||
          workerData.pageEnd > pageCount) fail("parser_rejected");
        const images = [];
        let totalBytes = 0;
        for (let pageNumber = workerData.pageStart;
          pageNumber <= workerData.pageEnd; pageNumber += 1) {
          let page;
          let baseViewport;
          try {
            page = await document.getPage(pageNumber);
            baseViewport = page.getViewport({ scale: 1 });
          } finally {
            try { await page?.cleanup?.(); } catch {}
          }
          if (!baseViewport || !Number.isFinite(baseViewport.width) ||
            !Number.isFinite(baseViewport.height) || baseViewport.width <= 0 ||
            baseViewport.height <= 0 || baseViewport.width > 100000 ||
            baseViewport.height > 100000) fail("parser_rejected");
          const scale = Math.min(
            workerData.maxImageWidth / baseViewport.width,
            workerData.maxImageHeight / baseViewport.height,
            Math.sqrt(workerData.maxImagePixels /
              (baseViewport.width * baseViewport.height)),
            2
          );
          if (!Number.isFinite(scale) || scale <= 0) fail("parser_rejected");
          const width = Math.max(1, Math.floor(baseViewport.width * scale));
          const height = Math.max(1, Math.floor(baseViewport.height * scale));
          if (width * height > workerData.maxImagePixels) fail("parser_output_too_large");
          const rendered = await unpdf.renderPageAsImage(document, pageNumber, {
            canvasImport,
            scale
          });
          const bytes = new Uint8Array(rendered);
          if (bytes.byteLength < 8 || bytes.byteLength > workerData.maxImageBytes ||
            bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e ||
            bytes[3] !== 0x47) fail("parser_output_too_large");
          totalBytes += bytes.byteLength;
          if (totalBytes > workerData.maxOutputBytes) fail("parser_output_too_large");
          images.push({
            bytes,
            height,
            page: pageNumber,
            sourceHeight: baseViewport.height,
            sourceWidth: baseViewport.width,
            width
          });
        }
        return { images, kind: "images", pageCount };
      } finally {
        try { await document?.cleanup?.(); } catch {}
        try { await document?.destroy?.(); } catch {}
      }
    }

    Promise.resolve().then(() => {
      if (workerData.operation === "inspect") return inspect();
      if (workerData.operation === "direct") return direct();
      if (workerData.operation === "vision") return vision();
      fail("parser_rejected");
    }).then(
      (result) => parentPort.postMessage({ ok: true, result }),
      (error) => parentPort.postMessage({
        code: error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "parser_rejected",
        ok: false
      })
    );
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonedBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return null;
}

function workerError(message: unknown, mode: PdfModelProcessingMode): DocumentParserError {
  const code = isRecord(message) && message.ok === false &&
    ["parser_output_too_large", "parser_rejected"].includes(String(message.code))
    ? String(message.code) as "parser_output_too_large" | "parser_rejected"
    : "parser_rejected";
  return new DocumentParserError(code, engine(mode));
}

function runPreparationWorker(
  input: Readonly<{
    bytes: Buffer;
    mode: PdfModelProcessingMode;
    operation: "direct" | "inspect" | "vision";
    pageEnd?: number;
    pageStart?: number;
    signal?: AbortSignal;
  }>,
  options: PreparationWorkerOptions
): Promise<unknown> {
  if (input.signal?.aborted) return Promise.reject(abortReason(input.signal));
  return new Promise((resolve, reject) => {
    const transferred = Uint8Array.from(input.bytes);
    let worker: Worker;
    try {
      worker = (options.createWorker ?? ((source, workerOptions) =>
        new Worker(source, workerOptions)))(workerSource(), {
        eval: true,
        resourceLimits: PDF_WORKER_RESOURCE_LIMITS,
        stderr: true,
        stdout: true,
        transferList: [transferred.buffer],
        workerData: {
          bytes: transferred,
          canvasModulePath: CANVAS_MODULE_PATH,
          maxImageBytes: PDF_MODEL_MAX_IMAGE_BYTES,
          maxImageHeight: PDF_MODEL_MAX_IMAGE_HEIGHT,
          maxImagePixels: PDF_MODEL_MAX_IMAGE_PIXELS,
          maxImageWidth: PDF_MODEL_MAX_IMAGE_WIDTH,
          maxOutputBytes: input.operation === "vision"
            ? PDF_MODEL_MAX_BATCH_IMAGE_BYTES
            : Math.max(input.bytes.byteLength + 1024 * 1024, 2 * 1024 * 1024),
          maxPages: options.maxPages,
          operation: input.operation,
          pageEnd: input.pageEnd,
          pageStart: input.pageStart,
          pdfLibModulePath: PDF_LIB_MODULE_PATH,
          unpdfModulePath: UNPDF_MODULE_PATH
        }
      });
    } catch {
      reject(new DocumentParserError("parser_unavailable", engine(input.mode)));
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      worker.removeListener("message", onMessage);
    };
    const finish = async (outcome: { error: unknown } | { value: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      await worker.terminate().catch(() => undefined);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const onAbort = () => void finish({ error: abortReason(input.signal as AbortSignal) });
    const onError = () => void finish({
      error: new DocumentParserError("parser_unavailable", engine(input.mode))
    });
    const onExit = () => {
      if (!settled) void finish({
        error: new DocumentParserError("parser_unavailable", engine(input.mode))
      });
    };
    const onMessage = (message: unknown) => {
      if (!isRecord(message) || message.ok !== true || !isRecord(message.result)) {
        void finish({ error: workerError(message, input.mode) });
        return;
      }
      void finish({ value: message.result });
    };
    const timer = setTimeout(() => void finish({
      error: new DocumentParserError("parser_timeout", engine(input.mode))
    }), options.timeoutMs ?? PDF_MODEL_PREPARATION_TIMEOUT_MS);
    timer.unref?.();
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.once("message", onMessage);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
  });
}

export async function inspectPdfForModelProcessing(
  input: Readonly<{
    bytes: Buffer;
    mode: PdfModelProcessingMode;
    signal?: AbortSignal;
  }>,
  options: PreparationWorkerOptions
): Promise<Readonly<{ pageCount: number }>> {
  if (input.bytes.byteLength < 8 || options.maxPages < 1) {
    throw new DocumentParserError("parser_rejected", engine(input.mode));
  }
  const value = await runPreparationWorker({ ...input, operation: "inspect" }, options);
  if (!isRecord(value) || value.kind !== "inspect" || !Number.isSafeInteger(value.pageCount) ||
    Number(value.pageCount) < 1 || Number(value.pageCount) > options.maxPages) {
    throw new DocumentParserError("parser_invalid_output", engine(input.mode));
  }
  return Object.freeze({ pageCount: Number(value.pageCount) });
}

export async function preparePdfModelBatch(
  input: Readonly<{
    bytes: Buffer;
    mode: PdfModelProcessingMode;
    pageEnd: number;
    pageStart: number;
    signal?: AbortSignal;
  }>,
  options: PreparationWorkerOptions
): Promise<PreparedPdfBatch> {
  if (input.bytes.byteLength < 8 || options.maxPages < 1 ||
    !Number.isSafeInteger(input.pageStart) || !Number.isSafeInteger(input.pageEnd) ||
    input.pageStart < 1 || input.pageEnd < input.pageStart ||
    input.pageEnd - input.pageStart + 1 > PDF_MODEL_BATCH_PAGE_COUNT) {
    throw new DocumentParserError("parser_rejected", engine(input.mode));
  }
  const operation = input.mode === "system_model_direct_pdf" ? "direct" : "vision";
  const value = await runPreparationWorker({ ...input, operation }, options);
  if (!isRecord(value)) {
    throw new DocumentParserError("parser_invalid_output", engine(input.mode));
  }
  if (operation === "direct") {
    const bytes = clonedBytes(value.bytes);
    if (value.kind !== "pdf" || !bytes || bytes.byteLength < 8) {
      throw new DocumentParserError("parser_invalid_output", engine(input.mode));
    }
    return Object.freeze({
      bytes,
      kind: "pdf",
      pageEnd: input.pageEnd,
      pageStart: input.pageStart
    });
  }
  if (value.kind !== "images" || !Array.isArray(value.images) ||
    value.images.length !== input.pageEnd - input.pageStart + 1) {
    throw new DocumentParserError("parser_invalid_output", engine(input.mode));
  }
  const images = value.images.map((entry, index) => {
    const bytes = isRecord(entry) ? clonedBytes(entry.bytes) : null;
    if (!isRecord(entry) || !bytes ||
      entry.page !== input.pageStart + index || !Number.isSafeInteger(entry.width) ||
      !Number.isSafeInteger(entry.height) || Number(entry.width) < 1 ||
      Number(entry.height) < 1 || Number(entry.width) * Number(entry.height) >
      PDF_MODEL_MAX_IMAGE_PIXELS || bytes.byteLength > PDF_MODEL_MAX_IMAGE_BYTES ||
      typeof entry.sourceWidth !== "number" || !Number.isFinite(entry.sourceWidth) ||
      Number(entry.sourceWidth) <= 0 || typeof entry.sourceHeight !== "number" ||
      !Number.isFinite(entry.sourceHeight) || Number(entry.sourceHeight) <= 0) {
      throw new DocumentParserError("parser_invalid_output", engine(input.mode));
    }
    return Object.freeze({
      bytes,
      height: Number(entry.height),
      page: Number(entry.page),
      sourceHeight: Number(entry.sourceHeight),
      sourceWidth: Number(entry.sourceWidth),
      width: Number(entry.width)
    });
  });
  return Object.freeze({
    images: Object.freeze(images),
    kind: "images",
    pageEnd: input.pageEnd,
    pageStart: input.pageStart
  });
}
