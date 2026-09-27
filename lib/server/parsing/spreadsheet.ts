import { crc32, inflateRawSync } from "node:zlib";
import { read, utils, type CellObject, type WorkBook, type WorkSheet } from "xlsx";
import { takeUtf16SafePrefix } from "../../domain/utf16";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import { DocumentParserError } from "./errors";
import {
  SPREADSHEET_DEFAULT_MAX_CHARACTERS,
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
// Deflate cannot expand input beyond about 1032:1 plus one maximal match, so a
// larger declaration is forged. Verified inflation remains the actual bound.
const DEFLATE_MAX_EXPANSION_RATIO = 1_032;
const DEFLATE_MAX_EXPANSION_SLACK = 258;
const BLOCK_ROW_COUNT = 200;
const BLOCK_COLUMN_COUNT = 50;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const MAX_EOCD_COMMENT_BYTES = 0xffff;
const DATA_DESCRIPTOR_FLAG = 0x0008;
// Traditional, strong, and central-directory encryption.
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
const STORED = 0;
const DEFLATED = 8;
const STORED_VERSION = 10;

type ArchiveEntry = Readonly<{
  compressedSize: number;
  crc: number;
  date: number;
  flags: number;
  localOffset: number;
  method: number;
  name: Buffer;
  time: number;
  uncompressedSize: number;
}>;

type LocatedArchiveEntry = ArchiveEntry & Readonly<{ dataEnd: number; dataStart: number }>;

type InflatedEntry = Readonly<{ buffer: Buffer; engine: Readonly<{ bytesWritten: number }> }>;

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

function endOfCentralDirectory(bytes: Buffer): number {
  if (bytes.byteLength < EOCD_BYTES) rejected();
  const minimum = Math.max(0, bytes.byteLength - EOCD_BYTES - MAX_EOCD_COMMENT_BYTES);
  for (let offset = bytes.byteLength - EOCD_BYTES; offset >= minimum; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === EOCD_SIGNATURE &&
      offset + EOCD_BYTES + bytes.readUInt16LE(offset + 20) === bytes.byteLength
    ) return offset;
  }
  return rejected();
}

function zip64SizeAgrees(bytes: Buffer, offset: number, size: number): boolean {
  const value = bytes.readBigUInt64LE(offset);
  return value === 0n || value === BigInt(size);
}

function assertExtraFields(
  bytes: Buffer,
  start: number,
  length: number,
  sizes: Readonly<{ compressedSize: number; uncompressedSize: number }>
): void {
  const end = start + length;
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) rejected();
    const size = bytes.readUInt16LE(cursor + 2);
    const data = cursor + 4;
    if (data + size > end) rejected();
    // A ZIP64-aware reader must agree with the 32-bit sizes that are enforced.
    if (bytes.readUInt16LE(cursor) === ZIP64_EXTRA_ID && (
      size >= 8 && !zip64SizeAgrees(bytes, data, sizes.uncompressedSize) ||
      size >= 16 && !zip64SizeAgrees(bytes, data + 8, sizes.compressedSize)
    )) rejected();
    cursor = data + size;
  }
}

function entryNameKey(name: Buffer): string {
  if (name.byteLength === 0) rejected();
  for (const byte of name) {
    if (byte < 0x20 || byte === 0x7f || byte === 0x5c) rejected();
  }
  return name.toString("latin1").replace(/[A-Z]+/gu, (letters) => letters.toLowerCase());
}

function centralDirectory(bytes: Buffer): Readonly<{
  entries: readonly ArchiveEntry[];
  offset: number;
}> {
  const eocd = endOfCentralDirectory(bytes);
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) rejected();
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== entryCount || entryCount === 0 ||
    entryCount === 0xffff || size === 0xffffffff || offset === 0xffffffff ||
    offset + size !== eocd
  ) rejected();
  if (entryCount > MAX_ZIP_ENTRIES) outputTooLarge();

  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  let cursor = offset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > eocd || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      rejected();
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameStart = cursor + CENTRAL_HEADER_BYTES;
    const extraStart = nameStart + bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const next = extraStart + extraLength + bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (
      next > eocd || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff || bytes.readUInt16LE(cursor + 34) !== 0
    ) rejected();
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) outputTooLarge();
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > SPREADSHEET_MAX_UNCOMPRESSED_BYTES) outputTooLarge();
    if (
      (flags & ENCRYPTION_FLAGS) !== 0 || method !== STORED && method !== DEFLATED ||
      method === STORED && compressedSize !== uncompressedSize ||
      method === DEFLATED && uncompressedSize >
        compressedSize * DEFLATE_MAX_EXPANSION_RATIO + DEFLATE_MAX_EXPANSION_SLACK
    ) rejected();
    const name = bytes.subarray(nameStart, extraStart);
    const key = entryNameKey(name);
    if (names.has(key)) rejected();
    names.add(key);
    assertExtraFields(bytes, extraStart, extraLength, { compressedSize, uncompressedSize });
    entries.push(Object.freeze({
      compressedSize,
      crc: bytes.readUInt32LE(cursor + 16),
      date: bytes.readUInt16LE(cursor + 14),
      flags,
      localOffset,
      method,
      name,
      time: bytes.readUInt16LE(cursor + 12),
      uncompressedSize
    }));
    cursor = next;
  }
  if (cursor !== eocd) rejected();
  return Object.freeze({ entries: Object.freeze(entries), offset });
}

function localValueAgrees(local: number, central: number, dataDescriptor: boolean): boolean {
  return local === central || dataDescriptor && local === 0;
}

function locatedEntry(
  bytes: Buffer,
  entry: ArchiveEntry,
  directoryOffset: number
): LocatedArchiveEntry {
  const offset = entry.localOffset;
  if (
    offset + LOCAL_HEADER_BYTES > directoryOffset ||
    bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE
  ) rejected();
  const flags = bytes.readUInt16LE(offset + 6);
  const dataDescriptor = (entry.flags & DATA_DESCRIPTOR_FLAG) !== 0;
  const nameStart = offset + LOCAL_HEADER_BYTES;
  const extraStart = nameStart + bytes.readUInt16LE(offset + 26);
  const dataStart = extraStart + bytes.readUInt16LE(offset + 28);
  const dataEnd = dataStart + entry.compressedSize;
  // The data descriptor itself is never trusted; the directory owns the values.
  if (
    dataEnd > directoryOffset || (flags & ENCRYPTION_FLAGS) !== 0 ||
    ((flags & DATA_DESCRIPTOR_FLAG) !== 0) !== dataDescriptor ||
    bytes.readUInt16LE(offset + 8) !== entry.method ||
    !bytes.subarray(nameStart, extraStart).equals(entry.name) ||
    !localValueAgrees(bytes.readUInt32LE(offset + 14), entry.crc, dataDescriptor) ||
    !localValueAgrees(bytes.readUInt32LE(offset + 18), entry.compressedSize, dataDescriptor) ||
    !localValueAgrees(bytes.readUInt32LE(offset + 22), entry.uncompressedSize, dataDescriptor)
  ) rejected();
  assertExtraFields(bytes, extraStart, dataStart - extraStart, entry);
  return Object.freeze({ ...entry, dataEnd, dataStart });
}

function assertDisjointEntries(entries: readonly LocatedArchiveEntry[]): void {
  const ordered = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.dataEnd > ordered[index]!.localOffset) rejected();
  }
}

function zlibErrorCode(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : null;
  return typeof code === "string" ? code : null;
}

function verifiedEntryData(bytes: Buffer, entry: LocatedArchiveEntry): Buffer {
  let data = bytes.subarray(entry.dataStart, entry.dataEnd);
  if (entry.method === DEFLATED) {
    let inflated: InflatedEntry;
    try {
      inflated = inflateRawSync(data, {
        info: true,
        maxOutputLength: entry.uncompressedSize + 1
      }) as unknown as InflatedEntry;
    } catch (error) {
      const code = zlibErrorCode(error);
      if (code === "Z_MEM_ERROR") outputTooLarge();
      if (code === "ERR_BUFFER_TOO_LARGE" || code?.startsWith("Z_")) rejected();
      throw error;
    }
    if (
      inflated.buffer.byteLength !== entry.uncompressedSize ||
      inflated.engine.bytesWritten !== entry.compressedSize
    ) rejected();
    data = inflated.buffer;
  }
  if (crc32(data) !== entry.crc) rejected();
  return data;
}

function rebuiltStoredArchive(bytes: Buffer, entries: readonly LocatedArchiveEntry[]): Buffer {
  const size = entries.reduce((total, entry) => total + LOCAL_HEADER_BYTES +
    CENTRAL_HEADER_BYTES + 2 * entry.name.byteLength + entry.uncompressedSize, EOCD_BYTES);
  const output = Buffer.alloc(size);
  const localOffsets: number[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const data = verifiedEntryData(bytes, entry);
    localOffsets.push(cursor);
    output.writeUInt32LE(LOCAL_SIGNATURE, cursor);
    output.writeUInt16LE(STORED_VERSION, cursor + 4);
    output.writeUInt16LE(entry.time, cursor + 10);
    output.writeUInt16LE(entry.date, cursor + 12);
    output.writeUInt32LE(entry.crc, cursor + 14);
    output.writeUInt32LE(entry.uncompressedSize, cursor + 18);
    output.writeUInt32LE(entry.uncompressedSize, cursor + 22);
    output.writeUInt16LE(entry.name.byteLength, cursor + 26);
    entry.name.copy(output, cursor + LOCAL_HEADER_BYTES);
    data.copy(output, cursor + LOCAL_HEADER_BYTES + entry.name.byteLength);
    cursor += LOCAL_HEADER_BYTES + entry.name.byteLength + entry.uncompressedSize;
  }
  const directoryOffset = cursor;
  entries.forEach((entry, index) => {
    output.writeUInt32LE(CENTRAL_SIGNATURE, cursor);
    output.writeUInt16LE(STORED_VERSION, cursor + 4);
    output.writeUInt16LE(STORED_VERSION, cursor + 6);
    output.writeUInt16LE(entry.time, cursor + 12);
    output.writeUInt16LE(entry.date, cursor + 14);
    output.writeUInt32LE(entry.crc, cursor + 16);
    output.writeUInt32LE(entry.uncompressedSize, cursor + 20);
    output.writeUInt32LE(entry.uncompressedSize, cursor + 24);
    output.writeUInt16LE(entry.name.byteLength, cursor + 28);
    output.writeUInt32LE(localOffsets[index]!, cursor + 42);
    entry.name.copy(output, cursor + CENTRAL_HEADER_BYTES);
    cursor += CENTRAL_HEADER_BYTES + entry.name.byteLength;
  });
  output.writeUInt32LE(EOCD_SIGNATURE, cursor);
  output.writeUInt16LE(entries.length, cursor + 8);
  output.writeUInt16LE(entries.length, cursor + 10);
  output.writeUInt32LE(cursor - directoryOffset, cursor + 12);
  output.writeUInt32LE(directoryOffset, cursor + 16);
  // SheetJS locates the directory by scanning backwards from the last four bytes.
  if (output.subarray(size - EOCD_BYTES + 1).includes(EOCD_SIGNATURE_BYTES)) rejected();
  return output;
}

/**
 * SheetJS trusts local headers and ZIP64 extras, inflates without a size bound
 * and checks sizes only afterwards, so it never receives an uploaded archive.
 * Every central-directory entry must match its local header, fit the size
 * budgets, and inflate to exactly its declared size and CRC; the result is
 * rebuilt as one stored archive without extras or comments. Single-disk stored
 * or deflated entries, verifiable data descriptors, UTF-8 names, well-formed
 * extras, comments, prefixes and gaps are accepted. ZIP64, multi-disk,
 * encryption, other methods, header disagreement, overlap and duplicate names
 * are rejected; declarations above the budgets are too large.
 */
export function canonicalizeSpreadsheetArchive(bytes: Buffer): Buffer {
  const directory = centralDirectory(bytes);
  const entries = directory.entries.map((entry) =>
    locatedEntry(bytes, entry, directory.offset));
  assertDisjointEntries(entries);
  return rebuiltStoredArchive(bytes, entries);
}

/** SheetJS chooses its ZIP reader from these bytes regardless of the name. */
function sheetJsReadsZip(bytes: Buffer): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2]! < 0x09 && bytes[3]! < 0x09;
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
  const workbookBytes = isZipFormat(input.fileName) || sheetJsReadsZip(input.bytes)
    ? canonicalizeSpreadsheetArchive(input.bytes)
    : input.bytes;
  let book: WorkBook;
  try {
    const csv = input.fileName.toLocaleLowerCase("und").endsWith(".csv");
    book = read(workbookBytes, {
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
  const maximumCharacters = Math.max(1, Math.floor(
    options.maxCharacters ?? SPREADSHEET_DEFAULT_MAX_CHARACTERS
  ));
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
