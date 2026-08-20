import { createHash } from "node:crypto";
import {
  createKnowledgeFieldContextSegments,
  createKnowledgeTableDocumentContext,
  KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS,
  KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS,
  KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
  KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES,
  normalizeKnowledgeObservationValue,
  type KnowledgeDocumentContextV1,
  type KnowledgeTableContextCell,
  type KnowledgeTableHeaderLineageV1
} from "./documentContext";
import {
  KNOWLEDGE_CHUNKING_PROFILE_VERSION,
  KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION
} from "./indexProfile";
import type {
  KnowledgeNormalizedBlock,
  KnowledgeNormalizedFieldGroup,
  StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";

export const KNOWLEDGE_CHUNK_MAX_TOKENS = 400;
export const KNOWLEDGE_CHUNK_OVERLAP_TOKENS = 48;
/** Hard defensive ceiling; v2 admission is token-oriented. */
export const KNOWLEDGE_CHUNK_MAX_CHARS = 12_000;
/** Legacy profile-1 character overlap retained for old immutable revisions. */
export const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 200;
export const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 64;

export type KnowledgeChunkPlanEntry = Readonly<{
  contentHash: string;
  contextPrefix: string;
  documentContext: KnowledgeDocumentContextV1 | null;
  embeddingText: string;
  embeddingTextHash: string;
  headingPath: readonly string[];
  index: number;
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

export function approximateKnowledgeTokenCount(text: string): number {
  const lexical = text.match(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, lexical);
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
      if (approximateKnowledgeTokenCount(candidate) <= KNOWLEDGE_CHUNK_MAX_TOKENS) {
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
    const tokenCount = approximateKnowledgeTokenCount(value);
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
  if (!/^(?:indicator|measure|metric(?:\s+(?:label|name))?|parameter|метрика|параметр|показатель)$/iu
    .test(label)) return false;
  return cells.slice(1).every((cell) =>
    /^(?:(?:19|20)\d{2}|q[1-4]\s+(?:19|20)\d{2}|(?:19|20)\d{2}\s+q[1-4])(?:\s*\/\s*(?:(?:19|20)\d{2}|q[1-4]\s+(?:19|20)\d{2}|(?:19|20)\d{2}\s+q[1-4]))?$/iu
      .test(cell.text.normalize("NFKC").replace(/\s+/gu, " ").trim()));
}

function boundedChunkText(text: string): boolean {
  return Boolean(text.trim()) && text.length <= KNOWLEDGE_CHUNK_MAX_CHARS &&
    approximateKnowledgeTokenCount(text) <= KNOWLEDGE_CHUNK_MAX_TOKENS;
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
  maximumParts = KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS
): readonly string[] | null {
  if (!payload.trim()) throw new KnowledgeChunkingError("chunking_failed");
  if (prefix && !boundedChunkText(prefix)) return null;
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
      if (boundedChunkText(candidate)) {
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
      if (!boundedChunkText(candidate) || cells.some((cell) =>
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
    const pieces = splitProjectionPayload(prefix, payload);
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
  if (drafts.length < 2) {
    throw new KnowledgeChunkingError("chunking_failed");
  }
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

function profile4TableSegments(block: KnowledgeNormalizedBlock): Segment[] {
  const grid = tableGrid(block);
  const nonEmptyRows = Array.from({ length: grid.rowCount }, (_, rowIndex) => rowIndex)
    .filter((rowIndex) => Boolean(tableRowSignature(grid, rowIndex)));
  if (nonEmptyRows.length === 0) return [];
  const firstRow = nonEmptyRows[0]!;
  const hasFollowingObservation = nonEmptyRows.slice(1)
    .some((rowIndex) => tableRowHasNumericOrDateObservation(grid, rowIndex));
  const canonicalHeaderRow = hasFollowingObservation && (
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
    if (boundedChunkText(text) && Buffer.byteLength(text, "utf8") <=
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
        tokenCount: approximateKnowledgeTokenCount(text),
        type: block.type
      }));
      continue;
    }
    const projections = oversizedTableRowProjections({
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
      tokenCount: approximateKnowledgeTokenCount(projection.text),
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
      approximateKnowledgeTokenCount(text) > KNOWLEDGE_CHUNK_MAX_TOKENS ||
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

function repeatedFurniture(blocks: readonly KnowledgeNormalizedBlock[]): Set<string> {
  const pagesByKey = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (!block.text || block.text.length > 240 || block.type === "title" || block.type === "heading") continue;
    const key = furnitureKey(block);
    const pages = pagesByKey.get(key) ?? new Set<number>();
    pages.add(block.locator.pageStart);
    pagesByKey.set(key, pages);
  }
  return new Set([...pagesByKey].filter(([, pages]) => pages.size >= 3).map(([key]) => key));
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
  group: KnowledgeNormalizedFieldGroup
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
    const parts = splitProjectionPayload("", cell.text, 256);
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
        tokenCount: approximateKnowledgeTokenCount(text),
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
    if (!boundedChunkText(field.text)) {
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
      tokenCount: approximateKnowledgeTokenCount(field.text),
      type: "table"
    })];
  });
}

function structuralSegments(
  document: StoredKnowledgeNormalizedDocument,
  profileVersion: number
): Segment[] {
  const blocks = document.blocks;
  const excluded = repeatedFurniture(blocks);
  const result: Segment[] = [];
  const fieldGroupsByReadingOrder = new Map<number, KnowledgeNormalizedFieldGroup[]>();
  if (profileVersion === KNOWLEDGE_CHUNKING_PROFILE_VERSION) {
    for (const group of document.fieldGroups) {
      const groups = fieldGroupsByReadingOrder.get(group.readingOrder) ?? [];
      groups.push(group);
      fieldGroupsByReadingOrder.set(group.readingOrder, groups);
    }
  }
  for (let readingOrder = 0; readingOrder <= blocks.length; readingOrder += 1) {
    for (const group of fieldGroupsByReadingOrder.get(readingOrder) ?? []) {
      result.push(...profile4FieldSegments(document, group));
    }
    const block = blocks[readingOrder];
    if (!block) continue;
    if (!block.text || excluded.has(furnitureKey(block)) || block.type === "image") continue;
    if (block.type === "table") {
      result.push(...(profileVersion === KNOWLEDGE_CHUNKING_PROFILE_VERSION
        ? block.table ? profile4TableSegments(block) : profile3TableSegments(block)
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
      approximateKnowledgeTokenCount(candidateText) <= KNOWLEDGE_CHUNK_MAX_TOKENS &&
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
        tokenCount: approximateKnowledgeTokenCount(candidateText),
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
  withLayoutEvidence: boolean
): string {
  const layout = !withLayoutEvidence
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
              : [];
  const parts = [
    ...layout,
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
  return parts.join("\n").slice(0, 1_024);
}

function planEntry(
  document: StoredKnowledgeNormalizedDocument,
  segment: Segment,
  index: number,
  withContext: boolean,
  withLayoutEvidence: boolean
): KnowledgeChunkPlanEntry {
  const prefix = withContext ? contextPrefix(document, segment, withLayoutEvidence) : "";
  const embeddingText = prefix ? `${prefix}\n\n${segment.text}` : segment.text;
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
    page: segment.pageStart,
    pageEnd: segment.pageEnd,
    sourceBlockEnd: segment.blockEnd,
    sourceBlockIds: Object.freeze([...segment.blockIds]),
    sourceBlockStart: segment.blockStart,
    text: segment.text,
    tokenCount: segment.tokenCount
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
        tokenCount: approximateKnowledgeTokenCount(value),
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
}>): KnowledgeChunkPlanEntry[] {
  if (
    ![1, 2, 3, KNOWLEDGE_CHUNKING_PROFILE_VERSION].includes(input.profileVersion) ||
    !Number.isSafeInteger(input.maxChunks) || input.maxChunks < 1
  ) throw new KnowledgeChunkingError("chunking_failed");

  const segments = input.profileVersion === 1
    ? legacyCharacterSegments(input.document)
    : mergeStructuralSegments(structuralSegments(input.document, input.profileVersion));
  if (segments.length === 0) throw new KnowledgeChunkingError("chunking_failed");
  if (segments.length > input.maxChunks) {
    throw new KnowledgeChunkingError("knowledge_chunk_limit_exceeded");
  }
  return segments.map((segment, index) => planEntry(
    input.document,
    segment,
    index,
    input.profileVersion >= 2,
    input.profileVersion >= KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION
  ));
}

export function knowledgeEmbeddingBatches(
  chunks: readonly KnowledgeChunkPlanEntry[]
): Array<Readonly<{ batchIndex: number; chunks: readonly KnowledgeChunkPlanEntry[] }>> {
  const batches: Array<Readonly<{ batchIndex: number; chunks: readonly KnowledgeChunkPlanEntry[] }>> = [];
  for (let offset = 0; offset < chunks.length; offset += KNOWLEDGE_EMBEDDING_BATCH_SIZE) {
    batches.push(Object.freeze({
      batchIndex: Math.floor(offset / KNOWLEDGE_EMBEDDING_BATCH_SIZE),
      chunks: Object.freeze(chunks.slice(offset, offset + KNOWLEDGE_EMBEDDING_BATCH_SIZE))
    }));
  }
  return batches;
}
