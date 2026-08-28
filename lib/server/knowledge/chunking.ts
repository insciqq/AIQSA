import { createHash } from "node:crypto";
import {
  MAX_EMBEDDING_BATCH_INPUTS,
  MAX_EMBEDDING_INPUT_CHARS,
  MAX_EMBEDDING_REQUEST_BYTES
} from "../providers/embeddings";
import {
  createKnowledgeFieldContextSegments,
  createKnowledgeTableDocumentContext,
  KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS,
  KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS,
  KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
  KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES,
  normalizeKnowledgeObservationValue,
  normalizeKnowledgeTableHeaderPeriodV1,
  type KnowledgeDocumentContextV1,
  type KnowledgeTableContextCell,
  type KnowledgeTableHeaderLineageV1
} from "./documentContext";
import {
  KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  KNOWLEDGE_CONSERVATIVE_FURNITURE_PROFILE_MIN_VERSION,
  KNOWLEDGE_DOCUMENT_CONTEXT_CHUNKING_PROFILE_MIN_VERSION,
  KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION,
  KNOWLEDGE_NEUTRAL_EMBEDDING_FORMAT_PROFILE_MIN_VERSION,
  KNOWLEDGE_REPEATED_TABLE_HEADER_PROFILE_MIN_VERSION,
  KNOWLEDGE_TOKEN_SIZED_CHUNKING_PROFILE_MIN_VERSION
} from "./indexProfile";
import type {
  KnowledgeNormalizedBlock,
  KnowledgeNormalizedFieldGroup,
  StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";
import type { KnowledgeTokenCounter } from "./tokenizer/types";

export const KNOWLEDGE_CHUNK_MAX_TOKENS = 400;
export const KNOWLEDGE_CHUNK_OVERLAP_TOKENS = 48;
/**
 * FR-14 child-to-parent expansion budget in model tokens, counted with the
 * profile token counter. Constant only in this slice; the expansion itself is
 * a later vertical slice.
 */
export const KNOWLEDGE_PARENT_CONTEXT_MAX_TOKENS = 900;
/** Hard defensive ceiling; v2 admission is token-oriented. */
export const KNOWLEDGE_CHUNK_MAX_CHARS = 12_000;
export const KNOWLEDGE_CHUNK_MAX_UTF8_BYTES = 48_000;
export const KNOWLEDGE_CHUNK_CONTEXT_MAX_TOKENS = 96;
/** Legacy profile-1 character overlap retained for old immutable revisions. */
export const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 200;
export const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 64;
export const KNOWLEDGE_EMBEDDING_BATCH_MAX_TOKENS = 16_000;
export const KNOWLEDGE_EMBEDDING_BATCH_MAX_UTF8_BYTES = 48_000;
export const KNOWLEDGE_FURNITURE_EDGE_FRACTION = 0.15;
export const KNOWLEDGE_FURNITURE_MIN_PAGE_FRACTION = 0.5;
export const KNOWLEDGE_FURNITURE_MAX_POSITION_DRIFT = 0.05;

export type KnowledgeChunkLayoutKind =
  | "body"
  | "field_ambiguous"
  | "field_pair"
  | "table_ambiguous"
  | "table_row"
  | "table_row_projection";

export type KnowledgeChunkPlanEntry = Readonly<{
  contentHash: string;
  contextPrefix: string;
  documentContext: KnowledgeDocumentContextV1 | null;
  embeddingText: string;
  embeddingTextHash: string;
  headingPath: readonly string[];
  index: number;
  /** Structured layout identity (FR-12): persisted on the passage row instead
   * of being encoded as an English marker inside the dense embedding text. */
  layoutKind: KnowledgeChunkLayoutKind;
  page: number;
  pageEnd: number;
  sourceBlockEnd: number;
  sourceBlockIds: readonly string[];
  sourceBlockStart: number;
  text: string;
  tokenCount: number;
}>;

export type KnowledgeChunkingErrorCode =
  | "chunking_failed"
  | "knowledge_chunk_limit_exceeded";

export class KnowledgeChunkingError extends Error {
  constructor(readonly code: KnowledgeChunkingErrorCode) {
    super(code);
    this.name = "KnowledgeChunkingError";
  }
}

type Segment = Readonly<{
  blockEnd: number;
  blockIds: readonly string[];
  blockStart: number;
  headingPath: readonly string[];
  documentContext: KnowledgeDocumentContextV1 | null;
  layoutKind:
    | "body"
    | "field_ambiguous"
    | "field_pair"
    | "table_ambiguous"
    | "table_row"
    | "table_row_projection";
  pageEnd: number;
  pageStart: number;
  text: string;
  tokenCount: number;
  type: KnowledgeNormalizedBlock["type"];
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHeading(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedContextValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function legacyKnowledgeTokenCount(text: string): number {
  const lexical = text.match(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, lexical);
}

export function approximateKnowledgeTokenCount(text: string): number {
  const lexical = legacyKnowledgeTokenCount(text);
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const codePoints = [...text].length;
  const longRuns = text.match(/\S{33,}/gu) ?? [];
  const hostileRunEstimate = longRuns.reduce((total, run) =>
    total + Math.ceil(Buffer.byteLength(run, "utf8") * 2 / 3), 0);
  return Math.max(
    1,
    lexical,
    Math.ceil(utf8Bytes / 3),
    Math.ceil(codePoints / 2),
    hostileRunEstimate
  );
}

/**
 * Model-profile token counting for token-sized chunking profiles. Profile 7
 * counts with the deployment's resolved token counter (model-native BPE for
 * the built-in Qwen3 embedding profile, the generic Unicode estimator for
 * custom deployments); profile 6 keeps the generic estimator exactly. Both
 * entry points below are synchronous, so the active counter is scoped to one
 * call with try/finally and never observed concurrently.
 */
let activeTokenCounter: KnowledgeTokenCounter | null = null;

function sizedTokenCount(text: string): number {
  return activeTokenCounter
    ? Math.max(1, activeTokenCounter.countTokens(text))
    : approximateKnowledgeTokenCount(text);
}

function tokenBoundaries(text: string): Array<{ end: number; start: number }> {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0
  }));
}

function codePointSafeEnd(text: string, end: number): number {
  if (
    end > 0 && end < text.length &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? "")
  ) return end - 1;
  return end;
}

function splitTextByTokens(text: string): Array<{ text: string; tokenCount: number }> {
  if (!text.trim()) return [];
  const result: Array<{ text: string; tokenCount: number }> = [];
  let start = 0;
  while (start < text.length) {
    while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
    if (start >= text.length) break;

    let low = start + 1;
    let high = Math.min(text.length, start + KNOWLEDGE_CHUNK_MAX_CHARS);
    let acceptedEnd = start;
    while (low <= high) {
      const midpoint = codePointSafeEnd(text, Math.floor((low + high) / 2));
      if (midpoint <= start) {
        low += 1;
        continue;
      }
      const candidate = text.slice(start, midpoint);
      if (legacyKnowledgeTokenCount(candidate) <= KNOWLEDGE_CHUNK_MAX_TOKENS) {
        acceptedEnd = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (acceptedEnd <= start) throw new KnowledgeChunkingError("chunking_failed");

    if (acceptedEnd < text.length) {
      const minimumSemanticBreak = start + Math.floor((acceptedEnd - start) * 0.6);
      for (let index = acceptedEnd; index > minimumSemanticBreak; index -= 1) {
        if (/\s/u.test(text[index - 1] ?? "")) {
          acceptedEnd = index;
          break;
        }
      }
    }

    const value = text.slice(start, acceptedEnd).trim();
    if (!value) throw new KnowledgeChunkingError("chunking_failed");
    const tokenCount = legacyKnowledgeTokenCount(value);
    if (tokenCount > KNOWLEDGE_CHUNK_MAX_TOKENS || value.length > KNOWLEDGE_CHUNK_MAX_CHARS) {
      throw new KnowledgeChunkingError("chunking_failed");
    }
    result.push({ text: value, tokenCount });
    if (acceptedEnd >= text.length) break;

    const boundaries = tokenBoundaries(text.slice(start, acceptedEnd));
    const overlapBoundary = boundaries.length > 1
      ? boundaries[Math.max(1, boundaries.length - KNOWLEDGE_CHUNK_OVERLAP_TOKENS)]
      : undefined;
    const next = overlapBoundary ? start + overlapBoundary.start : acceptedEnd;
    start = next > start ? next : acceptedEnd;
  }
  return result;
}

function tableRows(block: KnowledgeNormalizedBlock): string[] {
  if (!block.table) return block.text ? [block.text] : [];
  const rows = Array.from(
    { length: block.table.rowCount },
    () => Array<string>(block.table!.columnCount).fill("")
  );
  for (const cell of block.table.cells) rows[cell.row]![cell.column] = cell.text;
  return rows.map((row) => row.join("\t").trimEnd()).filter(Boolean);
}

function profile3TableSegments(block: KnowledgeNormalizedBlock): Segment[] {
  const rows = tableRows(block);
  if (rows.length === 0) return [];
  return rows.flatMap((row) => {
    const parts = splitTextByTokens(row);
    if (block.table && parts.length !== 1) {
      // A recognized row is one atomic evidence unit. Splitting it would make
      // cell association unverifiable, so an oversized row fails closed.
      throw new KnowledgeChunkingError("chunking_failed");
    }
    if (parts.length === 0) throw new KnowledgeChunkingError("chunking_failed");
    return parts.map((part) => Object.freeze({
      blockEnd: block.order,
      blockIds: Object.freeze([block.id]),
      blockStart: block.order,
      documentContext: null,
      headingPath: block.headingPath,
      layoutKind: block.table ? "table_row" as const : "table_ambiguous" as const,
      pageEnd: block.locator.pageEnd,
      pageStart: block.locator.pageStart,
      text: part.text,
      tokenCount: part.tokenCount,
      type: block.type
    }));
  });
}

type TableGridCell = Readonly<{
  columnEnd: number;
  columnStart: number;
  key: string;
  rowEnd: number;
  rowStart: number;
  text: string;
}>;

type TableGrid = Readonly<{
  columnCount: number;
  rowCount: number;
  slots: readonly (readonly (TableGridCell | null)[])[];
}>;

function tableGrid(block: KnowledgeNormalizedBlock): TableGrid {
  if (!block.table) throw new KnowledgeChunkingError("chunking_failed");
  const slots = Array.from(
    { length: block.table.rowCount },
    () => Array<TableGridCell | null>(block.table!.columnCount).fill(null)
  );
  for (const [cellIndex, cell] of block.table.cells.entries()) {
    const entry = Object.freeze({
      columnEnd: cell.column + cell.columnSpan - 1,
      columnStart: cell.column,
      key: `${cellIndex}:${cell.row}:${cell.column}`,
      rowEnd: cell.row + cell.rowSpan - 1,
      rowStart: cell.row,
      text: cell.text
    });
    for (let row = entry.rowStart; row <= entry.rowEnd; row += 1) {
      for (let column = entry.columnStart; column <= entry.columnEnd; column += 1) {
        if (slots[row]![column]) throw new KnowledgeChunkingError("chunking_failed");
        slots[row]![column] = entry;
      }
    }
  }
  return Object.freeze({
    columnCount: block.table.columnCount,
    rowCount: block.table.rowCount,
    slots: Object.freeze(slots.map((row) => Object.freeze(row)))
  });
}

function cellsForRange(
  grid: TableGrid,
  rowIndex: number,
  columnStart: number,
  columnEnd: number
): readonly KnowledgeTableContextCell[] {
  const cells = new Map<string, KnowledgeTableContextCell>();
  for (let column = columnStart; column <= columnEnd; column += 1) {
    const cell = grid.slots[rowIndex]?.[column] ?? null;
    if (!cell || cells.has(cell.key) || !cell.text.trim()) continue;
    cells.set(cell.key, Object.freeze({
      columnEnd: Math.min(cell.columnEnd, columnEnd),
      columnStart: Math.max(cell.columnStart, columnStart),
      text: cell.text
    }));
  }
  return Object.freeze([...cells.values()]);
}

function headerLineageForRange(
  grid: TableGrid,
  headerRowIndex: number,
  columnStart: number,
  columnEnd: number
): readonly KnowledgeTableHeaderLineageV1[] {
  return Object.freeze(cellsForRange(grid, headerRowIndex, columnStart, columnEnd).flatMap((cell) =>
    cell.text.length <= KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS
      ? [Object.freeze({ ...cell, rowIndex: headerRowIndex })]
      : []));
}

function tableRowLine(
  grid: TableGrid,
  rowIndex: number,
  columnStart: number,
  columnEnd: number
): string {
  const values = Array<string>(columnEnd - columnStart + 1).fill("");
  const emitted = new Set<string>();
  for (let column = columnStart; column <= columnEnd; column += 1) {
    const cell = grid.slots[rowIndex]?.[column] ?? null;
    if (!cell || emitted.has(cell.key)) continue;
    emitted.add(cell.key);
    values[Math.max(cell.columnStart, columnStart) - columnStart] = cell.text;
  }
  return values.join("\t").trimEnd();
}

function tableRowSignature(grid: TableGrid, rowIndex: number): string {
  return tableRowLine(grid, rowIndex, 0, grid.columnCount - 1)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("und");
}

function tableRowHasNumericOrDateObservation(grid: TableGrid, rowIndex: number): boolean {
  if (/(?<![\p{L}\p{N}])(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|[+-]?\d+(?:[.,]\d+)?%?)(?![\p{L}\p{N}])/u
    .test(tableRowLine(grid, rowIndex, 0, grid.columnCount - 1))) return true;
  return cellsForRange(grid, rowIndex, 0, grid.columnCount - 1).some((cell) => {
    const value = normalizeKnowledgeObservationValue(cell.text);
    return value.ambiguityReasons.length === 0 && value.normalizedValue !== null &&
      (value.kind === "date" || value.kind === "number" || value.kind === "number_range");
  });
}

function tableRowIsDatedSeriesHeader(grid: TableGrid, rowIndex: number): boolean {
  const cells = cellsForRange(grid, rowIndex, 0, grid.columnCount - 1);
  if (cells.length < 3) return false;
  const label = cells[0]!.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  // Typed-data shape only: a textual leading label followed entirely by
  // bounded year/quarter periods (or one slash-separated pair). No English/
  // Russian vocabulary is allowed to decide the chunking path.
  if (!label || !/[\p{L}\p{M}]/u.test(label) ||
    normalizeKnowledgeObservationValue(label).kind !== "text") return false;
  return cells.slice(1).every((cell) => {
    const periods = cell.text.normalize("NFKC").replace(/\s+/gu, " ").trim()
      .split(/\s*\/\s*/u);
    return periods.length >= 1 && periods.length <= 2 && periods.every((period) =>
      normalizeKnowledgeTableHeaderPeriodV1(period) !== null);
  });
}

function repeatedPageTableHeaderRows(
  blocks: readonly KnowledgeNormalizedBlock[]
): ReadonlyMap<string, number> {
  const candidates = blocks.flatMap((block) => {
    if (!block.table || block.table.columnCount < 2 || block.table.rowCount < 2 ||
      block.locator.pageStart !== block.locator.pageEnd) return [];
    const grid = tableGrid(block);
    const nonEmptyRows = Array.from({ length: grid.rowCount }, (_, rowIndex) => rowIndex)
      .filter((rowIndex) => Boolean(tableRowSignature(grid, rowIndex)));
    if (nonEmptyRows.length < 2) return [];
    const rowIndex = nonEmptyRows[0]!;
    if (cellsForRange(grid, rowIndex, 0, grid.columnCount - 1).length < 2) return [];
    return [{
      blockId: block.id,
      key: `${grid.columnCount}\u0000${tableRowSignature(grid, rowIndex)}`,
      page: block.locator.pageStart,
      rowIndex
    }];
  });
  const byKey = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = byKey.get(candidate.key) ?? [];
    group.push(candidate);
    byKey.set(candidate.key, group);
  }
  const result = new Map<string, number>();
  for (const group of byKey.values()) {
    if (new Set(group.map((candidate) => candidate.page)).size < 2) continue;
    for (const candidate of group) result.set(candidate.blockId, candidate.rowIndex);
  }
  return result;
}

function boundedChunkText(text: string, currentSizing = false): boolean {
  const maximumTokens = currentSizing
    ? KNOWLEDGE_CHUNK_MAX_TOKENS - KNOWLEDGE_CHUNK_CONTEXT_MAX_TOKENS - 4
    : KNOWLEDGE_CHUNK_MAX_TOKENS;
  const tokenCount = currentSizing
    ? sizedTokenCount(text)
    : legacyKnowledgeTokenCount(text);
  return Boolean(text.trim()) && text.length <= KNOWLEDGE_CHUNK_MAX_CHARS &&
    tokenCount <= maximumTokens;
}

function renderedTableProjection(input: Readonly<{
  columnEnd: number;
  columnStart: number;
  grid: TableGrid;
  headerRowIndex: number | null;
  rowIndex: number;
  rowKind: "data" | "header";
}>): string {
  const row = tableRowLine(input.grid, input.rowIndex, input.columnStart, input.columnEnd);
  if (input.rowKind === "header" || input.headerRowIndex === null) return row;
  const header = tableRowLine(
    input.grid,
    input.headerRowIndex,
    input.columnStart,
    input.columnEnd
  );
  return [header, row].filter(Boolean).join("\n");
}

function rangeContainsWholeCells(
  grid: TableGrid,
  rowIndex: number,
  columnStart: number,
  columnEnd: number
): boolean {
  const visited = new Set<string>();
  for (let column = columnStart; column <= columnEnd; column += 1) {
    const cell = grid.slots[rowIndex]?.[column] ?? null;
    if (!cell || visited.has(cell.key) || !cell.text.trim()) continue;
    visited.add(cell.key);
    if (cell.columnStart < columnStart || cell.columnEnd > columnEnd) return false;
  }
  return true;
}

function splitProjectionPayload(
  prefix: string,
  payload: string,
  maximumParts = KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
  currentSizing = false
): readonly string[] | null {
  if (!payload.trim()) throw new KnowledgeChunkingError("chunking_failed");
  if (prefix && !boundedChunkText(prefix, currentSizing)) return null;
  const result: string[] = [];
  let start = 0;
  while (start < payload.length) {
    while (start < payload.length && /\s/u.test(payload[start] ?? "")) start += 1;
    if (start >= payload.length) break;
    let low = start + 1;
    let high = Math.min(
      payload.length,
      start + Math.min(KNOWLEDGE_CHUNK_MAX_CHARS, KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS)
    );
    let acceptedEnd = start;
    while (low <= high) {
      const midpoint = codePointSafeEnd(payload, Math.floor((low + high) / 2));
      if (midpoint <= start) {
        low += 1;
        continue;
      }
      const candidate = `${prefix}${payload.slice(start, midpoint).trim()}`;
      if (boundedChunkText(candidate, currentSizing)) {
        acceptedEnd = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (acceptedEnd <= start) throw new KnowledgeChunkingError("chunking_failed");
    if (acceptedEnd < payload.length) {
      const minimumBreak = start + Math.floor((acceptedEnd - start) * 0.6);
      for (let cursor = acceptedEnd; cursor > minimumBreak; cursor -= 1) {
        if (/\s/u.test(payload[cursor - 1] ?? "")) {
          acceptedEnd = cursor;
          break;
        }
      }
    }
    const value = payload.slice(start, acceptedEnd).trim();
    if (!value) throw new KnowledgeChunkingError("chunking_failed");
    result.push(`${prefix}${value}`);
    start = acceptedEnd;
  }
  if (result.length < 1) throw new KnowledgeChunkingError("chunking_failed");
  if (result.length > maximumParts) return null;
  return Object.freeze(result);
}

type TableProjectionDraft = Readonly<{
  cells: readonly KnowledgeTableContextCell[];
  columnEnd: number;
  columnStart: number;
  headerLineage: readonly KnowledgeTableHeaderLineageV1[];
  text: string;
}>;

function oversizedTableRowProjections(input: Readonly<{
  currentSizing: boolean;
  grid: TableGrid;
  headerRowIndex: number | null;
  rowIndex: number;
  rowKind: "data" | "header";
}>): readonly TableProjectionDraft[] | null {
  const drafts: TableProjectionDraft[] = [];
  let columnStart = 0;
  while (columnStart < input.grid.columnCount) {
    let targetCell: TableGridCell | null = null;
    for (let column = columnStart; column < input.grid.columnCount; column += 1) {
      const cell = input.grid.slots[input.rowIndex]?.[column] ?? null;
      if (cell?.text.trim()) {
        targetCell = cell;
        break;
      }
    }
    if (!targetCell) break;
    let acceptedEnd = -1;
    let acceptedText = "";
    for (let columnEnd = columnStart; columnEnd < input.grid.columnCount; columnEnd += 1) {
      const cells = cellsForRange(input.grid, input.rowIndex, columnStart, columnEnd);
      if (cells.length === 0) continue;
      const candidate = renderedTableProjection({ ...input, columnEnd, columnStart });
      if (!boundedChunkText(candidate, input.currentSizing) || cells.some((cell) =>
        cell.text.length > KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS)) break;
      if (!rangeContainsWholeCells(input.grid, input.rowIndex, columnStart, columnEnd) ||
        input.headerRowIndex !== null && !rangeContainsWholeCells(
          input.grid,
          input.headerRowIndex,
          columnStart,
          columnEnd
        )) continue;
      acceptedEnd = columnEnd;
      acceptedText = candidate;
    }
    if (acceptedEnd >= columnStart) {
      drafts.push(Object.freeze({
        cells: cellsForRange(input.grid, input.rowIndex, columnStart, acceptedEnd),
        columnEnd: acceptedEnd,
        columnStart,
        headerLineage: input.headerRowIndex === null
          ? Object.freeze([])
          : headerLineageForRange(
              input.grid,
              input.headerRowIndex,
              columnStart,
              acceptedEnd
            ),
        text: acceptedText
      }));
      if (drafts.length > KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS) return null;
      columnStart = acceptedEnd + 1;
      continue;
    }

    if (targetCell.columnStart < columnStart) throw new KnowledgeChunkingError("chunking_failed");
    const columnEnd = targetCell.columnEnd;
    if (!rangeContainsWholeCells(input.grid, input.rowIndex, columnStart, columnEnd) ||
      input.headerRowIndex !== null && !rangeContainsWholeCells(
        input.grid,
        input.headerRowIndex,
        columnStart,
        columnEnd
      )) return null;
    const header = input.rowKind === "header" || input.headerRowIndex === null
      ? ""
      : tableRowLine(input.grid, input.headerRowIndex, columnStart, columnEnd);
    const payload = targetCell.text;
    const prefix = header ? `${header}\n` : "";
    const pieces = splitProjectionPayload(
      prefix,
      payload,
      KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
      input.currentSizing
    );
    if (!pieces) return null;
    const headerLineage = input.headerRowIndex === null
      ? Object.freeze([])
      : headerLineageForRange(
          input.grid,
          input.headerRowIndex,
          columnStart,
          columnEnd
        );
    for (const piece of pieces) {
      const rawValue = prefix ? piece.slice(prefix.length) : piece;
      drafts.push(Object.freeze({
        cells: Object.freeze([{
          columnEnd: targetCell.columnEnd,
          columnStart: targetCell.columnStart,
          text: rawValue
        }]),
        columnEnd,
        columnStart,
        headerLineage,
        text: piece
      }));
      if (drafts.length > KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS) return null;
    }
    columnStart = columnEnd + 1;
  }
  if (drafts.length === 0) return null;
  if (drafts.reduce((bytes, draft) => bytes + Buffer.byteLength(draft.text, "utf8"), 0) >
    KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES) return null;
  return Object.freeze(drafts);
}

function ambiguousTableRowSegments(
  block: KnowledgeNormalizedBlock,
  text: string
): readonly Segment[] {
  const parts = splitTextByTokens(text);
  if (parts.length < 1) throw new KnowledgeChunkingError("chunking_failed");
  return Object.freeze(parts.map((part) => Object.freeze({
    blockEnd: block.order,
    blockIds: Object.freeze([block.id]),
    blockStart: block.order,
    documentContext: null,
    headingPath: block.headingPath,
    layoutKind: "table_ambiguous" as const,
    pageEnd: block.locator.pageEnd,
    pageStart: block.locator.pageStart,
    text: part.text,
    tokenCount: part.tokenCount,
    type: block.type
  })));
}

function tableDocumentContext(
  input: Parameters<typeof createKnowledgeTableDocumentContext>[0]
): KnowledgeDocumentContextV1 {
  try {
    return createKnowledgeTableDocumentContext(input);
  } catch {
    throw new KnowledgeChunkingError("chunking_failed");
  }
}

function profile4TableSegments(
  block: KnowledgeNormalizedBlock,
  currentSizing: boolean,
  repeatedHeaderRow: number | null
): Segment[] {
  const grid = tableGrid(block);
  const nonEmptyRows = Array.from({ length: grid.rowCount }, (_, rowIndex) => rowIndex)
    .filter((rowIndex) => Boolean(tableRowSignature(grid, rowIndex)));
  if (nonEmptyRows.length === 0) return [];
  const firstRow = nonEmptyRows[0]!;
  const hasFollowingObservation = nonEmptyRows.slice(1)
    .some((rowIndex) => tableRowHasNumericOrDateObservation(grid, rowIndex));
  const canonicalHeaderRow = repeatedHeaderRow === firstRow
    ? firstRow
    : hasFollowingObservation && (
      !tableRowHasNumericOrDateObservation(grid, firstRow) ||
      tableRowIsDatedSeriesHeader(grid, firstRow)
    )
      ? firstRow
      : null;
  const headerSignature = canonicalHeaderRow === null ? null : tableRowSignature(grid, canonicalHeaderRow);
  const headerRows = new Set(canonicalHeaderRow === null ? [] : nonEmptyRows.filter((rowIndex) =>
    tableRowSignature(grid, rowIndex) === headerSignature));
  let activeHeaderRow: number | null = canonicalHeaderRow;
  const result: Segment[] = [];
  for (const rowIndex of nonEmptyRows) {
    if (headerRows.has(rowIndex)) activeHeaderRow = rowIndex;
    const rowKind = headerRows.has(rowIndex) ? "header" as const : "data" as const;
    const text = renderedTableProjection({
      columnEnd: grid.columnCount - 1,
      columnStart: 0,
      grid,
      headerRowIndex: activeHeaderRow,
      rowIndex,
      rowKind
    });
    const cells = cellsForRange(grid, rowIndex, 0, grid.columnCount - 1);
    if (boundedChunkText(text, currentSizing) && Buffer.byteLength(text, "utf8") <=
      KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES && cells.every((cell) =>
        cell.text.length <= KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS)) {
      if (cells.length === 0) continue;
      result.push(Object.freeze({
        blockEnd: block.order,
        blockIds: Object.freeze([block.id]),
        blockStart: block.order,
        documentContext: tableDocumentContext({
          blockId: block.id,
          cells,
          headerLineage: activeHeaderRow === null
            ? Object.freeze([])
            : headerLineageForRange(
                grid,
                activeHeaderRow,
                0,
                grid.columnCount - 1
              ),
          rowIndex,
          rowKind
        }),
        headingPath: block.headingPath,
        layoutKind: "table_row",
        pageEnd: block.locator.pageEnd,
        pageStart: block.locator.pageStart,
        text,
        tokenCount: currentSizing
          ? sizedTokenCount(text)
          : legacyKnowledgeTokenCount(text),
        type: block.type
      }));
      continue;
    }
    const projections = oversizedTableRowProjections({
      currentSizing,
      grid,
      headerRowIndex: activeHeaderRow,
      rowIndex,
      rowKind
    });
    if (!projections) {
      // One row must remain atomically readable. If its bounded representation
      // exceeds the read contract, retain searchable source text without
      // publishing a typed row locator that no reader can complete.
      result.push(...ambiguousTableRowSegments(block, text));
      continue;
    }
    result.push(...projections.map((projection, projectionIndex) => Object.freeze({
      blockEnd: block.order,
      blockIds: Object.freeze([block.id]),
      blockStart: block.order,
      documentContext: tableDocumentContext({
        blockId: block.id,
        cells: projection.cells,
        columnEnd: projection.columnEnd,
        columnStart: projection.columnStart,
        headerLineage: projection.headerLineage,
        projectionCount: projections.length,
        projectionIndex,
        rowIndex,
        rowKind
      }),
      headingPath: block.headingPath,
      layoutKind: "table_row_projection" as const,
      pageEnd: block.locator.pageEnd,
      pageStart: block.locator.pageStart,
      text: projection.text,
      tokenCount: currentSizing
        ? sizedTokenCount(projection.text)
        : legacyKnowledgeTokenCount(projection.text),
      type: block.type
    })));
  }
  return result;
}

function profile2TableSegments(block: KnowledgeNormalizedBlock): Segment[] {
  const rows = tableRows(block);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const result: Segment[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n");
    for (const split of splitTextByTokens(text)) {
      result.push(Object.freeze({
        blockEnd: block.order,
        blockIds: Object.freeze([block.id]),
        blockStart: block.order,
        documentContext: null,
        headingPath: block.headingPath,
        layoutKind: "body",
        pageEnd: block.locator.pageEnd,
        pageStart: block.locator.pageStart,
        text: split.text,
        tokenCount: split.tokenCount,
        type: block.type
      }));
    }
    current = [];
  };
  for (const [index, row] of rows.entries()) {
    const candidateRows = current.length === 0
      ? index === 0 ? [row] : [header, row]
      : [...current, row];
    const text = candidateRows.join("\n");
    if (current.length > 0 && (
      legacyKnowledgeTokenCount(text) > KNOWLEDGE_CHUNK_MAX_TOKENS ||
      text.length > KNOWLEDGE_CHUNK_MAX_CHARS
    )) {
      flush();
      current = index === 0 ? [row] : [header, row];
    } else {
      current = candidateRows;
    }
  }
  flush();
  return result;
}

function furnitureKey(block: KnowledgeNormalizedBlock): string {
  return sha256(block.text.replace(/\s+/gu, " ").trim().toLowerCase());
}

function legacyRepeatedFurniture(blocks: readonly KnowledgeNormalizedBlock[]): Set<string> {
  const pagesByKey = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (!block.text || block.text.length > 240 || block.type === "title" || block.type === "heading") continue;
    const key = furnitureKey(block);
    const pages = pagesByKey.get(key) ?? new Set<number>();
    pages.add(block.locator.pageStart);
    pagesByKey.set(key, pages);
  }
  const keys = new Set([...pagesByKey]
    .filter(([, pages]) => pages.size >= 3)
    .map(([key]) => key));
  return new Set(blocks.filter((block) => keys.has(furnitureKey(block))).map((block) => block.id));
}

type PageVerticalExtent = Readonly<{
  maximum: number;
  minimum: number;
}>;

function verticalExtents(
  blocks: readonly KnowledgeNormalizedBlock[]
): ReadonlyMap<string, PageVerticalExtent> {
  const mutable = new Map<string, { maximum: number; minimum: number }>();
  for (const block of blocks) {
    for (const box of block.boundingBoxes) {
      const key = `${box.page}:${box.coordinateOrigin}`;
      const low = Math.min(box.top, box.bottom);
      const high = Math.max(box.top, box.bottom);
      const current = mutable.get(key);
      if (current) {
        current.minimum = Math.min(current.minimum, low);
        current.maximum = Math.max(current.maximum, high);
      } else {
        mutable.set(key, { maximum: high, minimum: low });
      }
    }
  }
  return mutable;
}

function furniturePosition(
  block: KnowledgeNormalizedBlock,
  extents: ReadonlyMap<string, PageVerticalExtent>
): Readonly<{ edge: "bottom" | "top"; position: number }> | null {
  if (block.locator.pageStart !== block.locator.pageEnd || block.boundingBoxes.length === 0) {
    return null;
  }
  const page = block.locator.pageStart;
  if (block.boundingBoxes.some((box) => box.page !== page) ||
    new Set(block.boundingBoxes.map((box) => box.coordinateOrigin)).size !== 1) {
    return null;
  }
  const origin = block.boundingBoxes[0]!.coordinateOrigin;
  const extent = extents.get(`${page}:${origin}`);
  if (!extent || extent.maximum <= extent.minimum) return null;
  const low = Math.min(...block.boundingBoxes.map((box) => Math.min(box.top, box.bottom)));
  const high = Math.max(...block.boundingBoxes.map((box) => Math.max(box.top, box.bottom)));
  const rawPosition = ((low + high) / 2 - extent.minimum) /
    (extent.maximum - extent.minimum);
  const position = origin === "top_left" ? rawPosition : 1 - rawPosition;
  if (!Number.isFinite(position)) return null;
  if (position <= KNOWLEDGE_FURNITURE_EDGE_FRACTION) return { edge: "top", position };
  if (position >= 1 - KNOWLEDGE_FURNITURE_EDGE_FRACTION) {
    return { edge: "bottom", position };
  }
  return null;
}

function conservativeRepeatedFurniture(
  document: StoredKnowledgeNormalizedDocument
): Set<string> {
  const extents = verticalExtents(document.blocks);
  const candidatesByKey = new Map<string, Array<Readonly<{
    block: KnowledgeNormalizedBlock;
    edge: "bottom" | "top";
    position: number;
  }>>>();
  for (const block of document.blocks) {
    if (!block.text || block.text.length > 240 ||
      block.type === "title" || block.type === "heading" || block.type === "table" ||
      block.type === "image" || block.table !== null) continue;
    const position = furniturePosition(block, extents);
    if (!position) continue;
    const key = furnitureKey(block);
    const candidates = candidatesByKey.get(key) ?? [];
    candidates.push({ block, ...position });
    candidatesByKey.set(key, candidates);
  }

  const requiredPageCount = Math.max(
    3,
    Math.ceil(document.pageCount * KNOWLEDGE_FURNITURE_MIN_PAGE_FRACTION)
  );
  const excluded = new Set<string>();
  for (const candidates of candidatesByKey.values()) {
    const pages = new Set(candidates.map(({ block }) => block.locator.pageStart));
    const edges = new Set(candidates.map(({ edge }) => edge));
    const positions = candidates.map(({ position }) => position);
    if (pages.size < requiredPageCount || edges.size !== 1 ||
      Math.max(...positions) - Math.min(...positions) >
        KNOWLEDGE_FURNITURE_MAX_POSITION_DRIFT) continue;
    for (const { block } of candidates) excluded.add(block.id);
  }
  return excluded;
}

function repeatedFurniture(
  document: StoredKnowledgeNormalizedDocument,
  profileVersion: number
): Set<string> {
  return profileVersion >= KNOWLEDGE_CONSERVATIVE_FURNITURE_PROFILE_MIN_VERSION
    ? conservativeRepeatedFurniture(document)
    : legacyRepeatedFurniture(document.blocks);
}

function fieldHeadingPath(
  document: StoredKnowledgeNormalizedDocument,
  group: KnowledgeNormalizedFieldGroup
): readonly string[] {
  if (group.readingOrder <= 0) return Object.freeze([]);
  return document.blocks[Math.min(group.readingOrder, document.blocks.length) - 1]
    ?.headingPath ?? Object.freeze([]);
}

function profile4FieldSegments(
  document: StoredKnowledgeNormalizedDocument,
  group: KnowledgeNormalizedFieldGroup,
  currentSizing: boolean
): Segment[] {
  const headingPath = fieldHeadingPath(document, group);
  const blockOrder = Math.min(group.readingOrder, Math.max(0, document.blocks.length - 1));
  const untypedSegments = (text: string): Segment[] => splitTextByTokens(text).map((part) =>
    Object.freeze({
      blockEnd: blockOrder,
      blockIds: Object.freeze([group.id]),
      blockStart: blockOrder,
      documentContext: null,
      headingPath,
      layoutKind: "body" as const,
      pageEnd: group.locator.pageEnd,
      pageStart: group.locator.pageStart,
      text: part.text,
      tokenCount: part.tokenCount,
      type: "table" as const
    }));
  const cells = new Map(group.cells.map((cell) => [cell.id, cell]));
  const candidateCellIds = (cellId: number): readonly number[] => {
    const values = [...new Set(group.links.flatMap((link) => {
      const source = cells.get(link.sourceCellId);
      const target = cells.get(link.targetCellId);
      const directed = link.label === "to_value" && source?.label === "key" &&
        target?.label === "value"
        ? [source.id, target.id] as const
        : link.label === "to_key" && source?.label === "value" && target?.label === "key"
          ? [target.id, source.id] as const
          : null;
      if (!directed) return [];
      return directed[0] === cellId
        ? [directed[1]]
        : directed[1] === cellId ? [directed[0]] : [];
    }))]
      .sort((left, right) => left - right);
    return Object.freeze(values.length <= 256 ? values : []);
  };
  const ambiguousCellSegments = (
    cell: KnowledgeNormalizedFieldGroup["cells"][number]
  ): Segment[] => {
    const parts = splitProjectionPayload("", cell.text, 256, currentSizing);
    if (!parts) return untypedSegments(cell.text);
    const candidates = candidateCellIds(cell.id);
    const reasons = Object.freeze(["ambiguous_role" as const]);
    return parts.map((text) => {
      const rawValue = normalizeKnowledgeObservationValue(text).rawValue;
      if (!rawValue) throw new KnowledgeChunkingError("chunking_failed");
      const documentContext: KnowledgeDocumentContextV1 = Object.freeze({
        ambiguityReasons: reasons,
        locator: Object.freeze({
          candidateCellIds: candidates,
          cellId: cell.id,
          fieldGroupId: group.id,
          kind: "field_ambiguous" as const
        }),
        observations: Object.freeze([Object.freeze({
          ambiguityReasons: reasons,
          confidence: null,
          date: null,
          effectiveFrom: null,
          effectiveTo: null,
          metric: null,
          normalizedValue: null,
          origin: Object.freeze({ cellId: cell.id, kind: "field_cell" as const }),
          rawValue,
          role: "metadata" as const,
          subject: null,
          unit: null,
          valueKind: "text" as const
        })]),
        version: 1
      });
      return Object.freeze({
        blockEnd: blockOrder,
        blockIds: Object.freeze([group.id]),
        blockStart: blockOrder,
        documentContext,
        headingPath,
        layoutKind: "field_ambiguous" as const,
        pageEnd: group.locator.pageEnd,
        pageStart: group.locator.pageStart,
        text,
        tokenCount: currentSizing
          ? sizedTokenCount(text)
          : legacyKnowledgeTokenCount(text),
        type: "table" as const
      });
    });
  };
  if (group.cells.some((cell) => cell.text.length > KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS)) {
    return [...group.cells]
      .sort((left, right) => left.order - right.order || left.id - right.id)
      .filter((cell) => cell.text.trim())
      .flatMap(ambiguousCellSegments);
  }
  let fields: ReturnType<typeof createKnowledgeFieldContextSegments>;
  try {
    fields = createKnowledgeFieldContextSegments(group);
  } catch {
    throw new KnowledgeChunkingError("chunking_failed");
  }
  return fields.flatMap((field): readonly Segment[] => {
    if (!boundedChunkText(field.text, currentSizing)) {
      return field.cellIds.flatMap((cellId) => {
        const cell = cells.get(cellId);
        return cell ? ambiguousCellSegments(cell) : [];
      });
    }
    return [Object.freeze({
      blockEnd: blockOrder,
      blockIds: Object.freeze([group.id]),
      blockStart: blockOrder,
      documentContext: field.context,
      headingPath,
      layoutKind: field.context.locator.kind,
      pageEnd: group.locator.pageEnd,
      pageStart: group.locator.pageStart,
      text: field.text,
      tokenCount: currentSizing
        ? sizedTokenCount(field.text)
        : legacyKnowledgeTokenCount(field.text),
      type: "table"
    })];
  });
}

function structuralSegments(
  document: StoredKnowledgeNormalizedDocument,
  profileVersion: number
): Segment[] {
  const blocks = document.blocks;
  const excluded = repeatedFurniture(document, profileVersion);
  const result: Segment[] = [];
  const currentSizing = profileVersion >= KNOWLEDGE_TOKEN_SIZED_CHUNKING_PROFILE_MIN_VERSION;
  const repeatedHeaderRows = profileVersion >=
    KNOWLEDGE_REPEATED_TABLE_HEADER_PROFILE_MIN_VERSION
    ? repeatedPageTableHeaderRows(blocks)
    : new Map<string, number>();
  const fieldGroupsByReadingOrder = new Map<number, KnowledgeNormalizedFieldGroup[]>();
  if (profileVersion >= KNOWLEDGE_DOCUMENT_CONTEXT_CHUNKING_PROFILE_MIN_VERSION) {
    for (const group of document.fieldGroups) {
      const groups = fieldGroupsByReadingOrder.get(group.readingOrder) ?? [];
      groups.push(group);
      fieldGroupsByReadingOrder.set(group.readingOrder, groups);
    }
  }
  for (let readingOrder = 0; readingOrder <= blocks.length; readingOrder += 1) {
    for (const group of fieldGroupsByReadingOrder.get(readingOrder) ?? []) {
      result.push(...profile4FieldSegments(document, group, currentSizing));
    }
    const block = blocks[readingOrder];
    if (!block) continue;
    if (!block.text || excluded.has(block.id) || block.type === "image") continue;
    if (block.type === "table") {
      result.push(...(profileVersion >= KNOWLEDGE_DOCUMENT_CONTEXT_CHUNKING_PROFILE_MIN_VERSION
        ? block.table
          ? profile4TableSegments(block, currentSizing, repeatedHeaderRows.get(block.id) ?? null)
          : profile3TableSegments(block)
        : profileVersion >= KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION
          ? profile3TableSegments(block)
          : profile2TableSegments(block)));
      continue;
    }
    for (const split of splitTextByTokens(block.text)) {
      result.push(Object.freeze({
        blockEnd: block.order,
        blockIds: Object.freeze([block.id]),
        blockStart: block.order,
        documentContext: null,
        headingPath: block.headingPath,
        layoutKind: "body",
        pageEnd: block.locator.pageEnd,
        pageStart: block.locator.pageStart,
        text: split.text,
        tokenCount: split.tokenCount,
        type: block.type
      }));
    }
  }
  return result;
}

function mergeStructuralSegments(segments: readonly Segment[]): Segment[] {
  const result: Segment[] = [];
  let current: Segment | null = null;
  const cannotMerge = new Set<KnowledgeNormalizedBlock["type"]>(["code", "table"]);

  for (const segment of segments) {
    if (!current) {
      current = segment;
      continue;
    }
    const candidateText: string = `${current.text}\n\n${segment.text}`;
    const canMerge =
      sameHeading(current.headingPath, segment.headingPath) &&
      current.layoutKind === "body" && segment.layoutKind === "body" &&
      !cannotMerge.has(current.type) && !cannotMerge.has(segment.type) &&
      legacyKnowledgeTokenCount(candidateText) <= KNOWLEDGE_CHUNK_MAX_TOKENS &&
      candidateText.length <= KNOWLEDGE_CHUNK_MAX_CHARS;
    if (canMerge) {
      current = Object.freeze({
        blockEnd: segment.blockEnd,
        blockIds: Object.freeze([...current.blockIds, ...segment.blockIds]),
        blockStart: current.blockStart,
        documentContext: null,
        headingPath: current.headingPath,
        layoutKind: "body",
        pageEnd: Math.max(current.pageEnd, segment.pageEnd),
        pageStart: Math.min(current.pageStart, segment.pageStart),
        text: candidateText,
        tokenCount: legacyKnowledgeTokenCount(candidateText),
        type: current.type
      });
    } else {
      result.push(current);
      current = segment;
    }
  }
  if (current) result.push(current);
  return result;
}

function contextPrefix(
  document: StoredKnowledgeNormalizedDocument,
  segment: Segment,
  withLayoutEvidence: boolean,
  currentSizing: boolean,
  neutralFormat: boolean
): string {
  // Profile 7 (FR-12): language-neutral embedding text carries only the
  // source title and the heading path before the atomic evidence text. Page,
  // bbox, and layout kind stay structured metadata on the passage row
  // (documentContext / page columns) and never enter the dense text; layout
  // identity for profile >= 4 always comes from documentContext, so the old
  // English "Evidence layout:" markers are no longer written anywhere.
  const parts = neutralFormat
    ? [
        normalizedContextValue(document.source.displayName || document.title || ""),
        segment.headingPath
          .map(normalizedContextValue)
          .filter(Boolean)
          .join(" / ")
      ].filter(Boolean)
    : [
        ...(!withLayoutEvidence
          ? []
          : segment.layoutKind === "table_ambiguous"
            ? ["Evidence layout: table_ambiguous_v1"]
            : segment.layoutKind === "table_row"
              ? ["Evidence layout: table_row_v1"]
              : segment.layoutKind === "table_row_projection"
                ? ["Evidence layout: table_row_v1", "Evidence unit: table_row_projection_v1"]
                : segment.layoutKind === "field_pair"
                  ? ["Evidence layout: field_pair_v1"]
                  : segment.layoutKind === "field_ambiguous"
                    ? ["Evidence layout: field_ambiguous_v1"]
                    : []),
        document.source.displayName
          ? `Source: ${normalizedContextValue(document.source.displayName)}`
          : null,
        document.title ? `Title: ${normalizedContextValue(document.title)}` : null,
        segment.headingPath.length > 0
          ? `Section: ${segment.headingPath.map(normalizedContextValue).join(" › ")}`
          : null,
        `Location: ${segment.pageStart === segment.pageEnd
          ? `page ${segment.pageStart}`
          : `pages ${segment.pageStart}–${segment.pageEnd}`}`
      ].filter((value): value is string => Boolean(value));
  const value = parts.join("\n").slice(0, 1_024);
  if (!currentSizing || sizedTokenCount(value) <=
    KNOWLEDGE_CHUNK_CONTEXT_MAX_TOKENS) return value;
  let low = 1;
  let high = value.length;
  let acceptedEnd = 0;
  while (low <= high) {
    const midpoint = codePointSafeEnd(value, Math.floor((low + high) / 2));
    if (midpoint < 1) {
      low += 1;
      continue;
    }
    const candidate = value.slice(0, midpoint).trimEnd();
    if (candidate && sizedTokenCount(candidate) <=
      KNOWLEDGE_CHUNK_CONTEXT_MAX_TOKENS) {
      acceptedEnd = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  if (acceptedEnd < 1) throw new KnowledgeChunkingError("chunking_failed");
  let semanticEnd = acceptedEnd;
  const minimumBreak = Math.floor(acceptedEnd * 0.6);
  for (let index = acceptedEnd; index > minimumBreak; index -= 1) {
    if (/\s/u.test(value[index - 1] ?? "")) {
      semanticEnd = index;
      break;
    }
  }
  return value.slice(0, semanticEnd).trimEnd();
}

function currentEmbeddingText(prefix: string, text: string): string {
  return prefix ? `${prefix}\n\n${text}` : text;
}

function currentEmbeddingInputFits(prefix: string, text: string): boolean {
  const embeddingText = currentEmbeddingText(prefix, text);
  return embeddingText.length <= Math.min(KNOWLEDGE_CHUNK_MAX_CHARS, MAX_EMBEDDING_INPUT_CHARS) &&
    Buffer.byteLength(embeddingText, "utf8") <= KNOWLEDGE_CHUNK_MAX_UTF8_BYTES &&
    sizedTokenCount(embeddingText) <= KNOWLEDGE_CHUNK_MAX_TOKENS;
}

function currentOverlapStart(text: string, start: number, end: number): number {
  const boundaries = tokenBoundaries(text.slice(start, end));
  let overlapStart = end;
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const candidate = start + boundaries[index]!.start;
    if (sizedTokenCount(text.slice(candidate, end)) >
      KNOWLEDGE_CHUNK_OVERLAP_TOKENS) break;
    overlapStart = candidate;
  }
  return overlapStart > start && overlapStart < end ? overlapStart : end;
}

function fitCurrentEmbeddingSegments(
  document: StoredKnowledgeNormalizedDocument,
  segment: Segment,
  withLayoutEvidence: boolean,
  neutralFormat: boolean
): Segment[] {
  const prefix = contextPrefix(document, segment, withLayoutEvidence, true, neutralFormat);
  if (currentEmbeddingInputFits(prefix, segment.text)) {
    return [Object.freeze({
      ...segment,
      tokenCount: sizedTokenCount(segment.text)
    })];
  }
  if (segment.documentContext !== null) {
    throw new KnowledgeChunkingError("chunking_failed");
  }
  const parts: Segment[] = [];
  let start = 0;
  while (start < segment.text.length) {
    while (start < segment.text.length && /\s/u.test(segment.text[start] ?? "")) start += 1;
    if (start >= segment.text.length) break;
    let low = start + 1;
    let high = Math.min(segment.text.length, start + KNOWLEDGE_CHUNK_MAX_CHARS);
    let acceptedEnd = start;
    while (low <= high) {
      const midpoint = codePointSafeEnd(segment.text, Math.floor((low + high) / 2));
      if (midpoint <= start) {
        low += 1;
        continue;
      }
      if (currentEmbeddingInputFits(prefix, segment.text.slice(start, midpoint))) {
        acceptedEnd = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (acceptedEnd <= start) throw new KnowledgeChunkingError("chunking_failed");
    if (acceptedEnd < segment.text.length) {
      const minimumBreak = start + Math.floor((acceptedEnd - start) * 0.6);
      for (let index = acceptedEnd; index > minimumBreak; index -= 1) {
        if (/\s/u.test(segment.text[index - 1] ?? "")) {
          acceptedEnd = index;
          break;
        }
      }
    }
    const text = segment.text.slice(start, acceptedEnd).trim();
    if (!text || !currentEmbeddingInputFits(prefix, text)) {
      throw new KnowledgeChunkingError("chunking_failed");
    }
    parts.push(Object.freeze({
      ...segment,
      text,
      tokenCount: sizedTokenCount(text)
    }));
    if (acceptedEnd >= segment.text.length) break;
    start = segment.type === "table"
      ? acceptedEnd
      : currentOverlapStart(segment.text, start, acceptedEnd);
  }
  if (parts.length === 0) throw new KnowledgeChunkingError("chunking_failed");
  return parts;
}

function planEntry(
  document: StoredKnowledgeNormalizedDocument,
  segment: Segment,
  index: number,
  withContext: boolean,
  withLayoutEvidence: boolean,
  currentSizing: boolean,
  neutralFormat: boolean
): KnowledgeChunkPlanEntry {
  const prefix = withContext
    ? contextPrefix(document, segment, withLayoutEvidence, currentSizing, neutralFormat)
    : "";
  const embeddingText = prefix ? `${prefix}\n\n${segment.text}` : segment.text;
  if (currentSizing && !currentEmbeddingInputFits(prefix, segment.text)) {
    throw new KnowledgeChunkingError("chunking_failed");
  }
  return Object.freeze({
    contentHash: sha256(JSON.stringify({
      blockIds: segment.blockIds,
      headingPath: segment.headingPath,
      ...(withLayoutEvidence ? { layoutKind: segment.layoutKind } : {}),
      ...(segment.documentContext ? { documentContext: segment.documentContext } : {}),
      text: segment.text
    })),
    contextPrefix: prefix,
    documentContext: segment.documentContext,
    embeddingText,
    embeddingTextHash: sha256(embeddingText),
    headingPath: Object.freeze([...segment.headingPath]),
    index,
    layoutKind: withLayoutEvidence ? segment.layoutKind : "body",
    page: segment.pageStart,
    pageEnd: segment.pageEnd,
    sourceBlockEnd: segment.blockEnd,
    sourceBlockIds: Object.freeze([...segment.blockIds]),
    sourceBlockStart: segment.blockStart,
    text: segment.text,
    tokenCount: currentSizing
      ? sizedTokenCount(segment.text)
      : segment.tokenCount
  });
}

function legacyCharacterSegments(document: StoredKnowledgeNormalizedDocument): Segment[] {
  const groups: Array<{
    blockEnd: number;
    blockIds: string[];
    blockStart: number;
    headingPath: readonly string[];
    page: number;
    texts: string[];
  }> = [];
  for (const block of document.blocks) {
    if (!block.text) continue;
    const page = block.locator.pageStart;
    const previous = groups.at(-1);
    if (previous && previous.page === page && sameHeading(previous.headingPath, block.headingPath)) {
      previous.blockEnd = block.order;
      previous.blockIds.push(block.id);
      previous.texts.push(block.text);
    } else {
      groups.push({
        blockEnd: block.order,
        blockIds: [block.id],
        blockStart: block.order,
        headingPath: block.headingPath,
        page,
        texts: [block.text]
      });
    }
  }
  const result: Segment[] = [];
  for (const group of groups) {
    const text = group.texts.join("\n\n");
    let cursor = 0;
    while (cursor < text.length) {
      let end = Math.min(text.length, cursor + 1_600);
      if (end < text.length) {
        const minimumBreak = cursor + 960;
        for (let index = end; index >= minimumBreak; index -= 1) {
          if (/\s/u.test(text[index - 1] ?? "")) {
            end = index;
            break;
          }
        }
      }
      const value = text.slice(cursor, end).trim();
      if (value) result.push(Object.freeze({
        blockEnd: group.blockEnd,
        blockIds: Object.freeze([...group.blockIds]),
        blockStart: group.blockStart,
        documentContext: null,
        headingPath: group.headingPath,
        layoutKind: "body",
        pageEnd: group.page,
        pageStart: group.page,
        text: value,
        tokenCount: legacyKnowledgeTokenCount(value),
        type: "paragraph"
      }));
      if (end >= text.length) break;
      cursor = Math.max(cursor + 1, end - KNOWLEDGE_CHUNK_OVERLAP_CHARS);
      while (cursor < end && /\s/u.test(text[cursor] ?? "")) cursor += 1;
    }
  }
  return result;
}

export function chunkKnowledgeDocument(input: Readonly<{
  document: StoredKnowledgeNormalizedDocument;
  maxChunks: number;
  profileVersion: number;
  /** Required for profile 7+: the deployment-resolved model-profile counter. */
  tokenCounter?: KnowledgeTokenCounter;
}>): KnowledgeChunkPlanEntry[] {
  const neutralFormat = input.profileVersion >=
    KNOWLEDGE_NEUTRAL_EMBEDDING_FORMAT_PROFILE_MIN_VERSION;
  if (
    !Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1 ||
    input.profileVersion > KNOWLEDGE_CHUNKING_PROFILE_VERSION ||
    !Number.isSafeInteger(input.maxChunks) || input.maxChunks < 1 ||
    (neutralFormat && !input.tokenCounter)
  ) throw new KnowledgeChunkingError("chunking_failed");

  activeTokenCounter = neutralFormat ? input.tokenCounter ?? null : null;
  try {
    const structural = input.profileVersion === 1
      ? legacyCharacterSegments(input.document)
      : mergeStructuralSegments(structuralSegments(input.document, input.profileVersion));
    const currentSizing = input.profileVersion >=
      KNOWLEDGE_TOKEN_SIZED_CHUNKING_PROFILE_MIN_VERSION;
    const withLayoutEvidence = input.profileVersion >=
      KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION;
    const segments = currentSizing
      ? structural.flatMap((segment) => fitCurrentEmbeddingSegments(
          input.document,
          segment,
          withLayoutEvidence,
          neutralFormat
        ))
      : structural;
    if (segments.length === 0) throw new KnowledgeChunkingError("chunking_failed");
    if (segments.length > input.maxChunks) {
      throw new KnowledgeChunkingError("knowledge_chunk_limit_exceeded");
    }
    return segments.map((segment, index) => planEntry(
      input.document,
      segment,
      index,
      input.profileVersion >= 2,
      withLayoutEvidence,
      currentSizing,
      neutralFormat
    ));
  } finally {
    activeTokenCounter = null;
  }
}

export function knowledgeEmbeddingBatches(
  chunks: readonly KnowledgeChunkPlanEntry[],
  profileVersion = KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  tokenCounter?: KnowledgeTokenCounter
): Array<Readonly<{ batchIndex: number; chunks: readonly KnowledgeChunkPlanEntry[] }>> {
  if (profileVersion < KNOWLEDGE_TOKEN_SIZED_CHUNKING_PROFILE_MIN_VERSION) {
    const legacyBatches: Array<Readonly<{
      batchIndex: number;
      chunks: readonly KnowledgeChunkPlanEntry[];
    }>> = [];
    for (let offset = 0; offset < chunks.length; offset += KNOWLEDGE_EMBEDDING_BATCH_SIZE) {
      legacyBatches.push(Object.freeze({
        batchIndex: Math.floor(offset / KNOWLEDGE_EMBEDDING_BATCH_SIZE),
        chunks: Object.freeze(chunks.slice(offset, offset + KNOWLEDGE_EMBEDDING_BATCH_SIZE))
      }));
    }
    return legacyBatches;
  }
  const neutralFormat = profileVersion >=
    KNOWLEDGE_NEUTRAL_EMBEDDING_FORMAT_PROFILE_MIN_VERSION;
  if (profileVersion > KNOWLEDGE_CHUNKING_PROFILE_VERSION ||
    (neutralFormat && !tokenCounter)) {
    throw new KnowledgeChunkingError("chunking_failed");
  }
  activeTokenCounter = neutralFormat ? tokenCounter ?? null : null;
  try {
  const batches: Array<Readonly<{ batchIndex: number; chunks: readonly KnowledgeChunkPlanEntry[] }>> = [];
  let current: KnowledgeChunkPlanEntry[] = [];
  let currentTokens = 0;
  let currentBytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    batches.push(Object.freeze({
      batchIndex: batches.length,
      chunks: Object.freeze(current)
    }));
    current = [];
    currentTokens = 0;
    currentBytes = 0;
  };
  for (const chunk of chunks) {
    const tokens = sizedTokenCount(chunk.embeddingText);
    const bytes = Buffer.byteLength(chunk.embeddingText, "utf8");
    if (!chunk.embeddingText.trim() || chunk.embeddingText.length >
      Math.min(KNOWLEDGE_CHUNK_MAX_CHARS, MAX_EMBEDDING_INPUT_CHARS) ||
      tokens > KNOWLEDGE_CHUNK_MAX_TOKENS || bytes > KNOWLEDGE_CHUNK_MAX_UTF8_BYTES) {
      throw new KnowledgeChunkingError("chunking_failed");
    }
    const exceedsBatch = current.length >= Math.min(
      KNOWLEDGE_EMBEDDING_BATCH_SIZE,
      MAX_EMBEDDING_BATCH_INPUTS
    ) || currentTokens + tokens > KNOWLEDGE_EMBEDDING_BATCH_MAX_TOKENS ||
      currentBytes + bytes > KNOWLEDGE_EMBEDDING_BATCH_MAX_UTF8_BYTES ||
      Buffer.byteLength(JSON.stringify([...current, chunk].map((item) => item.embeddingText)),
        "utf8") > MAX_EMBEDDING_REQUEST_BYTES;
    if (exceedsBatch) flush();
    current.push(chunk);
    currentTokens += tokens;
    currentBytes += bytes;
  }
  flush();
  return batches;
  } finally {
    activeTokenCounter = null;
  }
}
