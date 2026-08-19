import { read, utils, type CellObject, type WorkBook, type WorkSheet } from "xlsx";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import { DocumentParserError } from "./errors";
import {
  SPREADSHEET_MAX_CELL_TEXT,
  SPREADSHEET_MAX_COLUMNS_PER_SHEET,
  SPREADSHEET_MAX_FORMULA_TEXT,
  SPREADSHEET_MAX_MERGES_PER_SHEET,
  SPREADSHEET_MAX_POPULATED_CELLS,
  SPREADSHEET_MAX_REGIONS_PER_SHEET,
  SPREADSHEET_MAX_ROWS_PER_SHEET,
  SPREADSHEET_MAX_SHEETS,
  SPREADSHEET_MAX_UNCOMPRESSED_BYTES
} from "./spreadsheetLimits";
import {
  spreadsheetDateFromSerial,
  spreadsheetFormatIsDate
} from "./spreadsheetDate";
import type {
  DocumentParseInput,
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedTable,
  ParsedWorkbook,
  ParsedWorkbookCell,
  ParsedWorkbookRange,
  ParsedWorkbookRegion,
  ParsedWorkbookSheet,
  ParsedWorkbookWarningCode
} from "./types";

const MAX_ZIP_ENTRIES = 20_000;
const MAX_ZIP_ENTRY_BYTES = 64 * 1_024 * 1_024;
const MAX_ZIP_COMPRESSION_RATIO = 2_000;
const BLOCK_ROW_COUNT = 200;
const BLOCK_COLUMN_COUNT = 50;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

type DenseWorksheet = WorkSheet & Readonly<{
  "!data"?: readonly (readonly (CellObject | undefined)[] | undefined)[];
  "!fullref"?: string;
}>;

function rejected(): never {
  throw new DocumentParserError("parser_rejected");
}

function outputTooLarge(): never {
  throw new DocumentParserError("parser_output_too_large");
}

function isZipFormat(fileName: string): boolean {
  const extension = fileName.toLocaleLowerCase("und");
  return extension.endsWith(".xlsx") || extension.endsWith(".ods");
}

/**
 * SheetJS must inflate OOXML/ODS packages before it can decode cells. Inspect
 * the central directory first so compressed input cannot claim unbounded
 * application memory. ZIP64 and encrypted entries are deliberately rejected.
 */
export function assertBoundedSpreadsheetArchive(bytes: Buffer): void {
  if (bytes.byteLength < 22) rejected();
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.byteLength) rejected();
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    entryCount < 1 || entryCount === 0xffff || entryCount > MAX_ZIP_ENTRIES ||
    centralSize === 0xffffffff || centralOffset === 0xffffffff ||
    centralOffset + centralSize > eocd
  ) outputTooLarge();

  let offset = centralOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      rejected();
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    if (
      (flags & 0x0001) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff ||
      uncompressed > MAX_ZIP_ENTRY_BYTES ||
      compressed === 0 && uncompressed > 0 ||
      compressed > 0 && uncompressed / compressed > MAX_ZIP_COMPRESSION_RATIO
    ) outputTooLarge();
    uncompressedTotal += uncompressed;
    if (uncompressedTotal > SPREADSHEET_MAX_UNCOMPRESSED_BYTES) outputTooLarge();
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > centralOffset + centralSize) rejected();
  }
  if (offset !== centralOffset + centralSize) rejected();
}

function cleanText(value: string, maximum = SPREADSHEET_MAX_CELL_TEXT): Readonly<{
  text: string;
  truncated: boolean;
}> {
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/\u0000/gu, "");
  return normalized.length > maximum
    ? { text: takeUtf16SafePrefix(normalized, maximum), truncated: true }
    : { text: normalized, truncated: false };
}

function safeIndexedDisplay(value: string): string {
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

function sheetData(sheet: DenseWorksheet): readonly (readonly (CellObject | undefined)[] | undefined)[] {
  return sheet["!data"] ?? [];
}

function cellAt(sheet: DenseWorksheet, row: number, column: number): CellObject | undefined {
  const dense = sheetData(sheet);
  return dense[row]?.[column] ?? sheet[utils.encode_cell({ c: column, r: row })];
}

function populatedCell(cell: CellObject | undefined): boolean {
  return Boolean(cell && (cell.v !== undefined && cell.v !== null || cell.f));
}

function parsedRange(range: Readonly<{
  e: Readonly<{ c: number; r: number }>;
  s: Readonly<{ c: number; r: number }>;
}>): ParsedWorkbookRange {
  if (
    !Number.isSafeInteger(range.s.r) || !Number.isSafeInteger(range.e.r) ||
    !Number.isSafeInteger(range.s.c) || !Number.isSafeInteger(range.e.c) ||
    range.s.r < 0 || range.s.c < 0 || range.e.r < range.s.r || range.e.c < range.s.c ||
    range.e.r >= SPREADSHEET_MAX_ROWS_PER_SHEET ||
    range.e.c >= SPREADSHEET_MAX_COLUMNS_PER_SHEET
  ) outputTooLarge();
  return Object.freeze({
    a1: utils.encode_range(range as Parameters<typeof utils.encode_range>[0]),
    columnEnd: range.e.c,
    columnStart: range.s.c,
    rowEnd: range.e.r,
    rowStart: range.s.r
  });
}

function uniqueColumnLabels(
  sheet: DenseWorksheet,
  headerRow: number | null,
  columnStart: number,
  columnEnd: number,
  warnings: Set<ParsedWorkbookWarningCode>
): readonly string[] {
  const counts = new Map<string, number>();
  return Object.freeze(Array.from(
    { length: columnEnd - columnStart + 1 },
    (_value, offset) => {
      const column = columnStart + offset;
      const candidate = headerRow === null
        ? ""
        : cleanText(String(cellAt(sheet, headerRow, column)?.w ??
          cellAt(sheet, headerRow, column)?.v ?? ""), 256).text.trim();
      const base = candidate || utils.encode_col(column);
      const key = base.normalize("NFKC").toLocaleLowerCase("und");
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      if (occurrence > 1) warnings.add("duplicate_headers");
      return occurrence === 1 ? base : `${base} [${occurrence}]`;
    }
  ));
}

function headerRowFor(
  sheet: DenseWorksheet,
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number
): number | null {
  if (rowStart >= rowEnd) return null;
  const cells = Array.from({ length: columnEnd - columnStart + 1 }, (_value, offset) =>
    cellAt(sheet, rowStart, columnStart + offset)).filter(populatedCell);
  if (cells.length === 0) return null;
  const strings = cells.filter((cell) => cell?.t === "s").length;
  const next = Array.from({ length: columnEnd - columnStart + 1 }, (_value, offset) =>
    cellAt(sheet, rowStart + 1, columnStart + offset));
  const nextValues = next.filter(populatedCell);
  const nextTyped = nextValues.some((cell) => cell?.t === "n" || cell?.t === "d" || cell?.t === "b");
  const headerLabels = cells.map((cell) => String(cell?.v ?? "").normalize("NFKC").trim())
    .filter(Boolean);
  const plausibleTextHeader = cells.length >= 2 && strings === cells.length &&
    headerLabels.length === cells.length && new Set(headerLabels.map((label) =>
      label.toLocaleLowerCase("und"))).size === headerLabels.length &&
    headerLabels.every((label) => label.length <= 128 && !/^[=+\-@]/u.test(label));
  return strings / cells.length >= 0.6 && nextValues.length > 0 &&
    (nextTyped || plausibleTextHeader) ? rowStart : null;
}

function rowLabelColumnsFor(
  sheet: DenseWorksheet,
  headerRow: number | null,
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number
): readonly number[] {
  const firstDataRow = headerRow === null ? rowStart : headerRow + 1;
  const sampleEnd = Math.min(rowEnd, firstDataRow + 19);
  const labels: number[] = [];
  for (let column = columnStart; column <= columnEnd && labels.length < 3; column += 1) {
    let populated = 0;
    let strings = 0;
    const unique = new Set<string>();
    for (let row = firstDataRow; row <= sampleEnd; row += 1) {
      const cell = cellAt(sheet, row, column);
      if (!populatedCell(cell)) continue;
      populated += 1;
      if (cell?.t === "s") {
        strings += 1;
        unique.add(String(cell.v));
      }
    }
    if (populated >= 2 && strings / populated >= 0.8 && unique.size / strings >= 0.8) {
      labels.push(column);
    }
  }
  return Object.freeze(labels);
}

function regionsFor(
  sheet: DenseWorksheet,
  cells: readonly ParsedWorkbookCell[],
  warnings: Set<ParsedWorkbookWarningCode>
): readonly ParsedWorkbookRegion[] {
  if (cells.length === 0) return Object.freeze([]);
  const byRow = new Map<number, { maximum: number; minimum: number }>();
  for (const cell of cells) {
    const current = byRow.get(cell.row);
    byRow.set(cell.row, current
      ? { maximum: Math.max(current.maximum, cell.column), minimum: Math.min(current.minimum, cell.column) }
      : { maximum: cell.column, minimum: cell.column });
  }
  const rows = [...byRow.keys()].sort((left, right) => left - right);
  const spans: Array<{ rowEnd: number; rowStart: number }> = [];
  for (const row of rows) {
    const current = spans.at(-1);
    if (current && row <= current.rowEnd + 1) current.rowEnd = row;
    else spans.push({ rowEnd: row, rowStart: row });
  }
  if (spans.length > SPREADSHEET_MAX_REGIONS_PER_SHEET) outputTooLarge();
  return Object.freeze(spans.map(({ rowEnd, rowStart }) => {
    const rowsInSpan = [...byRow.entries()].filter(([row]) => row >= rowStart && row <= rowEnd);
    const columnStart = Math.min(...rowsInSpan.map(([, value]) => value.minimum));
    const columnEnd = Math.max(...rowsInSpan.map(([, value]) => value.maximum));
    const headerRow = headerRowFor(sheet, rowStart, rowEnd, columnStart, columnEnd);
    return Object.freeze({
      ...parsedRange({ e: { c: columnEnd, r: rowEnd }, s: { c: columnStart, r: rowStart } }),
      columnLabels: uniqueColumnLabels(sheet, headerRow, columnStart, columnEnd, warnings),
      headerRow,
      rowLabelColumns: rowLabelColumnsFor(
        sheet,
        headerRow,
        rowStart,
        rowEnd,
        columnStart,
        columnEnd
      )
    });
  }));
}

function workbookCell(
  raw: CellObject,
  row: number,
  column: number,
  warnings: Set<ParsedWorkbookWarningCode>,
  remainingCharacters: number,
  allowFormula: boolean,
  dateSystem: "1900" | "1904"
): Readonly<{ cell: ParsedWorkbookCell; characters: number; truncated: boolean }> {
  const formulaValue = allowFormula && typeof raw.f === "string"
    ? cleanText(raw.f, SPREADSHEET_MAX_FORMULA_TEXT)
    : null;
  if (raw.f !== undefined && !formulaValue) rejected();
  if (formulaValue?.truncated) outputTooLarge();
  if (formulaValue && (raw.v === undefined || raw.v === null)) {
    warnings.add("formula_without_cached_value");
  }
  if (raw.l) warnings.add("external_links_ignored");

  let type: ParsedWorkbookCell["type"];
  let value: ParsedWorkbookCell["value"];
  if (raw.t === "b") {
    type = "boolean";
    value = Boolean(raw.v);
  } else if (raw.t === "n" && typeof raw.v === "number" && Number.isFinite(raw.v)) {
    const dateValue = typeof raw.z === "string" && spreadsheetFormatIsDate(raw.z)
      ? spreadsheetDateFromSerial(raw.v, dateSystem)
      : null;
    type = dateValue === null ? "number" : "date";
    value = dateValue ?? raw.v;
  } else if (raw.t === "d") {
    const date = raw.v instanceof Date ? raw.v : new Date(String(raw.v));
    if (Number.isNaN(date.valueOf())) {
      warnings.add("unsupported_cell_type");
      type = "string";
      value = String(raw.v ?? "");
    } else {
      type = "date";
      value = date.toISOString().replace(/Z$/u, "").replace(/\.000$/u, "");
    }
  } else if (raw.t === "e") {
    type = "error";
    value = String(raw.w ?? raw.v ?? "#ERROR!");
  } else if (raw.t === "s") {
    type = "string";
    value = String(raw.v ?? "");
  } else if (raw.v === undefined || raw.v === null) {
    type = "blank";
    value = null;
  } else {
    warnings.add("unsupported_cell_type");
    type = "string";
    value = String(raw.v);
  }

  const rawValue = typeof value === "string" ? cleanText(value) : null;
  let truncated = rawValue?.truncated ?? false;
  if (rawValue) value = rawValue.text;
  const rawDisplay = cleanText(String(raw.w ?? (value === null ? "" : value)));
  truncated ||= rawDisplay.truncated;
  const allowed = Math.max(0, remainingCharacters);
  const valueText = typeof value === "string" ? value : "";
  const combinedCharacters = valueText.length + rawDisplay.text.length + (formulaValue?.text.length ?? 0);
  if (combinedCharacters > allowed) {
    const display = takeUtf16SafePrefix(rawDisplay.text, allowed);
    if (typeof value === "string") value = takeUtf16SafePrefix(value, Math.max(0, allowed - display.length));
    truncated = true;
    return {
      cell: Object.freeze({
        address: utils.encode_cell({ c: column, r: row }),
        column,
        display,
        formula: formulaValue?.text ?? null,
        numberFormat: typeof raw.z === "string" ? cleanText(raw.z, 256).text || null : null,
        row,
        type,
        value
      }),
      characters: allowed,
      truncated
    };
  }
  if (type === "string" && typeof value === "string" && /^[=+\-@]/u.test(value)) {
    warnings.add("formula_like_text");
  }
  return {
    cell: Object.freeze({
      address: utils.encode_cell({ c: column, r: row }),
      column,
      display: rawDisplay.text,
      formula: formulaValue?.text ?? null,
      numberFormat: typeof raw.z === "string" ? cleanText(raw.z, 256).text || null : null,
      row,
      type,
      value
    }),
    characters: combinedCharacters,
    truncated
  };
}

function sheetVisibility(book: WorkBook, index: number): ParsedWorkbookSheet["hidden"] {
  const hidden = book.Workbook?.Sheets?.[index]?.Hidden;
  return hidden === 2 ? "very_hidden" : hidden === 1 ? "hidden" : "visible";
}

function sheetDimensions(cells: readonly ParsedWorkbookCell[]): Readonly<{
  columnCount: number;
  rowCount: number;
}> {
  return cells.reduce((result, cell) => ({
    columnCount: Math.max(result.columnCount, cell.column + 1),
    rowCount: Math.max(result.rowCount, cell.row + 1)
  }), { columnCount: 0, rowCount: 0 });
}

function hiddenIndexes(
  values: readonly ({ hidden?: boolean } | null | undefined)[] | undefined,
  maximum: number
): readonly number[] {
  if (!values) return Object.freeze([]);
  return Object.freeze(values.flatMap((value, index) =>
    value?.hidden && index < maximum ? [index] : []));
}

function parseSheet(
  book: WorkBook,
  sheet: DenseWorksheet,
  index: number,
  name: string,
  state: Readonly<{ characterLimit: number; characters: number; populatedCells: number }>,
  warnings: Set<ParsedWorkbookWarningCode>,
  allowFormulas: boolean,
  dateSystem: "1900" | "1904"
): Readonly<{
  characters: number;
  populatedCells: number;
  sheet: ParsedWorkbookSheet;
}> {
  const dense = sheetData(sheet);
  const cells: ParsedWorkbookCell[] = [];
  let characters = state.characters;
  let populatedCells = state.populatedCells;
  let truncated = false;
  const rows = Math.min(dense.length, SPREADSHEET_MAX_ROWS_PER_SHEET);
  for (let row = 0; row < rows; row += 1) {
    const values = dense[row] ?? [];
    if (values.length > SPREADSHEET_MAX_COLUMNS_PER_SHEET) outputTooLarge();
    for (let column = 0; column < values.length; column += 1) {
      const raw = values[column];
      if (!populatedCell(raw)) continue;
      populatedCells += 1;
      if (populatedCells > SPREADSHEET_MAX_POPULATED_CELLS) outputTooLarge();
      const parsed = workbookCell(
        raw!,
        row,
        column,
        warnings,
        state.characterLimit - characters,
        allowFormulas,
        dateSystem
      );
      characters += parsed.characters;
      truncated ||= parsed.truncated;
      cells.push(parsed.cell);
    }
  }
  const fullRef = sheet["!fullref"];
  if (dense.length > SPREADSHEET_MAX_ROWS_PER_SHEET || fullRef) {
    truncated = true;
    warnings.add("spreadsheet_rows_truncated");
  }
  if (truncated) warnings.add("spreadsheet_cells_truncated");
  const dimensions = sheetDimensions(cells);
  const hiddenRows = hiddenIndexes(sheet["!rows"], dimensions.rowCount);
  const hiddenColumns = hiddenIndexes(sheet["!cols"], dimensions.columnCount);
  const hidden = sheetVisibility(book, index);
  if (hidden !== "visible" || hiddenRows.length > 0 || hiddenColumns.length > 0) {
    warnings.add("hidden_data_present");
  }
  const rawMerges = sheet["!merges"] ?? [];
  if (rawMerges.length > SPREADSHEET_MAX_MERGES_PER_SHEET) outputTooLarge();
  const merges = rawMerges.map(parsedRange);
  return {
    characters,
    populatedCells,
    sheet: Object.freeze({
      cells: Object.freeze(cells),
      columnCount: dimensions.columnCount,
      hidden,
      hiddenColumns,
      hiddenRows,
      index,
      merges: Object.freeze(merges),
      name: cleanText(name, 256).text || `Sheet ${index + 1}`,
      regions: regionsFor(sheet, cells, warnings),
      rowCount: dimensions.rowCount,
      truncated
    })
  };
}

function blockTable(
  sheet: ParsedWorkbookSheet,
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number
): ParsedTable {
  const cells = sheet.cells.filter((cell) =>
    cell.row >= rowStart && cell.row <= rowEnd &&
    cell.column >= columnStart && cell.column <= columnEnd
  ).map((cell) => Object.freeze({
    column: cell.column - columnStart,
    columnSpan: 1,
    row: cell.row - rowStart,
    rowSpan: 1,
    text: safeIndexedDisplay(cell.display)
  }));
  return Object.freeze({
    cells: Object.freeze(cells),
    columnCount: columnEnd - columnStart + 1,
    rowCount: rowEnd - rowStart + 1
  });
}

function blocksForWorkbook(
  workbook: ParsedWorkbook,
  maximumCharacters: number
): Readonly<{ blocks: readonly ParsedDocumentBlock[]; truncated: boolean }> {
  const blocks: ParsedDocumentBlock[] = [];
  let characters = 0;
  let truncated = false;
  for (const sheet of workbook.sheets) {
    for (const region of sheet.regions) {
      for (let rowStart = region.rowStart; rowStart <= region.rowEnd; rowStart += BLOCK_ROW_COUNT) {
        const rowEnd = Math.min(region.rowEnd, rowStart + BLOCK_ROW_COUNT - 1);
        for (let columnStart = region.columnStart;
          columnStart <= region.columnEnd;
          columnStart += BLOCK_COLUMN_COUNT) {
          const columnEnd = Math.min(region.columnEnd, columnStart + BLOCK_COLUMN_COUNT - 1);
          const table = blockTable(sheet, rowStart, rowEnd, columnStart, columnEnd);
          const rows = Array.from({ length: table.rowCount }, () =>
            Array<string>(table.columnCount).fill(""));
          for (const cell of table.cells) rows[cell.row]![cell.column] = cell.text;
          const text = rows.map((row) => row.join("\t").trimEnd()).filter(Boolean).join("\n");
          if (!text) continue;
          if (characters + text.length > maximumCharacters) {
            truncated = true;
            continue;
          }
          const range = utils.encode_range({
            e: { c: columnEnd, r: rowEnd },
            s: { c: columnStart, r: rowStart }
          });
          const order = blocks.length;
          blocks.push(Object.freeze({
            assetIds: Object.freeze([]),
            boundingBoxes: Object.freeze([]),
            headingPath: Object.freeze([sheet.name, range]),
            index: order,
            isTable: true,
            languageHints: parsedLanguageHints(text),
            page: sheet.index + 1,
            pageEnd: sheet.index + 1,
            readingOrder: order,
            table,
            text,
            type: "table"
          }));
          characters += text.length;
        }
      }
    }
  }
  return Object.freeze({ blocks: Object.freeze(blocks), truncated });
}

function parseWorkbook(input: DocumentParseInput, maximumCharacters: number): ParsedWorkbook {
  if (isZipFormat(input.fileName)) assertBoundedSpreadsheetArchive(input.bytes);
  let book: WorkBook;
  try {
    const csv = input.fileName.toLocaleLowerCase("und").endsWith(".csv");
    book = read(input.bytes, {
      bookDeps: false,
      bookFiles: false,
      bookVBA: false,
      cellDates: false,
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
      cellText: true,
      dense: true,
      raw: csv,
      sheetRows: SPREADSHEET_MAX_ROWS_PER_SHEET + 1,
      type: "buffer"
    });
  } catch {
    rejected();
  }
  if (book.SheetNames.length < 1 || book.SheetNames.length > SPREADSHEET_MAX_SHEETS) {
    outputTooLarge();
  }
  const warnings = new Set<ParsedWorkbookWarningCode>();
  if (input.bytes.includes(Buffer.from("vbaProject.bin")) ||
    input.bytes.includes(Buffer.from("_VBA_PROJECT_CUR"))) warnings.add("macros_ignored");
  let characters = 0;
  let populatedCells = 0;
  const sheets: ParsedWorkbookSheet[] = [];
  const allowFormulas = !input.fileName.toLocaleLowerCase("und").endsWith(".csv");
  const dateSystem = book.Workbook?.WBProps?.date1904 === true ? "1904" : "1900";
  for (const [index, name] of book.SheetNames.entries()) {
    const raw = book.Sheets[name] as DenseWorksheet | undefined;
    if (!raw) rejected();
    const parsed = parseSheet(
      book,
      raw,
      index,
      name,
      { characterLimit: maximumCharacters, characters, populatedCells },
      warnings,
      allowFormulas,
      dateSystem
    );
    characters = parsed.characters;
    populatedCells = parsed.populatedCells;
    sheets.push(parsed.sheet);
  }
  if (populatedCells < 1) rejected();
  return Object.freeze({
    dateSystem,
    sheets: Object.freeze(sheets),
    warnings: Object.freeze([...warnings].sort())
  });
}

export function parseSpreadsheetDocument(
  input: DocumentParseInput,
  options: Readonly<{ maxCharacters?: number }> = {}
): ParsedDocument {
  if (input.signal?.aborted) throw input.signal.reason;
  const maximumCharacters = Math.max(1, Math.floor(options.maxCharacters ?? 5_000_000));
  const workbook = parseWorkbook(input, maximumCharacters);
  const indexed = blocksForWorkbook(workbook, maximumCharacters);
  if (indexed.blocks.length < 1) rejected();
  const partial = indexed.truncated || workbook.sheets.some((sheet) => sheet.truncated);
  return finalizeParsedDocument({
    attempts: [{ engine: "spreadsheet", errorCode: null, outcome: partial ? "partial" : "complete" }],
    blocks: indexed.blocks,
    engine: "spreadsheet",
    mediaType: input.mimeType,
    pageCount: workbook.sheets.length,
    status: partial ? "partial" : "complete",
    text: indexed.blocks.map((block) => block.text).join("\n\n"),
    warnings: partial ? ["truncated_oversized_section"] : [],
    workbook
  });
}
