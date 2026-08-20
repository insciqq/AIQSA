import { createHash } from "node:crypto";
import { KNOWLEDGE_PROCESSING_WARNING_CODES } from "../../domain/knowledgeProcessingWarnings";
import type {
  DocumentParserEngine,
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentAsset,
  ParsedDocumentBlock,
  ParsedDocumentBlockType,
  ParsedDocumentParserAttempt,
  ParsedDocumentQuality,
  ParsedDocumentWarningCode,
  ParsedTable,
  ParsedTableCell,
  ParsedWorkbook,
  ParsedWorkbookCell,
  ParsedWorkbookRange,
  ParsedWorkbookRegion,
  ParsedWorkbookSheet,
  ParsedWorkbookWarningCode
} from "../parsing";
import type {
  ParsedFieldCell,
  ParsedFieldCellLabel,
  ParsedFieldGroup,
  ParsedFieldLink,
  ParsedFieldLinkLabel
} from "../parsing/types";
import { finalizeParsedDocument, parsedLanguageHints } from "../parsing/assessment";
import {
  SPREADSHEET_MAX_CELL_TEXT,
  SPREADSHEET_MAX_COLUMNS_PER_SHEET,
  SPREADSHEET_MAX_FORMULA_TEXT,
  SPREADSHEET_MAX_MERGES_PER_SHEET,
  SPREADSHEET_MAX_POPULATED_CELLS,
  SPREADSHEET_MAX_REGIONS_PER_SHEET,
  SPREADSHEET_MAX_ROWS_PER_SHEET,
  SPREADSHEET_MAX_SHEETS
} from "../parsing/spreadsheetLimits";
import { isSpreadsheetDateValue } from "../parsing/spreadsheetDate";
import { utils as spreadsheetUtils } from "xlsx";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { withLayoutAwareTables } from "./layoutTables";

export type KnowledgeNormalizedLocator = Readonly<{
  kind: "page";
  pageEnd: number;
  pageStart: number;
}>;

export type KnowledgeNormalizedAsset = Readonly<{
  boundingBoxes: readonly ParsedBoundingBox[];
  caption: string | null;
  contentHash: string;
  id: string;
  kind: ParsedDocumentAsset["kind"];
  locator: KnowledgeNormalizedLocator;
}>;

export type KnowledgeNormalizedFieldGroup = Readonly<{
  boundingBoxes: readonly ParsedBoundingBox[];
  cells: readonly ParsedFieldCell[];
  confidence: number | null;
  contentHash: string;
  id: string;
  kind: ParsedFieldGroup["kind"];
  links: readonly ParsedFieldLink[];
  locator: KnowledgeNormalizedLocator;
  order: number;
  readingOrder: number;
  sourceRef: string;
}>;

export type KnowledgeNormalizedBlock = Readonly<{
  assetIds: readonly string[];
  boundingBoxes: readonly ParsedBoundingBox[];
  contentHash: string;
  headingPath: readonly string[];
  id: string;
  languageHints: readonly string[];
  locator: KnowledgeNormalizedLocator;
  order: number;
  table: ParsedTable | null;
  text: string;
  type: ParsedDocumentBlockType;
}>;

export type StoredKnowledgeNormalizedDocument = Readonly<{
  assets: readonly KnowledgeNormalizedAsset[];
  blocks: readonly KnowledgeNormalizedBlock[];
  contentHash: string;
  fieldGroups: readonly KnowledgeNormalizedFieldGroup[];
  languages: readonly string[];
  pageCount: number;
  parser: Readonly<{
    attempts: readonly ParsedDocumentParserAttempt[];
    engine: DocumentParserEngine;
  }>;
  quality: ParsedDocumentQuality;
  schemaVersion: 4;
  source: Readonly<{
    displayName: string | null;
    mediaType: string;
  }>;
  status: "complete" | "partial";
  title: string | null;
  warnings: readonly ParsedDocumentWarningCode[];
  workbook: ParsedWorkbook | null;
}>;

export type EncodedKnowledgeNormalizedDocument = Readonly<{
  body: Buffer;
  checksum: string;
  document: StoredKnowledgeNormalizedDocument;
}>;

export type KnowledgeNormalizedDocumentErrorCode =
  | "knowledge_page_limit_exceeded"
  | "knowledge_text_limit_exceeded"
  | "parser_rejected";

export class KnowledgeNormalizedDocumentError extends Error {
  constructor(readonly code: KnowledgeNormalizedDocumentErrorCode) {
    super(code);
    this.name = "KnowledgeNormalizedDocumentError";
  }
}

const BLOCK_TYPES: readonly ParsedDocumentBlockType[] = [
  "caption",
  "code",
  "footnote",
  "heading",
  "image",
  "list_item",
  "paragraph",
  "table",
  "title"
];
const WARNING_CODES: readonly ParsedDocumentWarningCode[] = KNOWLEDGE_PROCESSING_WARNING_CODES;
const ATTEMPT_OUTCOMES = [
  "complete",
  "partial",
  "quality_failure",
  "rejected",
  "retryable_failure"
] as const;
const PARSER_ERROR_CODES = [
  "parser_invalid_output",
  "parser_output_too_large",
  "parser_rejected",
  "parser_timeout",
  "parser_unavailable"
] as const;
const FIELD_CELL_LABELS: readonly ParsedFieldCellLabel[] = [
  "checkbox",
  "key",
  "unspecified",
  "value"
];
const FIELD_LINK_LABELS: readonly ParsedFieldLinkLabel[] = [
  "to_child",
  "to_key",
  "to_parent",
  "to_value",
  "unspecified"
];
const MAX_FIELD_CELLS = 100_000;
const MAX_FIELD_CELLS_PER_GROUP = 10_000;
const MAX_FIELD_GROUPS = 10_000;
const MAX_FIELD_LINKS = 200_000;
const MAX_FIELD_LINKS_PER_GROUP = 20_000;
const MAX_FIELD_REF_LENGTH = 512;
const MAX_FIELD_TEXT_LENGTH = 32_767;
const WORKBOOK_WARNING_CODES: readonly ParsedWorkbookWarningCode[] = [
  "duplicate_headers",
  "external_links_ignored",
  "formula_like_text",
  "formula_without_cached_value",
  "hidden_data_present",
  "macros_ignored",
  "spreadsheet_cells_truncated",
  "spreadsheet_rows_truncated",
  "unsupported_cell_type"
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: string, maxLength = Number.MAX_SAFE_INTEGER): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u0000/gu, "")
    .trim()
    .slice(0, maxLength);
}

function normalizedHeadingPath(values: readonly string[]): readonly string[] {
  return Object.freeze(values.slice(0, 16).map((value) =>
    normalizedText(value.replace(/[\u0000-\u001f\u007f]/gu, " "), 256).replace(/\s+/gu, " ")
  ).filter(Boolean));
}

function normalizedLanguages(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => value.trim()).filter((value) =>
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,2}$/u.test(value)
  ))].slice(0, 16).sort());
}

function normalizedBoundingBox(value: ParsedBoundingBox): ParsedBoundingBox | null {
  if (
    !Number.isSafeInteger(value.page) || value.page < 1 ||
    ![value.bottom, value.left, value.right, value.top].every(Number.isFinite) ||
    value.left > value.right ||
    !["bottom_left", "top_left"].includes(value.coordinateOrigin) ||
    (value.coordinateOrigin === "top_left" && value.bottom < value.top) ||
    (value.coordinateOrigin === "bottom_left" && value.bottom > value.top)
  ) return null;
  return Object.freeze({
    bottom: value.bottom,
    coordinateOrigin: value.coordinateOrigin,
    left: value.left,
    page: value.page,
    right: value.right,
    top: value.top
  });
}

function normalizedBoundingBoxes(values: readonly ParsedBoundingBox[]): readonly ParsedBoundingBox[] {
  if (values.length > 256) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const boxes = values.map(normalizedBoundingBox);
  if (boxes.some((box) => box === null)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return Object.freeze(boxes as ParsedBoundingBox[]);
}

function normalizedConfidence(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return value;
}

function normalizedFieldRef(value: string, allowRoot = false): string {
  const pattern = allowRoot
    ? /^#(?:\/(?:[\w-]+)(?:\/(?:0|[1-9]\d*))?)?$/u
    : /^#\/(?:form_items|key_value_items)\/(?:0|[1-9]\d*)$/u;
  if (!value || value.length > MAX_FIELD_REF_LENGTH || !pattern.test(value)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return value;
}

function normalizedFieldText(value: string): string {
  if (typeof value !== "string" || value.length > MAX_FIELD_TEXT_LENGTH || /\u0000/u.test(value)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return value;
}

function normalizedFieldCell(value: ParsedFieldCell, order: number): ParsedFieldCell {
  if (
    value.order !== order || !Number.isSafeInteger(value.id) || value.id < 0 ||
    !FIELD_CELL_LABELS.includes(value.label)
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze({
    boundingBoxes: normalizedBoundingBoxes(value.boundingBoxes),
    confidence: normalizedConfidence(value.confidence),
    id: value.id,
    itemRef: value.itemRef === null ? null : normalizedFieldRef(value.itemRef, true),
    label: value.label,
    order,
    originalText: normalizedFieldText(value.originalText),
    text: normalizedFieldText(value.text)
  });
}

function normalizedFieldLink(value: ParsedFieldLink, order: number): ParsedFieldLink {
  if (
    value.order !== order || !Number.isSafeInteger(value.sourceCellId) || value.sourceCellId < 0 ||
    !Number.isSafeInteger(value.targetCellId) || value.targetCellId < 0 ||
    !FIELD_LINK_LABELS.includes(value.label)
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze({
    confidence: normalizedConfidence(value.confidence),
    label: value.label,
    order,
    sourceCellId: value.sourceCellId,
    targetCellId: value.targetCellId
  });
}

function fieldGroupContent(
  value: ParsedFieldGroup,
  blockCount: number
): Omit<KnowledgeNormalizedFieldGroup, "contentHash" | "id" | "order"> {
  if (
    !["form", "key_value"].includes(value.kind) ||
    !Number.isSafeInteger(value.page) || value.page < 1 ||
    !Number.isSafeInteger(value.pageEnd) || value.pageEnd < value.page ||
    !Number.isSafeInteger(value.readingOrder) || value.readingOrder < 0 ||
    value.readingOrder > blockCount || value.cells.length > MAX_FIELD_CELLS_PER_GROUP ||
    value.links.length > MAX_FIELD_LINKS_PER_GROUP
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const sourceRef = normalizedFieldRef(value.sourceRef);
  if (
    value.kind === "form" && !sourceRef.startsWith("#/form_items/") ||
    value.kind === "key_value" && !sourceRef.startsWith("#/key_value_items/")
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const cells = value.cells.map(normalizedFieldCell);
  const cellIds = new Set(cells.map((cell) => cell.id));
  if (cellIds.size !== cells.length) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const links = value.links.map(normalizedFieldLink);
  const linkKeys = new Set<string>();
  for (const link of links) {
    if (!cellIds.has(link.sourceCellId) || !cellIds.has(link.targetCellId)) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
    const key = `${link.label}:${link.sourceCellId}:${link.targetCellId}`;
    if (linkKeys.has(key)) throw new KnowledgeNormalizedDocumentError("parser_rejected");
    linkKeys.add(key);
  }
  const boundingBoxes = normalizedBoundingBoxes(value.boundingBoxes);
  if ([...boundingBoxes, ...cells.flatMap((cell) => cell.boundingBoxes)].some((box) =>
    box.page < value.page || box.page > value.pageEnd)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return {
    boundingBoxes,
    cells: Object.freeze(cells),
    confidence: normalizedConfidence(value.confidence),
    kind: value.kind,
    links: Object.freeze(links),
    locator: Object.freeze({ kind: "page", pageEnd: value.pageEnd, pageStart: value.page }),
    readingOrder: value.readingOrder,
    sourceRef
  };
}

function normalizedFieldGroups(
  input: readonly ParsedFieldGroup[],
  blockCount: number
): readonly KnowledgeNormalizedFieldGroup[] {
  if (input.length > MAX_FIELD_GROUPS) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const sourceRefs = new Set<string>();
  const occurrences = new Map<string, number>();
  let cellCount = 0;
  let linkCount = 0;
  let previousReadingOrder = -1;
  return Object.freeze(input.map((value, order) => {
    const content = fieldGroupContent(value, blockCount);
    if (content.readingOrder < previousReadingOrder) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
    previousReadingOrder = content.readingOrder;
    if (sourceRefs.has(content.sourceRef)) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
    sourceRefs.add(content.sourceRef);
    cellCount += content.cells.length;
    linkCount += content.links.length;
    if (cellCount > MAX_FIELD_CELLS || linkCount > MAX_FIELD_LINKS) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
    const contentHash = canonicalHash(content);
    const occurrence = occurrences.get(contentHash) ?? 0;
    occurrences.set(contentHash, occurrence + 1);
    return Object.freeze({
      ...content,
      contentHash,
      id: `fg_${contentHash.slice(0, 24)}_${occurrence}`,
      order
    });
  }));
}

function normalizedTable(table: ParsedTable | null): ParsedTable | null {
  if (!table) return null;
  if (
    !Number.isSafeInteger(table.rowCount) || table.rowCount < 1 || table.rowCount > 2_000 ||
    !Number.isSafeInteger(table.columnCount) || table.columnCount < 1 || table.columnCount > 200 ||
    table.cells.length > 10_000
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const cells: ParsedTableCell[] = [];
  for (const cell of table.cells) {
    const text = normalizedText(cell.text);
    if (
      !Number.isSafeInteger(cell.row) || cell.row < 0 || cell.row >= table.rowCount ||
      !Number.isSafeInteger(cell.column) || cell.column < 0 || cell.column >= table.columnCount ||
      !Number.isSafeInteger(cell.rowSpan) || cell.rowSpan < 1 || cell.row + cell.rowSpan > table.rowCount ||
      !Number.isSafeInteger(cell.columnSpan) || cell.columnSpan < 1 ||
      cell.column + cell.columnSpan > table.columnCount
    ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
    cells.push(Object.freeze({
      column: cell.column,
      columnSpan: cell.columnSpan,
      row: cell.row,
      rowSpan: cell.rowSpan,
      text
    }));
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    columnCount: table.columnCount,
    rowCount: table.rowCount
  });
}

function normalizedWorkbookRange(value: ParsedWorkbookRange): ParsedWorkbookRange {
  if (
    !Number.isSafeInteger(value.rowStart) || value.rowStart < 0 ||
    !Number.isSafeInteger(value.rowEnd) || value.rowEnd < value.rowStart ||
    value.rowEnd >= SPREADSHEET_MAX_ROWS_PER_SHEET ||
    !Number.isSafeInteger(value.columnStart) || value.columnStart < 0 ||
    !Number.isSafeInteger(value.columnEnd) || value.columnEnd < value.columnStart ||
    value.columnEnd >= SPREADSHEET_MAX_COLUMNS_PER_SHEET
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const a1 = spreadsheetUtils.encode_range({
    e: { c: value.columnEnd, r: value.rowEnd },
    s: { c: value.columnStart, r: value.rowStart }
  });
  if (value.a1 !== a1) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze({
    a1,
    columnEnd: value.columnEnd,
    columnStart: value.columnStart,
    rowEnd: value.rowEnd,
    rowStart: value.rowStart
  });
}

function normalizedWorkbookCell(value: ParsedWorkbookCell): ParsedWorkbookCell {
  if (
    !Number.isSafeInteger(value.row) || value.row < 0 ||
    value.row >= SPREADSHEET_MAX_ROWS_PER_SHEET ||
    !Number.isSafeInteger(value.column) || value.column < 0 ||
    value.column >= SPREADSHEET_MAX_COLUMNS_PER_SHEET ||
    value.address !== spreadsheetUtils.encode_cell({ c: value.column, r: value.row }) ||
    typeof value.display !== "string" || value.display.length > SPREADSHEET_MAX_CELL_TEXT ||
    /\u0000/u.test(value.display) ||
    (value.formula !== null && (
      typeof value.formula !== "string" || value.formula.length < 1 ||
      value.formula.length > SPREADSHEET_MAX_FORMULA_TEXT || /\u0000/u.test(value.formula)
    )) ||
    (value.numberFormat !== null && (
      typeof value.numberFormat !== "string" || value.numberFormat.length < 1 ||
      value.numberFormat.length > 256 || /\u0000/u.test(value.numberFormat)
    ))
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  let normalizedValue: ParsedWorkbookCell["value"] = value.value;
  if (value.type === "blank") {
    if (value.value !== null) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  } else if (value.type === "boolean") {
    if (typeof value.value !== "boolean") throw new KnowledgeNormalizedDocumentError("parser_rejected");
  } else if (value.type === "number") {
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
  } else if (value.type === "date") {
    if (typeof value.value !== "string" || !isSpreadsheetDateValue(value.value)) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
  } else if (value.type === "error" || value.type === "string") {
    if (typeof value.value !== "string" || value.value.length > SPREADSHEET_MAX_CELL_TEXT ||
      /\u0000/u.test(value.value)) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
    normalizedValue = value.value.replace(/\r\n?/gu, "\n");
  } else {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return Object.freeze({
    address: value.address,
    column: value.column,
    display: value.display.replace(/\r\n?/gu, "\n"),
    formula: value.formula?.replace(/\r\n?/gu, "\n") ?? null,
    numberFormat: value.numberFormat,
    row: value.row,
    type: value.type,
    value: normalizedValue
  });
}

function normalizedWorkbookRegion(value: ParsedWorkbookRegion): ParsedWorkbookRegion {
  const range = normalizedWorkbookRange(value);
  const width = range.columnEnd - range.columnStart + 1;
  if (
    !Array.isArray(value.columnLabels) || value.columnLabels.length !== width ||
    value.columnLabels.some((label) => typeof label !== "string" || !label.trim() ||
      label.length > 256 || /\u0000/u.test(label)) ||
    (value.headerRow !== null && (
      !Number.isSafeInteger(value.headerRow) || value.headerRow < range.rowStart ||
      value.headerRow > range.rowEnd
    )) ||
    !Array.isArray(value.rowLabelColumns) || value.rowLabelColumns.length > 3 ||
    value.rowLabelColumns.some((column) => !Number.isSafeInteger(column) ||
      column < range.columnStart || column > range.columnEnd) ||
    new Set(value.rowLabelColumns).size !== value.rowLabelColumns.length
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze({
    ...range,
    columnLabels: Object.freeze(value.columnLabels.map((label) => label.trim())),
    headerRow: value.headerRow,
    rowLabelColumns: Object.freeze([...value.rowLabelColumns])
  });
}

function sortedUniqueIndexes(values: readonly number[], maximum: number): readonly number[] {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= maximum) ||
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return Object.freeze([...values]);
}

function normalizedWorkbookSheet(value: ParsedWorkbookSheet, index: number): ParsedWorkbookSheet {
  if (
    value.index !== index || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 ||
    value.rowCount > SPREADSHEET_MAX_ROWS_PER_SHEET ||
    !Number.isSafeInteger(value.columnCount) || value.columnCount < 0 ||
    value.columnCount > SPREADSHEET_MAX_COLUMNS_PER_SHEET ||
    typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 ||
    /\u0000/u.test(value.name) ||
    (value.hidden !== "visible" && value.hidden !== "hidden" && value.hidden !== "very_hidden") ||
    typeof value.truncated !== "boolean" || !Array.isArray(value.cells) ||
    value.cells.length > SPREADSHEET_MAX_POPULATED_CELLS ||
    !Array.isArray(value.merges) || value.merges.length > SPREADSHEET_MAX_MERGES_PER_SHEET ||
    !Array.isArray(value.regions) || value.regions.length > SPREADSHEET_MAX_REGIONS_PER_SHEET
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const cells = value.cells.map(normalizedWorkbookCell);
  if (cells.some((cell, cellIndex) => {
    const previous = cells[cellIndex - 1];
    return cell.row >= value.rowCount || cell.column >= value.columnCount ||
      Boolean(previous && (cell.row < previous.row ||
        cell.row === previous.row && cell.column <= previous.column));
  })) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const expectedRows = cells.reduce((maximum, cell) => Math.max(maximum, cell.row + 1), 0);
  const expectedColumns = cells.reduce((maximum, cell) => Math.max(maximum, cell.column + 1), 0);
  if (expectedRows !== value.rowCount || expectedColumns !== value.columnCount) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    columnCount: value.columnCount,
    hidden: value.hidden,
    hiddenColumns: sortedUniqueIndexes(value.hiddenColumns, value.columnCount),
    hiddenRows: sortedUniqueIndexes(value.hiddenRows, value.rowCount),
    index,
    merges: Object.freeze(value.merges.map(normalizedWorkbookRange)),
    name: value.name.trim(),
    regions: Object.freeze(value.regions.map(normalizedWorkbookRegion)),
    rowCount: value.rowCount,
    truncated: value.truncated
  });
}

function normalizedWorkbook(value: ParsedWorkbook | null): ParsedWorkbook | null {
  if (value === null) return null;
  if (
    (value.dateSystem !== "1900" && value.dateSystem !== "1904") ||
    !Array.isArray(value.sheets) || value.sheets.length < 1 ||
    value.sheets.length > SPREADSHEET_MAX_SHEETS ||
    !Array.isArray(value.warnings) || value.warnings.length > WORKBOOK_WARNING_CODES.length ||
    value.warnings.some((warning) => !WORKBOOK_WARNING_CODES.includes(warning)) ||
    new Set(value.warnings).size !== value.warnings.length
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const sheets = value.sheets.map(normalizedWorkbookSheet);
  if (sheets.reduce((total, sheet) => total + sheet.cells.length, 0) >
    SPREADSHEET_MAX_POPULATED_CELLS) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return Object.freeze({
    dateSystem: value.dateSystem,
    sheets: Object.freeze(sheets),
    warnings: Object.freeze(WORKBOOK_WARNING_CODES.filter((warning) =>
      value.warnings.includes(warning)))
  });
}

function normalizedAttempt(value: ParsedDocumentParserAttempt): ParsedDocumentParserAttempt {
  if (
    !["docling", "inline", "spreadsheet", "tika"].includes(value.engine) ||
    !ATTEMPT_OUTCOMES.includes(value.outcome) ||
    (value.errorCode !== null && !PARSER_ERROR_CODES.includes(value.errorCode))
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze({
    engine: value.engine,
    errorCode: value.errorCode,
    outcome: value.outcome
  });
}

function attemptEvidence(parsed: ParsedDocument): readonly ParsedDocumentParserAttempt[] {
  const attempts = parsed.attempts.length > 0
    ? parsed.attempts
    : [{ engine: parsed.engine, errorCode: null, outcome: parsed.status } as const];
  if (attempts.length > 4) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze(attempts.map(normalizedAttempt));
}

function assetContent(asset: ParsedDocumentAsset): Omit<KnowledgeNormalizedAsset, "contentHash" | "id"> {
  if (!Number.isSafeInteger(asset.page) || asset.page < 1) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const boundingBoxes = normalizedBoundingBoxes(asset.boundingBoxes);
  if (boundingBoxes.some((box) => box.page !== asset.page)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return {
    boundingBoxes,
    caption: asset.caption ? normalizedText(asset.caption, 2_000) || null : null,
    kind: asset.kind,
    locator: Object.freeze({ kind: "page", pageEnd: asset.page, pageStart: asset.page })
  };
}

function normalizedAssets(input: readonly ParsedDocumentAsset[]): Readonly<{
  assets: readonly KnowledgeNormalizedAsset[];
  idMap: ReadonlyMap<string, string>;
}> {
  if (input.length > 10_000) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const occurrences = new Map<string, number>();
  const idMap = new Map<string, string>();
  const assets = input.map((asset) => {
    if (!asset.id || idMap.has(asset.id)) throw new KnowledgeNormalizedDocumentError("parser_rejected");
    const content = assetContent(asset);
    const contentHash = canonicalHash(content);
    const occurrence = occurrences.get(contentHash) ?? 0;
    occurrences.set(contentHash, occurrence + 1);
    const id = `a_${contentHash.slice(0, 24)}_${occurrence}`;
    idMap.set(asset.id, id);
    return Object.freeze({ ...content, contentHash, id });
  });
  return Object.freeze({ assets: Object.freeze(assets), idMap });
}

function blockContent(
  block: ParsedDocumentBlock,
  assetIdMap: ReadonlyMap<string, string>
): Omit<KnowledgeNormalizedBlock, "contentHash" | "id" | "order"> {
  if (
    !Number.isSafeInteger(block.page) || block.page < 1 ||
    !Number.isSafeInteger(block.pageEnd) || block.pageEnd < block.page ||
    !BLOCK_TYPES.includes(block.type)
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const text = normalizedText(block.text);
  const assetIds = block.assetIds.map((id) => assetIdMap.get(id));
  if (assetIds.some((id) => !id) || new Set(assetIds).size !== assetIds.length) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  if (!text && !(block.type === "image" && assetIds.length > 0)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const table = normalizedTable(block.table);
  if ((block.type === "table") !== block.isTable || (table && block.type !== "table")) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const boundingBoxes = normalizedBoundingBoxes(block.boundingBoxes);
  if (boundingBoxes.some((box) => box.page < block.page || box.page > block.pageEnd)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  return {
    assetIds: Object.freeze(assetIds as string[]),
    boundingBoxes,
    headingPath: normalizedHeadingPath(block.headingPath),
    languageHints: normalizedLanguages(block.languageHints.length > 0
      ? block.languageHints
      : parsedLanguageHints(text)),
    locator: Object.freeze({ kind: "page", pageEnd: block.pageEnd, pageStart: block.page }),
    table,
    text,
    type: block.type
  };
}

function normalizedBlocks(
  input: readonly ParsedDocumentBlock[],
  assetIdMap: ReadonlyMap<string, string>
): readonly KnowledgeNormalizedBlock[] {
  const occurrences = new Map<string, number>();
  return Object.freeze(input.map((block, order) => {
    if (block.index !== order || block.readingOrder !== order) {
      throw new KnowledgeNormalizedDocumentError("parser_rejected");
    }
    const content = blockContent(block, assetIdMap);
    const contentHash = canonicalHash(content);
    const occurrence = occurrences.get(contentHash) ?? 0;
    occurrences.set(contentHash, occurrence + 1);
    return Object.freeze({
      ...content,
      contentHash,
      id: `b_${contentHash.slice(0, 24)}_${occurrence}`,
      order
    });
  }));
}

function normalizedQuality(value: ParsedDocumentQuality): ParsedDocumentQuality {
  const ratios = [
    value.duplicateFurnitureRatio,
    value.emptyPageRatio,
    value.pageCoverage,
    ...(value.ocrConfidence === null ? [] : [value.ocrConfidence])
  ];
  if (
    ![value.characterCount, value.coveredPageCount, value.headingCount, value.tableCount, value.usableBlockCount]
      .every((item) => Number.isSafeInteger(item) && item >= 0) ||
    ratios.some((item) => !Number.isFinite(item) || item < 0 || item > 1) ||
    typeof value.encodingValid !== "boolean"
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return Object.freeze({ ...value });
}

function buildStoredDocument(
  parsed: ParsedDocument,
  metadata: Readonly<{ sourceDisplayName?: string | null; sourceMediaType?: string }> = {}
): StoredKnowledgeNormalizedDocument {
  if (
    !Number.isSafeInteger(parsed.pageCount) || parsed.pageCount < 1 ||
    parsed.quality.usableBlockCount < 1 || !parsed.quality.encodingValid
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const { assets, idMap } = normalizedAssets(parsed.assets);
  const blocks = normalizedBlocks(parsed.blocks, idMap);
  const fieldGroups = normalizedFieldGroups(parsed.fieldGroups, blocks.length);
  if (blocks.some((block) => block.locator.pageEnd > parsed.pageCount) ||
    assets.some((asset) => asset.locator.pageEnd > parsed.pageCount) ||
    fieldGroups.some((group) => group.locator.pageEnd > parsed.pageCount)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const warnings = Object.freeze(WARNING_CODES.filter((warning) => parsed.warnings.includes(warning)));
  const workbook = normalizedWorkbook(parsed.workbook);
  if ((parsed.engine === "spreadsheet") !== (workbook !== null)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const title = blocks.find((block) => block.type === "title")?.text ?? null;
  const sourceDisplayName = metadata.sourceDisplayName
    ? normalizedText(metadata.sourceDisplayName.replace(/[\u0000-\u001f\u007f]/gu, " "), 512)
    : null;
  const contentHash = canonicalHash({
    assets: assets.map((asset) => asset.contentHash),
    blocks: blocks.map((block) => block.contentHash),
    fieldGroups: fieldGroups.map((group) => group.contentHash),
    status: parsed.status,
    workbook
  });
  return Object.freeze({
    assets,
    blocks,
    contentHash,
    fieldGroups,
    languages: normalizedLanguages(parsed.languages),
    pageCount: parsed.pageCount,
    parser: Object.freeze({ attempts: attemptEvidence(parsed), engine: parsed.engine }),
    quality: normalizedQuality(parsed.quality),
    schemaVersion: 4 as const,
    source: Object.freeze({
      displayName: sourceDisplayName || null,
      mediaType: metadata.sourceMediaType ?? parsed.mediaType
    }),
    status: parsed.status,
    title,
    warnings,
    workbook
  });
}

function assertWithinLimits(
  document: StoredKnowledgeNormalizedDocument,
  config: KnowledgeExtractionConfig
): void {
  if (document.pageCount > config.maxPages) {
    throw new KnowledgeNormalizedDocumentError("knowledge_page_limit_exceeded");
  }
  if (
    document.blocks.length === 0 && document.fieldGroups.length === 0 ||
    document.quality.usableBlockCount === 0
  ) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const characterCount = document.blocks.reduce((total, block) => total + block.text.length, 0) +
    document.fieldGroups.reduce((total, group) => total + group.cells.reduce((cellTotal, cell) =>
      cellTotal + cell.text.length + cell.originalText.length, 0), 0);
  if (
    characterCount > config.maxNormalizedChars ||
    document.blocks.length + document.fieldGroups.length > config.maxChunksPerDocument * 4
  ) throw new KnowledgeNormalizedDocumentError("knowledge_text_limit_exceeded");
}

function layoutAwareBlockSegment(
  document: ParsedDocument,
  blocks: readonly ParsedDocumentBlock[]
): readonly ParsedDocumentBlock[] {
  if (blocks.length === 0) return Object.freeze([]);
  return withLayoutAwareTables(finalizeParsedDocument({
    assets: document.assets,
    attempts: document.attempts,
    blocks,
    engine: document.engine,
    fieldGroups: [],
    languages: document.languages,
    mediaType: document.mediaType,
    ocrConfidence: document.quality.ocrConfidence,
    pageCount: document.pageCount,
    status: document.status,
    warnings: document.warnings,
    workbook: document.workbook
  })).blocks;
}

/**
 * Field-group insertion points partition layout reconstruction. This keeps a
 * table merge from swallowing a parser-authored form/key-value position while
 * still allowing confident reconstruction inside each contiguous block run.
 */
function withLayoutAwareTablesAndFieldGroups(document: ParsedDocument): ParsedDocument {
  if (document.fieldGroups.length === 0) return withLayoutAwareTables(document);

  const blocks: ParsedDocumentBlock[] = [];
  const fieldGroups: ParsedFieldGroup[] = [];
  let sourceOffset = 0;
  for (const group of document.fieldGroups) {
    if (
      !Number.isSafeInteger(group.readingOrder) || group.readingOrder < sourceOffset ||
      group.readingOrder > document.blocks.length
    ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
    blocks.push(...layoutAwareBlockSegment(
      document,
      document.blocks.slice(sourceOffset, group.readingOrder)
    ));
    fieldGroups.push(Object.freeze({ ...group, readingOrder: blocks.length }));
    sourceOffset = group.readingOrder;
  }
  blocks.push(...layoutAwareBlockSegment(document, document.blocks.slice(sourceOffset)));
  const reindexedBlocks = blocks.map((block, index) => Object.freeze({
    ...block,
    index,
    readingOrder: index
  }));
  return finalizeParsedDocument({
    assets: document.assets,
    attempts: document.attempts,
    blocks: reindexedBlocks,
    engine: document.engine,
    fieldGroups,
    languages: document.languages,
    mediaType: document.mediaType,
    ocrConfidence: document.quality.ocrConfidence,
    pageCount: document.pageCount,
    status: document.status,
    warnings: document.warnings,
    workbook: document.workbook
  });
}

export function encodeKnowledgeNormalizedDocument(
  parsed: ParsedDocument,
  config: KnowledgeExtractionConfig,
  metadata: Readonly<{
    layoutAwareTables?: boolean;
    sourceDisplayName?: string | null;
    sourceMediaType?: string;
  }> = {}
): EncodedKnowledgeNormalizedDocument {
  const preparedDocument = metadata.layoutAwareTables
    ? withLayoutAwareTablesAndFieldGroups(parsed)
    : parsed;
  const document = buildStoredDocument(
    preparedDocument,
    metadata
  );
  assertWithinLimits(document, config);
  const body = Buffer.from(JSON.stringify(document), "utf8");
  if (body.byteLength > config.maxNormalizedObjectBytes) {
    throw new KnowledgeNormalizedDocumentError("knowledge_text_limit_exceeded");
  }
  return { body, checksum: sha256(body), document };
}

function parsedBox(value: unknown): ParsedBoundingBox | null {
  if (!isRecord(value)) return null;
  return normalizedBoundingBox(value as ParsedBoundingBox);
}

function parsedFieldCell(value: unknown, order: number): ParsedFieldCell | null {
  if (
    !isRecord(value) || !Array.isArray(value.boundingBoxes) || value.order !== order ||
    !Number.isSafeInteger(value.id) || Number(value.id) < 0 ||
    typeof value.originalText !== "string" || typeof value.text !== "string" ||
    (value.itemRef !== null && typeof value.itemRef !== "string")
  ) return null;
  const boundingBoxes = value.boundingBoxes.map(parsedBox);
  if (boundingBoxes.some((box) => box === null)) return null;
  try {
    return normalizedFieldCell({
      boundingBoxes: boundingBoxes as ParsedBoundingBox[],
      confidence: value.confidence as number | null,
      id: value.id as number,
      itemRef: value.itemRef as string | null,
      label: value.label as ParsedFieldCellLabel,
      order,
      originalText: value.originalText,
      text: value.text
    }, order);
  } catch {
    return null;
  }
}

function parsedFieldLink(value: unknown, order: number): ParsedFieldLink | null {
  if (
    !isRecord(value) || value.order !== order ||
    !Number.isSafeInteger(value.sourceCellId) || Number(value.sourceCellId) < 0 ||
    !Number.isSafeInteger(value.targetCellId) || Number(value.targetCellId) < 0
  ) return null;
  try {
    return normalizedFieldLink({
      confidence: value.confidence as number | null,
      label: value.label as ParsedFieldLinkLabel,
      order,
      sourceCellId: value.sourceCellId as number,
      targetCellId: value.targetCellId as number
    }, order);
  } catch {
    return null;
  }
}

function parsedV4FieldGroup(
  value: unknown,
  order: number,
  blockCount: number
): ParsedFieldGroup | null {
  if (
    !isRecord(value) || value.order !== order || typeof value.id !== "string" ||
    typeof value.contentHash !== "string" || !isRecord(value.locator) ||
    value.locator.kind !== "page" || !Array.isArray(value.boundingBoxes) ||
    !Array.isArray(value.cells) || !Array.isArray(value.links) ||
    !Number.isSafeInteger(value.locator.pageStart) ||
    !Number.isSafeInteger(value.locator.pageEnd) ||
    !Number.isSafeInteger(value.readingOrder) ||
    typeof value.sourceRef !== "string"
  ) return null;
  const boundingBoxes = value.boundingBoxes.map(parsedBox);
  const cells = value.cells.map(parsedFieldCell);
  const links = value.links.map(parsedFieldLink);
  if (
    boundingBoxes.some((box) => box === null) || cells.some((cell) => cell === null) ||
    links.some((link) => link === null)
  ) return null;
  const group: ParsedFieldGroup = {
    boundingBoxes: boundingBoxes as ParsedBoundingBox[],
    cells: cells as ParsedFieldCell[],
    confidence: value.confidence as number | null,
    kind: value.kind as ParsedFieldGroup["kind"],
    links: links as ParsedFieldLink[],
    page: value.locator.pageStart as number,
    pageEnd: value.locator.pageEnd as number,
    readingOrder: value.readingOrder as number,
    sourceRef: value.sourceRef
  };
  try {
    const normalized = fieldGroupContent(group, blockCount);
    return Object.freeze({
      boundingBoxes: normalized.boundingBoxes,
      cells: normalized.cells,
      confidence: normalized.confidence,
      kind: normalized.kind,
      links: normalized.links,
      page: normalized.locator.pageStart,
      pageEnd: normalized.locator.pageEnd,
      readingOrder: normalized.readingOrder,
      sourceRef: normalized.sourceRef
    });
  } catch {
    return null;
  }
}

function parsedTable(value: unknown): ParsedTable | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.cells)) return undefined;
  try {
    return normalizedTable({
      cells: value.cells as ParsedTableCell[],
      columnCount: Number(value.columnCount),
      rowCount: Number(value.rowCount)
    });
  } catch {
    return undefined;
  }
}

function parsedV2Block(value: unknown, index: number): ParsedDocumentBlock | null {
  if (
    !isRecord(value) || value.order !== index || typeof value.id !== "string" ||
    typeof value.contentHash !== "string" || !isRecord(value.locator) ||
    value.locator.kind !== "page" || !Array.isArray(value.headingPath) ||
    value.headingPath.some((item) => typeof item !== "string") ||
    !Array.isArray(value.assetIds) || value.assetIds.some((item) => typeof item !== "string") ||
    !Array.isArray(value.languageHints) || value.languageHints.some((item) => typeof item !== "string") ||
    !Array.isArray(value.boundingBoxes) || typeof value.text !== "string" ||
    !BLOCK_TYPES.includes(value.type as ParsedDocumentBlockType)
  ) return null;
  const boxes = value.boundingBoxes.map(parsedBox);
  const table = parsedTable(value.table);
  if (boxes.some((box) => box === null) || table === undefined) return null;
  const page = Number(value.locator.pageStart);
  const pageEnd = Number(value.locator.pageEnd);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageEnd) || pageEnd < page) return null;
  return Object.freeze({
    assetIds: Object.freeze(value.assetIds as string[]),
    boundingBoxes: Object.freeze(boxes as ParsedBoundingBox[]),
    headingPath: Object.freeze(value.headingPath as string[]),
    index,
    isTable: value.type === "table",
    languageHints: Object.freeze(value.languageHints as string[]),
    page,
    pageEnd,
    readingOrder: index,
    table,
    text: value.text,
    type: value.type as ParsedDocumentBlockType
  });
}

function parsedV2Asset(value: unknown): ParsedDocumentAsset | null {
  if (
    !isRecord(value) || typeof value.id !== "string" || typeof value.contentHash !== "string" ||
    !["chart", "diagram", "image"].includes(String(value.kind)) ||
    !isRecord(value.locator) || value.locator.kind !== "page" ||
    value.locator.pageStart !== value.locator.pageEnd ||
    !Array.isArray(value.boundingBoxes) ||
    (value.caption !== null && typeof value.caption !== "string")
  ) return null;
  const page = Number(value.locator.pageStart);
  const boxes = value.boundingBoxes.map(parsedBox);
  if (!Number.isSafeInteger(page) || page < 1 || boxes.some((box) => box === null)) return null;
  return Object.freeze({
    boundingBoxes: Object.freeze(boxes as ParsedBoundingBox[]),
    caption: value.caption as string | null,
    id: value.id,
    kind: value.kind as ParsedDocumentAsset["kind"],
    page
  });
}

function parsedAttempt(value: unknown): ParsedDocumentParserAttempt | null {
  if (!isRecord(value)) return null;
  try {
    return normalizedAttempt(value as ParsedDocumentParserAttempt);
  } catch {
    return null;
  }
}

function parsedWorkbook(value: unknown): ParsedWorkbook | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  try {
    return normalizedWorkbook(value as unknown as ParsedWorkbook);
  } catch {
    return undefined;
  }
}

function decodeV2ToV4(
  value: Record<string, unknown>,
  schemaVersion: 2 | 3 | 4
): StoredKnowledgeNormalizedDocument {
  if (
    !Array.isArray(value.blocks) || !Array.isArray(value.assets) ||
    (schemaVersion === 4 && !Array.isArray(value.fieldGroups)) ||
    !Array.isArray(value.languages) || value.languages.some((item) => typeof item !== "string") ||
    !Array.isArray(value.warnings) || value.warnings.some((item) => !WARNING_CODES.includes(item as ParsedDocumentWarningCode)) ||
    !isRecord(value.parser) || !Array.isArray(value.parser.attempts) ||
    !["docling", "inline", "spreadsheet", "tika"].includes(String(value.parser.engine)) ||
    !isRecord(value.source) || (value.source.displayName !== null && typeof value.source.displayName !== "string") ||
    typeof value.source.mediaType !== "string" || !isRecord(value.quality) ||
    (value.status !== "complete" && value.status !== "partial") ||
    !Number.isSafeInteger(value.pageCount) || Number(value.pageCount) < 1 ||
    typeof value.contentHash !== "string"
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const blocks = value.blocks.map(parsedV2Block);
  const assets = value.assets.map(parsedV2Asset);
  const attempts = value.parser.attempts.map(parsedAttempt);
  const fieldGroups = schemaVersion === 4
    ? (value.fieldGroups as unknown[]).map((group, index) =>
        parsedV4FieldGroup(group, index, blocks.length))
    : [];
  const workbook = schemaVersion >= 3 ? parsedWorkbook(value.workbook) : null;
  if (blocks.some((block) => block === null) || assets.some((asset) => asset === null) ||
    attempts.some((attempt) => attempt === null) || fieldGroups.some((group) => group === null) ||
    workbook === undefined) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const parsed = finalizeParsedDocument({
    assets: assets as ParsedDocumentAsset[],
    attempts: attempts as ParsedDocumentParserAttempt[],
    blocks: blocks as ParsedDocumentBlock[],
    engine: value.parser.engine as DocumentParserEngine,
    fieldGroups: fieldGroups as ParsedFieldGroup[],
    languages: value.languages as string[],
    mediaType: value.source.mediaType,
    ocrConfidence: typeof value.quality.ocrConfidence === "number"
      ? value.quality.ocrConfidence
      : null,
    pageCount: Number(value.pageCount),
    status: value.status,
    warnings: value.warnings as ParsedDocumentWarningCode[],
    workbook
  });
  const rebuilt = buildStoredDocument(parsed, {
    sourceDisplayName: value.source.displayName as string | null,
    sourceMediaType: value.source.mediaType
  });
  const storedBlockEvidence = value.blocks as Array<Record<string, unknown>>;
  const storedAssetEvidence = value.assets as Array<Record<string, unknown>>;
  const storedFieldGroupEvidence = schemaVersion === 4
    ? value.fieldGroups as Array<Record<string, unknown>>
    : [];
  const expectedContentHash = schemaVersion === 4
    ? rebuilt.contentHash
    : schemaVersion === 3
      ? canonicalHash({
          assets: rebuilt.assets.map((asset) => asset.contentHash),
          blocks: rebuilt.blocks.map((block) => block.contentHash),
          status: rebuilt.status,
          workbook: rebuilt.workbook
        })
      : canonicalHash({
        assets: rebuilt.assets.map((asset) => asset.contentHash),
        blocks: rebuilt.blocks.map((block) => block.contentHash),
        status: rebuilt.status
      });
  if (
    expectedContentHash !== value.contentHash ||
    rebuilt.blocks.some((block, index) =>
      block.id !== storedBlockEvidence[index]?.id ||
      block.contentHash !== storedBlockEvidence[index]?.contentHash) ||
    rebuilt.assets.some((asset, index) =>
      asset.id !== storedAssetEvidence[index]?.id ||
      asset.contentHash !== storedAssetEvidence[index]?.contentHash) ||
    schemaVersion === 4 && rebuilt.fieldGroups.some((group, index) =>
      group.id !== storedFieldGroupEvidence[index]?.id ||
      group.contentHash !== storedFieldGroupEvidence[index]?.contentHash)
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  return rebuilt;
}

function decodeLegacyV1(value: Record<string, unknown>): StoredKnowledgeNormalizedDocument {
  if (
    !["docling", "inline", "tika"].includes(String(value.parserEngine)) ||
    !Number.isSafeInteger(value.pageCount) || Number(value.pageCount) < 1 ||
    !Array.isArray(value.blocks)
  ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const blocks: ParsedDocumentBlock[] = value.blocks.map((candidate, index) => {
    if (
      !isRecord(candidate) || !Array.isArray(candidate.headingPath) ||
      candidate.headingPath.some((item) => typeof item !== "string") ||
      !Number.isSafeInteger(candidate.page) || Number(candidate.page) < 1 ||
      typeof candidate.text !== "string"
    ) throw new KnowledgeNormalizedDocumentError("parser_rejected");
    const text = normalizedText(candidate.text);
    if (!text) throw new KnowledgeNormalizedDocumentError("parser_rejected");
    return Object.freeze({
      assetIds: Object.freeze([]),
      boundingBoxes: Object.freeze([]),
      headingPath: normalizedHeadingPath(candidate.headingPath as string[]),
      index,
      isTable: false,
      languageHints: parsedLanguageHints(text),
      page: Number(candidate.page),
      pageEnd: Number(candidate.page),
      readingOrder: index,
      table: null,
      text,
      type: "paragraph" as const
    });
  });
  return buildStoredDocument(finalizeParsedDocument({
    blocks,
    engine: value.parserEngine as DocumentParserEngine,
    mediaType: "application/octet-stream",
    pageCount: Number(value.pageCount),
    status: "complete"
  }));
}

export function decodeKnowledgeNormalizedDocument(
  body: Buffer,
  config: KnowledgeExtractionConfig
): StoredKnowledgeNormalizedDocument {
  if (body.byteLength < 1 || body.byteLength > config.maxNormalizedObjectBytes) {
    throw new KnowledgeNormalizedDocumentError("knowledge_text_limit_exceeded");
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  if (!isRecord(value)) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  const document = value.schemaVersion === 4
    ? decodeV2ToV4(value, 4)
    : value.schemaVersion === 3
      ? decodeV2ToV4(value, 3)
      : value.schemaVersion === 2
        ? decodeV2ToV4(value, 2)
    : value.schemaVersion === 1
      ? decodeLegacyV1(value)
      : null;
  if (!document) throw new KnowledgeNormalizedDocumentError("parser_rejected");
  assertWithinLimits(document, config);
  return document;
}
