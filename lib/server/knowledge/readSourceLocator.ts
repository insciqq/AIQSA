import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  SPREADSHEET_MAX_COLUMNS_PER_SHEET,
  SPREADSHEET_MAX_ROWS_PER_SHEET
} from "../parsing/spreadsheetLimits";
import { KNOWLEDGE_QUERY_MAX_CHARACTERS } from "./retrievalTypes";
import { KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS } from "./documentContext";

export const READ_SOURCE_LOCATOR_CONTRACT_VERSION = 1 as const;
export const READ_SOURCE_DEFAULT_WINDOW = 3;
export const READ_SOURCE_MAX_WINDOW = KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS;

const HEADING_PATH_MAX_PARTS = 16;
const HEADING_PATH_PART_MAX_CHARACTERS = 256;
const SHEET_NAME_MAX_CHARACTERS = 256;
const PAGE_MAX = 999_999;
const DISALLOWED_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SECTION_ID = /^kis_[0-9a-f]{40}$/u;
const PASSAGE_ID = /^kip_[0-9a-f]{40}$/u;
const BLOCK_ID = /^b_[0-9a-f]{24}_(?:0|[1-9]\d{0,5})$/u;
const ROW_ID = /^ktr_[0-9a-f]{32}$/u;

export type ReadSourceDirection = "after" | "around" | "before";

export type ReadSourceLocator =
  | Readonly<{
      handle: string;
      kind: "evidence_handle";
    }>
  | Readonly<{
      kind: "page";
      page: number;
    }>
  | Readonly<{
      headingPath: readonly string[];
      kind: "heading";
    }>
  | Readonly<{
      kind: "section";
      sectionId: string;
    }>
  | Readonly<{
      kind: "passage";
      passageId: string;
    }>
  | Readonly<{
      blockId: string;
      kind: "block";
    }>
  | Readonly<{
      kind: "row";
      rowId: string;
    }>
  | Readonly<{
      kind: "structured_range";
      range: string;
      sheet: string;
    }>;

/**
 * Pure execution contract for one exact, Source-scoped read. The literal
 * `embedding: "forbidden"` field lets execution and persisted receipts reject
 * accidental routing through semantic retrieval instead of treating it as a
 * caller convention.
 */
export type NormalizedReadSourceRequest = Readonly<{
  contractVersion: typeof READ_SOURCE_LOCATOR_CONTRACT_VERSION;
  direction: ReadSourceDirection;
  embedding: "forbidden";
  locator: string;
  resolution: "exact";
  target: ReadSourceLocator;
  window: number;
}>;

function normalizedText(value: string, maximum: number, collapseWhitespace: boolean): string | null {
  if (DISALLOWED_TEXT.test(value)) return null;
  const normalized = value
    .normalize("NFKC")
    .trim();
  const compact = collapseWhitespace ? normalized.replace(/\s+/gu, " ") : normalized;
  return compact.length > 0 && compact.length <= maximum ? compact : null;
}

function evidenceHandle(value: string): ReadSourceLocator | null {
  const handle = normalizedText(value, 32, true);
  const decoded = handle ? decodeKnowledgeCitationHandle(handle) : null;
  return decoded
    ? Object.freeze({ handle: decoded.handle, kind: "evidence_handle" as const })
    : null;
}

function pageNumber(value: string): ReadSourceLocator | null {
  const match = /^#?\s*(\d{1,6})$/u.exec(value.trim());
  const page = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(page) && page >= 1 && page <= PAGE_MAX
    ? Object.freeze({ kind: "page" as const, page })
    : null;
}

function displayedPage(value: string): ReadSourceLocator | null {
  const match = /^(?:page|p\.?|страниц(?:а|е|у|ы)?|стр\.?)\s*(?::\s*|#\s*)?(\d{1,6})$/iu
    .exec(value.trim());
  return match ? pageNumber(match[1] ?? "") : null;
}

function heading(value: string): ReadSourceLocator | null {
  if (DISALLOWED_TEXT.test(value)) return null;
  const rawParts = value.normalize("NFKC").split(/\s*(?:›|>)\s*/u);
  if (rawParts.length < 1 || rawParts.length > HEADING_PATH_MAX_PARTS) return null;
  const parts = rawParts.map((part) =>
    normalizedText(part, HEADING_PATH_PART_MAX_CHARACTERS, true));
  if (parts.some((part) => part === null)) return null;
  const headingPath = Object.freeze(parts as string[]);
  const locator = `heading: ${headingPath.join(" › ")}`;
  return locator.length <= KNOWLEDGE_QUERY_MAX_CHARACTERS
    ? Object.freeze({ headingPath, kind: "heading" as const })
    : null;
}

function identityLocator(
  kind: "block" | "passage" | "row" | "section",
  value: string
): ReadSourceLocator | null {
  const id = normalizedText(value, 64, false);
  if (!id) return null;
  if (kind === "section" && SECTION_ID.test(id)) {
    return Object.freeze({ kind, sectionId: id });
  }
  if (kind === "passage" && PASSAGE_ID.test(id)) {
    return Object.freeze({ kind, passageId: id });
  }
  if (kind === "block" && BLOCK_ID.test(id)) {
    return Object.freeze({ blockId: id, kind });
  }
  if (kind === "row" && ROW_ID.test(id)) {
    return Object.freeze({ kind, rowId: id });
  }
  return null;
}

function columnIndex(value: string): number | null {
  let oneBased = 0;
  for (const character of value.toUpperCase()) {
    const digit = character.charCodeAt(0) - 64;
    if (digit < 1 || digit > 26) return null;
    oneBased = oneBased * 26 + digit;
  }
  const index = oneBased - 1;
  return index >= 0 && index < SPREADSHEET_MAX_COLUMNS_PER_SHEET ? index : null;
}

type Cell = Readonly<{
  column: number;
  columnLabel: string;
  row: number;
}>;

function cell(value: string): Cell | null {
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,5})$/u.exec(value.trim());
  if (!match) return null;
  const column = columnIndex(match[1] ?? "");
  const row = Number(match[2]);
  return column !== null && Number.isSafeInteger(row) &&
    row >= 1 && row <= SPREADSHEET_MAX_ROWS_PER_SHEET
    ? Object.freeze({ column, columnLabel: (match[1] ?? "").toUpperCase(), row })
    : null;
}

type A1Range = Readonly<{
  columnEnd: number;
  columnStart: number;
  rowEnd: number;
  rowStart: number;
  value: string;
}>;

function decodedA1Range(value: string): A1Range | null {
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 2) return null;
  const start = cell(parts[0] ?? "");
  const end = cell(parts[1] ?? parts[0] ?? "");
  if (!start || !end || start.column > end.column || start.row > end.row) return null;
  const startText = `${start.columnLabel}${start.row}`;
  const endText = `${end.columnLabel}${end.row}`;
  return Object.freeze({
    columnEnd: end.column,
    columnStart: start.column,
    rowEnd: end.row,
    rowStart: start.row,
    value: startText === endText ? startText : `${startText}:${endText}`
  });
}

function a1Range(value: string): string | null {
  return decodedA1Range(value)?.value ?? null;
}

export function readSourceA1RangeContains(container: string, target: string): boolean {
  const outer = decodedA1Range(container);
  const inner = decodedA1Range(target);
  return Boolean(outer && inner &&
    outer.columnStart <= inner.columnStart && outer.columnEnd >= inner.columnEnd &&
    outer.rowStart <= inner.rowStart && outer.rowEnd >= inner.rowEnd);
}

function splitStructuredTarget(value: string): Readonly<{ range: string; sheet: string }> | null {
  const input = value.trim();
  if (!input) return null;
  let sheet = "";
  let rangeText = "";
  if (input.startsWith("'")) {
    let cursor = 1;
    let closed = false;
    while (cursor < input.length) {
      if (input[cursor] !== "'") {
        sheet += input[cursor];
        cursor += 1;
        continue;
      }
      if (input[cursor + 1] === "'") {
        sheet += "'";
        cursor += 2;
        continue;
      }
      if (input[cursor + 1] !== "!") return null;
      rangeText = input.slice(cursor + 2);
      closed = true;
      break;
    }
    if (!closed) return null;
  } else {
    const separator = input.indexOf("!");
    if (separator <= 0 || input.indexOf("!", separator + 1) !== -1) return null;
    sheet = input.slice(0, separator);
    rangeText = input.slice(separator + 1);
  }
  const normalizedSheet = normalizedText(sheet, SHEET_NAME_MAX_CHARACTERS, false);
  const normalizedRange = a1Range(rangeText);
  return normalizedSheet && normalizedRange
    ? Object.freeze({ range: normalizedRange, sheet: normalizedSheet })
    : null;
}

function structuredRange(value: string): ReadSourceLocator | null {
  const target = splitStructuredTarget(value);
  return target
    ? Object.freeze({ kind: "structured_range" as const, ...target })
    : null;
}

function taggedLocator(tag: string, value: string): ReadSourceLocator | null | undefined {
  switch (tag.toLocaleLowerCase("und")) {
    case "evidence":
    case "handle":
    case "passage-handle":
      return evidenceHandle(value);
    case "page":
      return pageNumber(value);
    case "heading":
      return heading(value);
    case "section": {
      const identity = identityLocator("section", value);
      return identity ?? heading(value);
    }
    case "section-id":
      return identityLocator("section", value);
    case "passage":
    case "passage-id":
      return identityLocator("passage", value);
    case "block":
    case "block-id":
      return identityLocator("block", value);
    case "row":
    case "row-id":
    case "table-row":
      return identityLocator("row", value);
    case "range":
    case "structured":
      return structuredRange(value);
    default:
      return undefined;
  }
}

export function canonicalReadSourceLocator(locator: ReadSourceLocator): string {
  switch (locator.kind) {
    case "evidence_handle":
      return locator.handle;
    case "page":
      return `page ${locator.page}`;
    case "heading":
      return `heading: ${locator.headingPath.join(" › ")}`;
    case "section":
      return `section:${locator.sectionId}`;
    case "passage":
      return `passage:${locator.passageId}`;
    case "block":
      return `block:${locator.blockId}`;
    case "row":
      return `row:${locator.rowId}`;
    case "structured_range":
      return `range:'${locator.sheet.replaceAll("'", "''")}'!${locator.range}`;
  }
}

export function normalizeReadSourceLocator(value: unknown): ReadSourceLocator | null {
  if (typeof value !== "string" || value.length > KNOWLEDGE_QUERY_MAX_CHARACTERS ||
    DISALLOWED_TEXT.test(value)) return null;
  const input = value.normalize("NFKC").trim();
  if (!input || input.length > KNOWLEDGE_QUERY_MAX_CHARACTERS) return null;

  const tagged = /^([A-Za-z][A-Za-z-]*)\s*:\s*([\s\S]*)$/u.exec(input);
  if (tagged) {
    const parsed = taggedLocator(tagged[1] ?? "", tagged[2] ?? "");
    if (parsed !== undefined) return parsed;
  }

  const handle = evidenceHandle(input);
  if (handle) return handle;
  if (/^K[\d.]+$/iu.test(input)) return null;
  if (/^ktr_/iu.test(input)) return null;

  const page = displayedPage(input);
  if (page) return page;
  if (/^(?:page|p\.?|страниц(?:а|е|у|ы)?|стр\.?)\s*(?::\s*|#\s*)?[+-]?\d/iu.test(input)) {
    return null;
  }

  return heading(input);
}

export function normalizeReadSourceRequest(input: Readonly<{
  direction?: unknown;
  locator: unknown;
  window?: unknown;
}>): NormalizedReadSourceRequest | null {
  const direction = input.direction === undefined || input.direction === null
    ? "around"
    : input.direction;
  const window = input.window === undefined || input.window === null
    ? READ_SOURCE_DEFAULT_WINDOW
    : input.window;
  const target = normalizeReadSourceLocator(input.locator);
  if ((direction !== "after" && direction !== "around" && direction !== "before") ||
    !Number.isSafeInteger(window) || Number(window) < 1 || Number(window) > READ_SOURCE_MAX_WINDOW ||
    !target) return null;
  const locator = canonicalReadSourceLocator(target);
  if (locator.length > KNOWLEDGE_QUERY_MAX_CHARACTERS) return null;
  return Object.freeze({
    contractVersion: READ_SOURCE_LOCATOR_CONTRACT_VERSION,
    direction,
    embedding: "forbidden",
    locator,
    resolution: "exact",
    target,
    window: Number(window)
  });
}
