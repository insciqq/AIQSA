import { Worker, type WorkerOptions } from "node:worker_threads";
import { resolveRuntimeModulePath } from "../runtimeModulePath";
import { PDF_WORKER_RESOURCE_LIMITS } from "../uploads/pdfConfig";
import {
  finalizeParsedDocument,
  parsedDocumentNeedsFallback,
  parsedLanguageHints
} from "./assessment";
import { DocumentParserError } from "./errors";
import type {
  DocumentParseInput,
  DocumentParserQualityReasonCode,
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedTableCell
} from "./types";

const UNPDF_MODULE_PATH = resolveRuntimeModulePath("unpdf");

export const DEFAULT_NATIVE_PDF_TIMEOUT_MS = 60_000;
export const NATIVE_PDF_MAX_BLOCKS_CEILING = 100_000;
export const NATIVE_PDF_MAX_CELL_COUNT = 32;
export const NATIVE_PDF_MIN_TOTAL_TEXT_CHARACTERS = 32;
export const NATIVE_PDF_MIN_TEXT_CHARACTERS_PER_PAGE = 24;
export const NATIVE_PDF_IMAGE_PAGE_LOW_TEXT_CHARACTERS = 96;
export const NATIVE_PDF_MULTI_GROUP_MIN_ROWS = 3;
export const NATIVE_PDF_MULTI_GROUP_MIN_RATIO = 0.3;
export const NATIVE_PDF_EXCESSIVE_VISUAL_GROUP_COUNT = 8;
export const NATIVE_PDF_FRAGMENTATION_MIN_ROWS = 12;
export const NATIVE_PDF_FRAGMENTATION_MAX_AVERAGE_CHARACTERS = 18;
export const NATIVE_PDF_FRAGMENTATION_MIN_SHORT_ROW_RATIO = 0.65;
export const NATIVE_PDF_INVALID_CHARACTER_MIN_COUNT = 4;
export const NATIVE_PDF_INVALID_CHARACTER_MIN_RATIO = 0.01;

export type NativePdfClassification =
  | "image_only"
  | "image_with_ocr"
  | "mixed"
  | "native_text"
  | "unknown";

type NativePdfCell = Readonly<{
  box: ParsedBoundingBox;
  text: string;
}>;

type NativePdfRow = Readonly<{
  box: ParsedBoundingBox;
  cells: readonly NativePdfCell[];
  page: number;
  text: string;
}>;

export type NativePdfPageMetrics = Readonly<{
  characterCount: number;
  imageCount: number;
  invalidCharacterCount: number;
  invisibleText: boolean;
  maxVisualGroupCount: number;
  multiGroupRowCount: number;
  page: number;
  rowCount: number;
  shortRowCount: number;
}>;

export type NativePdfQualityMetrics = Readonly<{
  pages: readonly NativePdfPageMetrics[];
  visualGroupOverflow: boolean;
}>;

type NativePdfWorkerResult = Readonly<{
  classification: NativePdfClassification;
  pageCount: number;
  pages: readonly NativePdfPageMetrics[];
  rows: readonly NativePdfRow[];
  visualGroupOverflow: boolean;
}>;

export type NativePdfParserOptions = Readonly<{
  createWorker?: (source: string, options: WorkerOptions) => Worker;
  maxBlocks: number;
  maxCharacters: number;
  maxPages: number;
  timeoutMs?: number;
}>;

export type NativePdfGeometry = Readonly<{
  blocks: readonly ParsedDocumentBlock[];
  classification: NativePdfClassification;
  pageCount: number;
  quality: NativePdfQualityMetrics;
}>;

export type NativePdfQualityReasonCode = DocumentParserQualityReasonCode;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function workerSource(): string {
  return String.raw`
    const { parentPort, workerData } = require("node:worker_threads");

    function finite(value) {
      return typeof value === "number" && Number.isFinite(value);
    }

    function textItem(value) {
      return value && typeof value === "object" && typeof value.str === "string" &&
        Array.isArray(value.transform) && value.transform.length === 6 &&
        value.transform.every(finite) && finite(value.width) && finite(value.height);
    }

    function median(values) {
      const sorted = [...values].sort((left, right) => left - right);
      if (sorted.length === 0) return 0;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    }

    function invalidCharacterCount(value) {
      return Array.from(value.matchAll(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/gu
      )).length;
    }

    function normalizedText(value) {
      return value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
    }

    function pageRows(items, pageNumber, maxCells) {
      const validItems = items.filter(textItem);
      const invalidCharacters = validItems.reduce((total, item) =>
        total + invalidCharacterCount(item.str), 0);
      const positioned = validItems.map((item) => {
        const text = normalizedText(item.str);
        const height = Math.max(Math.abs(item.height), Math.abs(item.transform[3]), 1);
        const width = Math.abs(item.width);
        const x0 = item.transform[4];
        const x1 = x0 + width;
        const baseline = item.transform[5];
        return { baseline, height, text, width, x0, x1 };
      }).filter((item) => item.text && item.width > 0);
      positioned.sort((left, right) =>
        right.baseline - left.baseline || left.x0 - right.x0);
      const visualRows = [];
      for (const item of positioned) {
        let closest = null;
        let closestDistance = Infinity;
        for (const row of visualRows.slice(-8)) {
          const distance = Math.abs(row.baseline - item.baseline);
          const tolerance = Math.max(row.height, item.height) * 0.42;
          if (distance <= tolerance && distance < closestDistance) {
            closest = row;
            closestDistance = distance;
          }
        }
        if (closest) {
          closest.items.push(item);
          closest.baseline = closest.items.reduce((sum, value) => sum + value.baseline, 0) /
            closest.items.length;
          closest.height = Math.max(closest.height, item.height);
        } else {
          visualRows.push({ baseline: item.baseline, height: item.height, items: [item] });
        }
      }
      visualRows.sort((left, right) => right.baseline - left.baseline);
      const rows = [];
      let characterCount = 0;
      let maxVisualGroupCount = 0;
      let multiGroupRowCount = 0;
      let shortRowCount = 0;
      let visualGroupOverflow = false;
      for (const row of visualRows) {
        const items = [...row.items].sort((left, right) => left.x0 - right.x0);
        const characterWidths = items.map((item) =>
          item.width / Math.max(Array.from(item.text).length, 1)
        ).filter((value) => finite(value) && value > 0);
        const gapThreshold = Math.max(median(characterWidths) * 2.5, row.height * 0.65, 5);
        const groups = [];
        for (const item of items) {
          const previous = groups.at(-1);
          if (previous && item.x0 - previous.x1 <= gapThreshold) {
            previous.text += " " + item.text;
            previous.x1 = Math.max(previous.x1, item.x1);
            previous.bottom = Math.min(previous.bottom, item.baseline - item.height * 0.2);
            previous.top = Math.max(previous.top, item.baseline + item.height * 0.8);
          } else {
            groups.push({
              bottom: item.baseline - item.height * 0.2,
              text: item.text,
              top: item.baseline + item.height * 0.8,
              x0: item.x0,
              x1: item.x1
            });
          }
        }
        const fullText = groups.map((group) => group.text).join("\t");
        characterCount += fullText.length;
        maxVisualGroupCount = Math.max(maxVisualGroupCount, groups.length);
        if (groups.length > 1) multiGroupRowCount += 1;
        if (fullText.length < 16) shortRowCount += 1;
        if (groups.length > maxCells) {
          visualGroupOverflow = true;
          continue;
        }
        const cells = groups.map((group) => ({
          box: {
            bottom: group.bottom,
            coordinateOrigin: "bottom_left",
            left: group.x0,
            page: pageNumber,
            right: group.x1,
            top: group.top
          },
          text: group.text
        }));
        const box = {
          bottom: Math.min(...cells.map((cell) => cell.box.bottom)),
          coordinateOrigin: "bottom_left",
          left: Math.min(...cells.map((cell) => cell.box.left)),
          page: pageNumber,
          right: Math.max(...cells.map((cell) => cell.box.right)),
          top: Math.max(...cells.map((cell) => cell.box.top))
        };
        rows.push({ box, cells, page: pageNumber, text: fullText });
      }
      return {
        characterCount,
        invalidCharacterCount: invalidCharacters,
        maxVisualGroupCount,
        multiGroupRowCount,
        rowCount: visualRows.length,
        rows,
        shortRowCount,
        visualGroupOverflow
      };
    }

    function classificationFor(pages) {
      const withText = pages.filter((page) => page.characterCount >= 4).length;
      const withImages = pages.filter((page) => page.imageCount > 0).length;
      const withInvisibleText = pages.filter((page) => page.invisibleText).length;
      if (withText === pages.length && withInvisibleText === 0) return "native_text";
      if (withText === 0 && withImages > 0) return "image_only";
      if (withText === pages.length && withInvisibleText > 0 && withImages > 0) {
        return "image_with_ocr";
      }
      if (withText > 0 || withImages > 0) return "mixed";
      return "unknown";
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
      try {
        const unpdf = require(workerData.unpdfModulePath);
        pdf = await unpdf.getDocumentProxy(workerData.bytes);
        const pdfjs = await unpdf.getResolvedPDFJS();
        if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
          throw Object.assign(new Error("parser_rejected"), { code: "parser_rejected" });
        }
        if (pdf.numPages > workerData.limits.maxPages) {
          throw Object.assign(new Error("parser_output_too_large"), {
            code: "parser_output_too_large"
          });
        }
        const pages = [];
        const rows = [];
        let characterCount = 0;
        let invalidCharacterCount = 0;
        let rowCount = 0;
        let visualGroupOverflow = false;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          let page;
          try {
            page = await pdf.getPage(pageNumber);
            const [content, operators] = await Promise.all([
              page.getTextContent(),
              page.getOperatorList()
            ]);
            if (!content || !Array.isArray(content.items) || !operators ||
              !Array.isArray(operators.fnArray) || !Array.isArray(operators.argsArray)) {
              throw Object.assign(new Error("parser_invalid_output"), {
                code: "parser_invalid_output"
              });
            }
            const pageRowsValue = pageRows(
              content.items,
              pageNumber,
              workerData.limits.maxCells
            );
            characterCount += pageRowsValue.characterCount;
            invalidCharacterCount += pageRowsValue.invalidCharacterCount;
            rowCount += pageRowsValue.rowCount;
            if (characterCount + invalidCharacterCount > workerData.limits.maxCharacters ||
              rowCount > workerData.limits.maxBlocks) {
              throw Object.assign(new Error("parser_output_too_large"), {
                code: "parser_output_too_large"
              });
            }
            const imageOps = new Set([
              pdfjs.OPS.paintImageMaskXObject,
              pdfjs.OPS.paintImageXObject,
              pdfjs.OPS.paintInlineImageXObject
            ]);
            const imageCount = operators.fnArray.filter((operation) => imageOps.has(operation)).length;
            const invisibleText = operators.fnArray.some((operation, index) =>
              operation === pdfjs.OPS.setTextRenderingMode &&
              Array.isArray(operators.argsArray[index]) &&
              [3, 7].includes(operators.argsArray[index][0])
            );
            pages.push({
              characterCount: pageRowsValue.characterCount,
              imageCount,
              invalidCharacterCount: pageRowsValue.invalidCharacterCount,
              invisibleText,
              maxVisualGroupCount: pageRowsValue.maxVisualGroupCount,
              multiGroupRowCount: pageRowsValue.multiGroupRowCount,
              page: pageNumber,
              rowCount: pageRowsValue.rowCount,
              shortRowCount: pageRowsValue.shortRowCount
            });
            rows.push(...pageRowsValue.rows);
            visualGroupOverflow ||= pageRowsValue.visualGroupOverflow;
          } finally {
            await releasePage(page);
          }
        }
        return {
          classification: classificationFor(pages),
          pageCount: pdf.numPages,
          pages,
          rows,
          visualGroupOverflow
        };
      } finally {
        await releaseDocument(pdf);
      }
    })().then(
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

function validBox(value: unknown, page: number): value is ParsedBoundingBox {
  return isRecord(value) && value.coordinateOrigin === "bottom_left" && value.page === page &&
    [value.bottom, value.left, value.right, value.top].every((entry) =>
      typeof entry === "number" && Number.isFinite(entry)) &&
    Number(value.left) <= Number(value.right) && Number(value.bottom) <= Number(value.top);
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function parseWorkerResult(
  value: unknown,
  limits: NativePdfParserOptions
): NativePdfWorkerResult {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) {
    const code = isRecord(value) && value.ok === false &&
      ["parser_invalid_output", "parser_output_too_large", "parser_rejected"].includes(
        String(value.code)
      )
      ? String(value.code)
      : "parser_rejected";
    throw new DocumentParserError(code as "parser_invalid_output" | "parser_output_too_large" |
      "parser_rejected", "native_pdf");
  }
  const result = value.result;
  const classifications: readonly NativePdfClassification[] = [
    "image_only",
    "image_with_ocr",
    "mixed",
    "native_text",
    "unknown"
  ];
  if (!classifications.includes(result.classification as NativePdfClassification) ||
    !Number.isSafeInteger(result.pageCount) || Number(result.pageCount) < 1 ||
    Number(result.pageCount) > limits.maxPages || !Array.isArray(result.pages) ||
    result.pages.length !== Number(result.pageCount) || !Array.isArray(result.rows) ||
    result.rows.length > limits.maxBlocks || typeof result.visualGroupOverflow !== "boolean") {
    throw new DocumentParserError("parser_invalid_output", "native_pdf");
  }
  const pages: NativePdfPageMetrics[] = [];
  let metricCharacterCount = 0;
  let metricInvalidCharacterCount = 0;
  let metricRowCount = 0;
  for (const [index, page] of result.pages.entries()) {
    if (!isRecord(page) || page.page !== index + 1 ||
      !boundedInteger(page.characterCount, limits.maxCharacters) ||
      !boundedInteger(page.invalidCharacterCount, limits.maxCharacters) ||
      !boundedInteger(page.imageCount, limits.maxBlocks) ||
      typeof page.invisibleText !== "boolean" ||
      !boundedInteger(page.maxVisualGroupCount, limits.maxCharacters) ||
      !boundedInteger(page.multiGroupRowCount, limits.maxBlocks) ||
      !boundedInteger(page.rowCount, limits.maxBlocks) ||
      !boundedInteger(page.shortRowCount, limits.maxBlocks) ||
      Number(page.multiGroupRowCount) > Number(page.rowCount) ||
      Number(page.shortRowCount) > Number(page.rowCount)) {
      throw new DocumentParserError("parser_invalid_output", "native_pdf");
    }
    metricCharacterCount += Number(page.characterCount);
    metricInvalidCharacterCount += Number(page.invalidCharacterCount);
    metricRowCount += Number(page.rowCount);
    pages.push(Object.freeze({
      characterCount: Number(page.characterCount),
      imageCount: Number(page.imageCount),
      invalidCharacterCount: Number(page.invalidCharacterCount),
      invisibleText: page.invisibleText,
      maxVisualGroupCount: Number(page.maxVisualGroupCount),
      multiGroupRowCount: Number(page.multiGroupRowCount),
      page: Number(page.page),
      rowCount: Number(page.rowCount),
      shortRowCount: Number(page.shortRowCount)
    }));
  }
  if (metricCharacterCount + metricInvalidCharacterCount > limits.maxCharacters ||
    metricRowCount > limits.maxBlocks) {
    throw new DocumentParserError("parser_output_too_large", "native_pdf");
  }
  let characterCount = 0;
  const returnedRowsByPage = new Map<number, number>();
  const rows: NativePdfRow[] = [];
  for (const row of result.rows) {
    if (!isRecord(row) || !Number.isSafeInteger(row.page) || Number(row.page) < 1 ||
      Number(row.page) > Number(result.pageCount) || typeof row.text !== "string" ||
      !row.text.trim() || row.text.length > 32_767 || !validBox(row.box, Number(row.page)) ||
      !Array.isArray(row.cells) || row.cells.length < 1 ||
      row.cells.length > NATIVE_PDF_MAX_CELL_COUNT) {
      throw new DocumentParserError("parser_invalid_output", "native_pdf");
    }
    const cells: NativePdfCell[] = [];
    for (const cell of row.cells) {
      if (!isRecord(cell) || typeof cell.text !== "string" || !cell.text.trim() ||
        cell.text.length > 32_767 || !validBox(cell.box, Number(row.page))) {
        throw new DocumentParserError("parser_invalid_output", "native_pdf");
      }
      cells.push(Object.freeze({ box: Object.freeze({ ...cell.box }), text: cell.text }));
    }
    if (cells.map((cell) => cell.text).join("\t") !== row.text) {
      throw new DocumentParserError("parser_invalid_output", "native_pdf");
    }
    characterCount += row.text.length;
    if (characterCount > limits.maxCharacters) {
      throw new DocumentParserError("parser_output_too_large", "native_pdf");
    }
    rows.push(Object.freeze({
      box: Object.freeze({ ...row.box }),
      cells: Object.freeze(cells),
      page: Number(row.page),
      text: row.text
    }));
    returnedRowsByPage.set(
      Number(row.page),
      (returnedRowsByPage.get(Number(row.page)) ?? 0) + 1
    );
  }
  if (characterCount > metricCharacterCount || pages.some((page) =>
    (returnedRowsByPage.get(page.page) ?? 0) > page.rowCount) ||
    (!result.visualGroupOverflow && rows.length !== metricRowCount)) {
    throw new DocumentParserError("parser_invalid_output", "native_pdf");
  }
  return Object.freeze({
    classification: result.classification as NativePdfClassification,
    pageCount: Number(result.pageCount),
    pages: Object.freeze(pages),
    rows: Object.freeze(rows),
    visualGroupOverflow: result.visualGroupOverflow
  });
}

function rowBlock(row: NativePdfRow, index: number): ParsedDocumentBlock {
  const tableCells: ParsedTableCell[] = row.cells.map((cell, column) => Object.freeze({
    column,
    columnSpan: 1,
    row: 0,
    rowSpan: 1,
    text: cell.text
  }));
  const isTable = row.cells.length > 1;
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([row.box]),
    headingPath: Object.freeze([]),
    index,
    isTable,
    languageHints: parsedLanguageHints(row.text),
    page: row.page,
    pageEnd: row.page,
    readingOrder: index,
    table: isTable
      ? Object.freeze({
          cells: Object.freeze(tableCells),
          columnCount: row.cells.length,
          rowCount: 1
        })
      : null,
    text: row.text,
    type: isTable ? "table" : "paragraph"
  });
}

function nativePdfQualityReason(
  geometry: NativePdfGeometry,
  document: ParsedDocument
): NativePdfQualityReasonCode | null {
  const pages = geometry.quality.pages;
  const characterCount = pages.reduce((total, page) => total + page.characterCount, 0);
  const invalidCharacterCount = pages.reduce((total, page) =>
    total + page.invalidCharacterCount, 0);
  const rowCount = pages.reduce((total, page) => total + page.rowCount, 0);
  const shortRowCount = pages.reduce((total, page) => total + page.shortRowCount, 0);
  const multiGroupRowCount = pages.reduce((total, page) =>
    total + page.multiGroupRowCount, 0);

  if (geometry.quality.visualGroupOverflow) {
    return "native_pdf_visual_group_overflow";
  }
  if (invalidCharacterCount >= NATIVE_PDF_INVALID_CHARACTER_MIN_COUNT &&
    invalidCharacterCount /
      Math.max(1, characterCount + invalidCharacterCount) >=
        NATIVE_PDF_INVALID_CHARACTER_MIN_RATIO) {
    return "native_pdf_invalid_text_characters";
  }
  if (pages.some((page) =>
    page.imageCount > 0 && page.characterCount < NATIVE_PDF_IMAGE_PAGE_LOW_TEXT_CHARACTERS) ||
    geometry.classification === "image_only" || geometry.classification === "image_with_ocr") {
    return "native_pdf_image_heavy_low_text";
  }
  const coveredPages = pages.filter((page) => page.characterCount >= 16).length;
  if (characterCount < NATIVE_PDF_MIN_TOTAL_TEXT_CHARACTERS ||
    characterCount / Math.max(1, geometry.pageCount) <
      NATIVE_PDF_MIN_TEXT_CHARACTERS_PER_PAGE ||
    coveredPages / Math.max(1, geometry.pageCount) < 0.75) {
    return "native_pdf_low_text_density";
  }
  if (pages.some((page) =>
    page.maxVisualGroupCount >= NATIVE_PDF_EXCESSIVE_VISUAL_GROUP_COUNT)) {
    return "native_pdf_excessive_visual_groups";
  }
  if (multiGroupRowCount >= NATIVE_PDF_MULTI_GROUP_MIN_ROWS &&
    multiGroupRowCount / Math.max(1, rowCount) >= NATIVE_PDF_MULTI_GROUP_MIN_RATIO) {
    return "native_pdf_possible_multi_column";
  }
  if (rowCount >= NATIVE_PDF_FRAGMENTATION_MIN_ROWS &&
    characterCount / Math.max(1, rowCount) <
      NATIVE_PDF_FRAGMENTATION_MAX_AVERAGE_CHARACTERS &&
    shortRowCount / Math.max(1, rowCount) >= NATIVE_PDF_FRAGMENTATION_MIN_SHORT_ROW_RATIO) {
    return "native_pdf_excessive_fragmentation";
  }
  if (geometry.classification !== "native_text") {
    return "native_pdf_non_simple_layout";
  }
  if (parsedDocumentNeedsFallback(document)) return "native_pdf_quality_failure";
  return null;
}

function runWorker(
  bytes: Buffer,
  options: NativePdfParserOptions,
  signal?: AbortSignal
): Promise<NativePdfWorkerResult> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const transferred = Uint8Array.from(bytes);
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
          limits: {
            maxBlocks: options.maxBlocks,
            maxCells: NATIVE_PDF_MAX_CELL_COUNT,
            maxCharacters: options.maxCharacters,
            maxPages: options.maxPages
          },
          unpdfModulePath: UNPDF_MODULE_PATH
        }
      });
    } catch {
      reject(new DocumentParserError("parser_unavailable", "native_pdf"));
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      worker.removeListener("message", onMessage);
    };
    const finish = async (outcome: { error: unknown } | { result: NativePdfWorkerResult }) => {
      if (settled) return;
      settled = true;
      cleanup();
      await worker.terminate().catch(() => undefined);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.result);
    };
    const onAbort = () => void finish({ error: abortReason(signal as AbortSignal) });
    const onError = () => void finish({
      error: new DocumentParserError("parser_unavailable", "native_pdf")
    });
    const onExit = () => {
      if (!settled) void finish({
        error: new DocumentParserError("parser_unavailable", "native_pdf")
      });
    };
    const onMessage = (message: unknown) => {
      try {
        void finish({ result: parseWorkerResult(message, options) });
      } catch (error) {
        void finish({ error });
      }
    };
    const timer = setTimeout(() => void finish({
      error: new DocumentParserError("parser_timeout", "native_pdf")
    }), options.timeoutMs ?? DEFAULT_NATIVE_PDF_TIMEOUT_MS);
    timer.unref?.();
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.once("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function parseNativeTextPdf(
  input: DocumentParseInput,
  options: NativePdfParserOptions
): Promise<Readonly<{
  classification: NativePdfClassification;
  document: ParsedDocument | null;
  reasonCode: NativePdfQualityReasonCode | null;
}>> {
  const geometry = await extractNativePdfGeometry(input, options);
  const document = finalizeParsedDocument({
    attempts: Object.freeze([{
      engine: "native_pdf",
      errorCode: null,
      outcome: "complete"
    }]),
    blocks: geometry.blocks,
    engine: "native_pdf",
    mediaType: "application/pdf",
    pageCount: geometry.pageCount,
    status: "complete"
  });
  const reasonCode = nativePdfQualityReason(geometry, document);
  return reasonCode
    ? Object.freeze({ classification: geometry.classification, document: null, reasonCode })
    : Object.freeze({ classification: geometry.classification, document, reasonCode: null });
}

/** Bounded native-text and geometry extraction. Model-PDF profiles before the
 * collaboration profile use only its boxes. Newer profiles may admit clean,
 * visible unmatched rows through the separately bounded merge policy. */
export async function extractNativePdfGeometry(
  input: DocumentParseInput,
  options: NativePdfParserOptions
): Promise<NativePdfGeometry> {
  if (input.bytes.byteLength === 0 || options.maxBlocks < 1 ||
    options.maxBlocks > NATIVE_PDF_MAX_BLOCKS_CEILING || options.maxCharacters < 1 ||
    options.maxPages < 1) {
    throw new DocumentParserError("parser_rejected", "native_pdf");
  }
  const result = await runWorker(input.bytes, options, input.signal);
  return Object.freeze({
    blocks: Object.freeze(result.rows.map(rowBlock)),
    classification: result.classification,
    pageCount: result.pageCount,
    quality: Object.freeze({
      pages: result.pages,
      visualGroupOverflow: result.visualGroupOverflow
    })
  });
}
