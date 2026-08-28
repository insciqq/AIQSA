import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import { DocumentParserError } from "./errors";
import type { PdfModelProcessingMode } from "./pdfPreparation";
import type {
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedDocumentBlockType,
  ParsedTable
} from "./types";

export const MODEL_PDF_OUTPUT_MAX_CHARACTERS_PER_BATCH = 500_000;
export const MODEL_PDF_OUTPUT_MAX_LINES_PER_PAGE = 20_000;
export const MODEL_PDF_PROMPT_VERSION = 5;
export const MODEL_PDF_ROW_CONTINUATION_CELL = "[[AIQSA_ROW_CONTINUATION]]";

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
  promptVersion?: 1 | 2 | 3 | 4 | 5;
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
    ...(promptVersion === 4 ? [
      "Emit each table as logical rows with one stable tab-separated column order. When a " +
        "visibly merged cell spans multiple rows or columns, repeat its exact text in every " +
        "logical output cell covered by that span so each row retains its complete identity. " +
        "Keep genuinely empty, non-spanning cells empty, and never infer a span from wording."
    ] : []),
    ...(promptVersion >= 5 ? [
      "Emit each table as logical rows with one stable tab-separated column order. A logical " +
        "record may occupy multiple physical rows. In every cell that continues the value " +
        `directly above, write exactly ${MODEL_PDF_ROW_CONTINUATION_CELL}. ` +
        "Use it for a visually merged row span and for a leading record identity shown once " +
        "while aligned subordinate rows remain in that same record. Continue only until the " +
        "next peer value or visible separator. Decide from layout (borders, alignment, " +
        "indentation, and repeated row pattern), never from the language or meaning of labels. " +
        "Leave genuinely empty cells empty."
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

function tablePatternCell(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
}

type RegularRowGroup = Readonly<{ starts: readonly number[]; stride: number }>;

function regularRowGroups(
  anchors: readonly number[],
  rowCount: number
): readonly RegularRowGroup[] {
  // Only adjacent equal-stride anchor runs can describe a regular record grid.
  // Scanning runs keeps the fallback proportional to the parsed table instead
  // of comparing every anchor pair in the 20,000-line provider-output budget.
  const groups: RegularRowGroup[] = [];
  let startIndex = 0;
  while (startIndex + 2 < anchors.length) {
    const stride = anchors[startIndex + 1]! - anchors[startIndex]!;
    let endIndex = startIndex + 2;
    while (endIndex < anchors.length &&
      anchors[endIndex]! - anchors[endIndex - 1]! === stride) endIndex += 1;
    const starts = anchors.slice(startIndex, endIndex);
    if (stride >= 2 && starts.length >= 3 && starts.at(-1)! + stride === rowCount) {
      groups.push(Object.freeze({ starts: Object.freeze(starts), stride }));
    }
    startIndex = endIndex - 1;
  }
  return Object.freeze(groups);
}

function validRegularGroupSuffix(
  group: RegularRowGroup,
  valid: (start: number) => boolean
): RegularRowGroup | null {
  let firstValid = group.starts.length;
  while (firstValid > 0 && valid(group.starts[firstValid - 1]!)) firstValid -= 1;
  const starts = group.starts.slice(firstValid);
  return starts.length >= 3
    ? Object.freeze({ starts: Object.freeze(starts), stride: group.stride })
    : null;
}

function restoreTrimmedLeadingTableCells(
  rows: readonly (readonly string[])[]
): string[][] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const restored = rows.map((row) =>
    Array.from({ length: columnCount }, (_, column) => row[column] ?? ""));
  if (columnCount < 3) return restored;
  const fullRows = restored.flatMap((row, rowIndex) =>
    row.every((cell) => Boolean(cell)) ? [rowIndex] : []);
  let best: Readonly<{ repeatedOffsets: number; starts: readonly number[]; stride: number }> |
    null = null;
  for (const rawGroup of regularRowGroups(fullRows, restored.length)) {
    const group = validRegularGroupSuffix(rawGroup, (start) => {
      if (!restored[start]?.every((cell) => Boolean(cell))) return false;
      for (let offset = 1; offset < rawGroup.stride; offset += 1) {
        const row = restored[start + offset];
        if (!row || row.at(-1) || !row.slice(0, -1).every((cell) => Boolean(cell))) {
          return false;
        }
      }
      return true;
    });
    if (!group) continue;
    let repeatedOffsets = 0;
    for (let offset = 0; offset < group.stride; offset += 1) {
      const comparableColumns = offset === 0
        ? Array.from({ length: columnCount }, (_, column) => column)
        : Array.from({ length: columnCount - 1 }, (_, column) => column);
      if (comparableColumns.some((column) => {
        const values = group.starts.map((start) =>
          tablePatternCell(restored[start + offset]?.[column] ?? ""));
        return values.every((value) => value && /[\p{L}\p{M}]/u.test(value)) &&
          new Set(values).size === 1;
      })) repeatedOffsets += 1;
    }
    if (repeatedOffsets < Math.max(2, Math.ceil(group.stride / 2))) continue;
    if (!best || group.starts.length > best.starts.length ||
      group.starts.length === best.starts.length && repeatedOffsets > best.repeatedOffsets) {
      best = Object.freeze({ ...group, repeatedOffsets });
    }
  }
  if (!best) return restored;
  for (const start of best.starts) {
    for (let offset = 1; offset < best.stride; offset += 1) {
      const row = restored[start + offset]!;
      for (let column = columnCount - 1; column > 0; column -= 1) {
        row[column] = row[column - 1]!;
      }
      row[0] = "";
    }
  }
  return restored;
}

function inferRegularRowGroupContinuations(
  rows: readonly (readonly string[])[]
): readonly (readonly string[])[] {
  const completed = restoreTrimmedLeadingTableCells(rows);
  const columnCount = Math.max(...completed.map((row) => row.length));
  for (let column = 0; column < columnCount - 1; column += 1) {
    const anchors = completed.flatMap((row, rowIndex) => {
      const value = row[column]!;
      return value && value !== MODEL_PDF_ROW_CONTINUATION_CELL &&
        row.slice(column + 1).some((cell) => Boolean(cell))
        ? [rowIndex]
        : [];
    });
    let best: Readonly<{ repeatedOffsets: number; starts: readonly number[]; stride: number }> |
      null = null;
    for (const rawGroup of regularRowGroups(anchors, completed.length)) {
      const group = validRegularGroupSuffix(rawGroup, (start) => {
        const anchor = completed[start]?.[column] ?? "";
        if (!anchor || anchor === MODEL_PDF_ROW_CONTINUATION_CELL) return false;
        for (let offset = 1; offset < rawGroup.stride; offset += 1) {
          const row = completed[start + offset];
          if (!row || row[column] && row[column] !== MODEL_PDF_ROW_CONTINUATION_CELL ||
            !row.slice(column + 1).some((cell) => Boolean(cell))) return false;
        }
        return true;
      });
      if (!group || !group.starts.some((start) =>
        /[\p{L}\p{M}]/u.test(completed[start]?.[column] ?? ""))) continue;
      let repeatedOffsets = 0;
      for (let offset = 0; offset < group.stride; offset += 1) {
        const hasRepeatedLabel = Array.from(
          { length: columnCount - column - 1 },
          (_, suffixOffset) => column + suffixOffset + 1
        ).some((suffixColumn) => {
          const values = group.starts.map((start) =>
            tablePatternCell(completed[start + offset]?.[suffixColumn] ?? ""));
          return values.every((value) => value && /[\p{L}\p{M}]/u.test(value)) &&
            new Set(values).size === 1;
        });
        if (hasRepeatedLabel) repeatedOffsets += 1;
      }
      if (repeatedOffsets < Math.max(2, Math.ceil(group.stride / 2))) continue;
      if (!best || group.starts.length > best.starts.length ||
        group.starts.length === best.starts.length && repeatedOffsets > best.repeatedOffsets) {
        best = Object.freeze({ ...group, repeatedOffsets });
      }
    }
    if (!best) continue;
    for (const start of best.starts) {
      for (let offset = 1; offset < best.stride; offset += 1) {
        if (!completed[start + offset]![column]) {
          completed[start + offset]![column] = MODEL_PDF_ROW_CONTINUATION_CELL;
        }
      }
    }
  }
  return Object.freeze(completed.map((row) => Object.freeze(row)));
}

type MutableParsedTableCell = {
  column: number;
  columnSpan: number;
  row: number;
  rowSpan: number;
  text: string;
};

function tableFor(
  rows: readonly (readonly string[])[],
  input: Readonly<{
    continuationMarkers: boolean;
    mode: PdfModelProcessingMode;
  }>
): ParsedTable {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const cells: MutableParsedTableCell[] = [];
  const verticalAnchors = Array<MutableParsedTableCell | null>(columnCount).fill(null);
  rows.forEach((row, rowIndex) => {
    for (let column = 0; column < columnCount; column += 1) {
      const rawText = row[column] ?? "";
      if (input.continuationMarkers && rawText === MODEL_PDF_ROW_CONTINUATION_CELL) {
        const anchor = verticalAnchors[column];
        if (anchor?.text && anchor.row + anchor.rowSpan === rowIndex) {
          anchor.rowSpan += 1;
          continue;
        }
      }
      // The marker is synthetic parser control, not source evidence. A vision
      // model can occasionally use it for a horizontal span or at a page-local
      // table boundary where no vertical anchor exists. Preserve the rest of
      // the table and degrade only that unresolvable control cell to empty.
      const text = rawText === MODEL_PDF_ROW_CONTINUATION_CELL ? "" : rawText;
      const cell: MutableParsedTableCell = {
        column,
        columnSpan: 1,
        row: rowIndex,
        rowSpan: 1,
        text
      };
      cells.push(cell);
      verticalAnchors[column] = text ? cell : null;
    }
  });
  return Object.freeze({
    cells: Object.freeze(cells.map((cell) => Object.freeze(cell))),
    columnCount,
    rowCount: rows.length
  });
}

function tableText(table: ParsedTable): string {
  const rows = Array.from(
    { length: table.rowCount },
    () => Array<string>(table.columnCount).fill("")
  );
  for (const cell of table.cells) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      rows[row]![cell.column] = cell.text;
    }
  }
  return rows.map((row) => row.join("\t").trimEnd()).filter(Boolean).join("\n");
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
  firstIndex: number,
  input: Readonly<{
    continuationMarkers: boolean;
    mode: PdfModelProcessingMode;
  }>
): ParsedDocumentBlock[] {
  const lines = page.text.split("\n").filter((line) => Boolean(line.trim()));
  const blocks: ParsedDocumentBlock[] = [];
  const headingPath: string[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const rawLine = lines[lineIndex]!;
    const line = rawLine.trim();
    const cells = rowCells(rawLine);
    if (cells) {
      const rows: string[][] = [];
      while (lineIndex < lines.length) {
        const next = rowCells(lines[lineIndex]!);
        if (!next) break;
        if (!delimiterRow(next)) rows.push(next);
        lineIndex += 1;
      }
      if (rows.length > 0) {
        const table = tableFor(
          input.continuationMarkers ? inferRegularRowGroupContinuations(rows) : rows,
          input
        );
        blocks.push(block({
          headingPath,
          index: firstIndex + blocks.length,
          page: page.page,
          table,
          text: tableText(table),
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
  tableContinuationMarkers?: boolean;
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
    blocks.push(...pageBlocks(page, blocks.length, {
      continuationMarkers: input.tableContinuationMarkers === true,
      mode: input.mode
    }));
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
