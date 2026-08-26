import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import { DocumentParserError } from "./errors";
import type { PdfModelProcessingMode } from "./pdfPreparation";
import type {
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedDocumentBlockType,
  ParsedTable,
  ParsedTableCell
} from "./types";

export const MODEL_PDF_OUTPUT_MAX_CHARACTERS_PER_BATCH = 500_000;
export const MODEL_PDF_OUTPUT_MAX_LINES_PER_PAGE = 20_000;
export const MODEL_PDF_PROMPT_VERSION = 3;

export type DecodedModelPdfPage = Readonly<{
  page: number;
  text: string;
}>;

function pageToken(page: number): string {
  return String(page).padStart(6, "0");
}

export function modelPdfPageStartMarker(page: number): string {
  return `<<<AIQSA_PAGE_${pageToken(page)}>>>`;
}

export function modelPdfPageEndMarker(page: number): string {
  return `<<<AIQSA_END_PAGE_${pageToken(page)}>>>`;
}

export function modelPdfTranscriptionPrompt(input: Readonly<{
  mode: PdfModelProcessingMode;
  pageEnd: number;
  pageStart: number;
  promptVersion?: 1 | 2 | 3;
}>): string {
  const sections: string[] = [];
  for (let page = input.pageStart; page <= input.pageEnd; page += 1) {
    sections.push(`${modelPdfPageStartMarker(page)}\n[page ${page} transcription]\n${modelPdfPageEndMarker(page)}`);
  }
  const attachmentDescription = input.mode === "system_model_direct_pdf"
    ? `The attached PDF contains original pages ${input.pageStart}-${input.pageEnd} in order.`
    : `The attached images are original pages ${input.pageStart}-${input.pageEnd} in order.`;
  const promptVersion = input.promptVersion ?? MODEL_PDF_PROMPT_VERSION;
  return [
    "Faithfully transcribe the attached document pages for a private search index.",
    attachmentDescription,
    "Do not summarize, interpret, correct, calculate, or omit content.",
    "Preserve headings, labels, values, units, footnotes, and reading order.",
    "Write table rows as tab-separated cells. Keep a label and its value on the same row.",
    ...(promptVersion >= 2 ? [
      "Transcribe every visible row and every non-empty table cell, including repeated labels, " +
        "small print, decimal separators, signs, and superscripts; never replace content with " +
        "ellipsis, ditto marks, or a summary.",
      "Read each number character by character. If a character truly cannot be read, write " +
        "[ILLEGIBLE] at that exact position instead of guessing a value."
    ] : []),
    ...(promptVersion >= 3 && input.mode === "system_model_vision" ? [
      "Inspect the supplied original-detail page image at full resolution before transcribing. " +
        "Zoom into dense tables, scans, and small labels instead of relying on a reduced overview."
    ] : []),
    "For an empty page, write [BLANK PAGE].",
    "Return only the following page sections, once each and in this exact order:",
    sections.join("\n")
  ].join("\n\n");
}

function parserError(mode: PdfModelProcessingMode): DocumentParserError {
  return new DocumentParserError("parser_invalid_output", mode);
}

function exactResponseBody(text: string): string {
  const fenced = /^\s*```(?:markdown|text)?[ \t]*\n([\s\S]*?)\n```\s*$/u.exec(text);
  return fenced?.[1] ?? text;
}

export function decodeModelPdfBatchOutput(input: Readonly<{
  mode: PdfModelProcessingMode;
  pageEnd: number;
  pageStart: number;
  text: string;
}>): readonly DecodedModelPdfPage[] {
  if (input.text.length < 1 || input.text.length > MODEL_PDF_OUTPUT_MAX_CHARACTERS_PER_BATCH ||
    /[\u0000\uFFFD]/u.test(input.text)) throw parserError(input.mode);
  const responseBody = exactResponseBody(input.text);
  let cursor = 0;
  const pages: DecodedModelPdfPage[] = [];
  for (let page = input.pageStart; page <= input.pageEnd; page += 1) {
    const start = modelPdfPageStartMarker(page);
    const end = modelPdfPageEndMarker(page);
    const startIndex = responseBody.indexOf(start, cursor);
    if (startIndex < 0 || responseBody.slice(cursor, startIndex).trim()) {
      throw parserError(input.mode);
    }
    const contentStart = startIndex + start.length;
    const endIndex = responseBody.indexOf(end, contentStart);
    if (endIndex < 0 || responseBody.indexOf(start, contentStart) >= 0 &&
      responseBody.indexOf(start, contentStart) < endIndex) {
      throw parserError(input.mode);
    }
    const text = responseBody.slice(contentStart, endIndex).replace(/\r\n?/gu, "\n").trim();
    if (!text || text.split("\n").length > MODEL_PDF_OUTPUT_MAX_LINES_PER_PAGE) {
      throw parserError(input.mode);
    }
    pages.push(Object.freeze({
      page,
      text: text === "[BLANK PAGE]" ? "" : text
    }));
    cursor = endIndex + end.length;
  }
  if (responseBody.slice(cursor).trim()) throw parserError(input.mode);
  return Object.freeze(pages);
}

function normalizedCell(value: string): string {
  return value.replace(/\\\|/gu, "|").replace(/\s+/gu, " ").trim();
}

function markdownCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split(/(?<!\\)\|/u).map(normalizedCell);
  return cells.length > 1 && cells.some(Boolean) ? cells : null;
}

function delimiterRow(cells: readonly string[]): boolean {
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function rowCells(line: string): string[] | null {
  if (line.includes("\t")) {
    const cells = line.split("\t").map(normalizedCell);
    return cells.length > 1 && cells.some(Boolean) ? cells : null;
  }
  return markdownCells(line);
}

function tableFor(rows: readonly (readonly string[])[]): ParsedTable {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const cells: ParsedTableCell[] = [];
  rows.forEach((row, rowIndex) => {
    for (let column = 0; column < columnCount; column += 1) {
      cells.push(Object.freeze({
        column,
        columnSpan: 1,
        row: rowIndex,
        rowSpan: 1,
        text: row[column] ?? ""
      }));
    }
  });
  return Object.freeze({
    cells: Object.freeze(cells),
    columnCount,
    rowCount: rows.length
  });
}

function block(input: Readonly<{
  headingPath: readonly string[];
  index: number;
  page: number;
  table?: ParsedTable | null;
  text: string;
  type: ParsedDocumentBlockType;
}>): ParsedDocumentBlock {
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([]),
    headingPath: Object.freeze([...input.headingPath]),
    index: input.index,
    isTable: input.type === "table",
    languageHints: parsedLanguageHints(input.text),
    page: input.page,
    pageEnd: input.page,
    readingOrder: input.index,
    table: input.table ?? null,
    text: input.text,
    type: input.type
  });
}

function pageBlocks(
  page: DecodedModelPdfPage,
  firstIndex: number
): ParsedDocumentBlock[] {
  const lines = page.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const blocks: ParsedDocumentBlock[] = [];
  const headingPath: string[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!;
    const cells = rowCells(line);
    if (cells) {
      const rows: string[][] = [];
      while (lineIndex < lines.length) {
        const next = rowCells(lines[lineIndex]!);
        if (!next) break;
        if (!delimiterRow(next)) rows.push(next);
        lineIndex += 1;
      }
      if (rows.length > 0) {
        const table = tableFor(rows);
        blocks.push(block({
          headingPath,
          index: firstIndex + blocks.length,
          page: page.page,
          table,
          text: rows.map((row) => row.join("\t")).join("\n"),
          type: "table"
        }));
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      headingPath.splice(level - 1);
      headingPath[level - 1] = text;
      blocks.push(block({
        headingPath: headingPath.slice(0, level - 1),
        index: firstIndex + blocks.length,
        page: page.page,
        text,
        type: level === 1 ? "title" : "heading"
      }));
    } else {
      blocks.push(block({
        headingPath,
        index: firstIndex + blocks.length,
        page: page.page,
        text: line,
        type: /^[-*•]\s+/u.test(line) ? "list_item" : "paragraph"
      }));
    }
    lineIndex += 1;
  }
  return blocks;
}

export function modelPdfPagesToDocument(input: Readonly<{
  maxBlocks: number;
  maxCharacters: number;
  mode: PdfModelProcessingMode;
  pageCount: number;
  pages: readonly DecodedModelPdfPage[];
}>): ParsedDocument {
  if (input.pages.length !== input.pageCount || input.pages.some((page, index) =>
    page.page !== index + 1)) throw parserError(input.mode);
  const blocks: ParsedDocumentBlock[] = [];
  let characterCount = 0;
  for (const page of input.pages) {
    characterCount += page.text.length;
    if (characterCount > input.maxCharacters) {
      throw new DocumentParserError("parser_output_too_large", input.mode);
    }
    blocks.push(...pageBlocks(page, blocks.length));
    if (blocks.length > input.maxBlocks) {
      throw new DocumentParserError("parser_output_too_large", input.mode);
    }
  }
  if (blocks.length === 0) throw parserError(input.mode);
  return finalizeParsedDocument({
    attempts: [{ engine: input.mode, errorCode: null, outcome: "complete" }],
    blocks,
    engine: input.mode,
    mediaType: "application/pdf",
    pageCount: input.pageCount,
    status: "complete"
  });
}
