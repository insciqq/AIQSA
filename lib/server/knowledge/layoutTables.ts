import type {
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedTableCell
} from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";

type PositionedBlock = Readonly<{
  block: ParsedDocumentBlock;
  box: ParsedBoundingBox;
  center: number;
  height: number;
}>;

type VisualRow = Readonly<{
  cells: readonly PositionedBlock[];
  center: number;
  height: number;
}>;

function candidate(block: ParsedDocumentBlock): PositionedBlock | null {
  if (
    block.table || block.isTable || block.assetIds.length > 0 || !block.text.trim() ||
    block.pageEnd !== block.page || block.boundingBoxes.length !== 1 ||
    !["caption", "heading", "list_item", "paragraph"].includes(block.type) ||
    block.text.length > 1_024
  ) return null;
  const box = block.boundingBoxes[0]!;
  if (box.page !== block.page) return null;
  const height = Math.abs(box.bottom - box.top);
  const width = box.right - box.left;
  if (height <= 0 || width <= 0) return null;
  return { block, box, center: (box.bottom + box.top) / 2, height };
}

function visuallyBefore(left: PositionedBlock, right: PositionedBlock): number {
  const vertical = left.box.coordinateOrigin === "top_left"
    ? left.center - right.center
    : right.center - left.center;
  return vertical || left.box.left - right.box.left || left.block.index - right.block.index;
}

function sameVisualRow(left: VisualRow, right: PositionedBlock): boolean {
  const leftTop = Math.min(...left.cells.map((cell) => Math.min(cell.box.top, cell.box.bottom)));
  const leftBottom = Math.max(...left.cells.map((cell) => Math.max(cell.box.top, cell.box.bottom)));
  const rightTop = Math.min(right.box.top, right.box.bottom);
  const rightBottom = Math.max(right.box.top, right.box.bottom);
  const intersection = Math.max(0, Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop));
  return intersection / Math.min(left.height, right.height) >= 0.45 ||
    Math.abs(left.center - right.center) <= Math.max(left.height, right.height) * 0.35;
}

function visualRows(positioned: readonly PositionedBlock[]): VisualRow[] {
  const rows: Array<{ cells: PositionedBlock[]; center: number; height: number }> = [];
  for (const item of [...positioned].sort(visuallyBefore)) {
    const row = rows.at(-1);
    if (row && sameVisualRow(row, item)) {
      row.cells.push(item);
      row.center = row.cells.reduce((total, cell) => total + cell.center, 0) / row.cells.length;
      row.height = Math.max(...row.cells.map((cell) => cell.height));
    } else {
      rows.push({ cells: [item], center: item.center, height: item.height });
    }
  }
  return rows.map((row) => ({
    cells: Object.freeze([...row.cells].sort((left, right) =>
      left.box.left - right.box.left || left.block.index - right.block.index)),
    center: row.center,
    height: row.height
  }));
}

function rowRuns(rows: readonly VisualRow[]): VisualRow[][] {
  const result: VisualRow[][] = [];
  let current: VisualRow[] = [];
  const flush = () => {
    if (current.length >= 3) result.push(current);
    current = [];
  };
  for (const row of rows) {
    if (row.cells.length < 2 || row.cells.length > 12) {
      flush();
      continue;
    }
    const previous = current.at(-1);
    if (previous && Math.abs(row.center - previous.center) >
      Math.max(row.height, previous.height) * 3.5) flush();
    current.push(row);
  }
  flush();
  return result;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function confidentTable(rows: readonly VisualRow[]): boolean {
  const columnCount = rows[0]?.cells.length ?? 0;
  if (rows.length < 3 || columnCount < 2 ||
    rows.some((row) => row.cells.length !== columnCount)) return false;
  const all = rows.flatMap((row) => row.cells);
  const pageSpan = Math.max(...all.map((cell) => cell.box.right)) -
    Math.min(...all.map((cell) => cell.box.left));
  const tolerance = Math.max(pageSpan * 0.035, median(all.map((cell) => cell.height)) * 0.75);
  if (pageSpan <= 0 || median(all.map((cell) => cell.block.text.length)) > 220) return false;
  for (const row of rows) {
    for (let index = 1; index < row.cells.length; index += 1) {
      if (row.cells[index - 1]!.box.right > row.cells[index]!.box.left + tolerance * 0.2) {
        return false;
      }
    }
  }
  for (let column = 0; column < columnCount; column += 1) {
    const lefts = rows.map((row) => row.cells[column]!.box.left);
    const rights = rows.map((row) => row.cells[column]!.box.right);
    const centers = rows.map((row) =>
      (row.cells[column]!.box.left + row.cells[column]!.box.right) / 2);
    const alignmentSpan = Math.min(
      Math.max(...lefts) - Math.min(...lefts),
      Math.max(...rights) - Math.min(...rights),
      Math.max(...centers) - Math.min(...centers)
    );
    if (alignmentSpan > tolerance) return false;
  }
  return true;
}

function commonHeadingPath(blocks: readonly ParsedDocumentBlock[]): readonly string[] {
  const first = blocks[0]?.headingPath ?? [];
  let length = first.length;
  for (const block of blocks.slice(1)) {
    length = Math.min(length, block.headingPath.length);
    while (length > 0 && first.slice(0, length).some((part, index) =>
      part !== block.headingPath[index])) length -= 1;
  }
  return Object.freeze(first.slice(0, length));
}

function regionBox(rows: readonly VisualRow[]): ParsedBoundingBox {
  const cells = rows.flatMap((row) => row.cells);
  const first = cells[0]!.box;
  return Object.freeze({
    bottom: first.coordinateOrigin === "top_left"
      ? Math.max(...cells.map((cell) => cell.box.bottom))
      : Math.min(...cells.map((cell) => cell.box.bottom)),
    coordinateOrigin: first.coordinateOrigin,
    left: Math.min(...cells.map((cell) => cell.box.left)),
    page: first.page,
    right: Math.max(...cells.map((cell) => cell.box.right)),
    top: first.coordinateOrigin === "top_left"
      ? Math.min(...cells.map((cell) => cell.box.top))
      : Math.max(...cells.map((cell) => cell.box.top))
  });
}

function reconstructedTable(rows: readonly VisualRow[]): ParsedDocumentBlock {
  const sourceBlocks = rows.flatMap((row) => row.cells.map((cell) => cell.block));
  const cells: ParsedTableCell[] = rows.flatMap((row, rowIndex) =>
    row.cells.map((cell, column) => Object.freeze({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text: cell.block.text
    })));
  const index = Math.min(...sourceBlocks.map((block) => block.index));
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([regionBox(rows)]),
    headingPath: commonHeadingPath(sourceBlocks),
    index,
    isTable: true,
    languageHints: Object.freeze([...new Set(sourceBlocks.flatMap((block) =>
      block.languageHints))]),
    page: sourceBlocks[0]!.page,
    pageEnd: sourceBlocks[0]!.page,
    readingOrder: index,
    table: Object.freeze({
      cells: Object.freeze(cells),
      columnCount: rows[0]!.cells.length,
      rowCount: rows.length
    }),
    text: rows.map((row) => row.cells.map((cell) => cell.block.text).join("\t")).join("\n"),
    type: "table"
  });
}

function reindex(blocks: readonly ParsedDocumentBlock[]): readonly ParsedDocumentBlock[] {
  return Object.freeze([...blocks]
    .sort((left, right) => left.index - right.index)
    .map((block, index) => Object.freeze({ ...block, index, readingOrder: index })));
}

/**
 * Rebuilds only geometrically stable row/column layouts. Potential tables that
 * do not meet that bar remain cell-local table blocks so downstream chunking
 * cannot silently merge unrelated labels and values.
 */
export function withLayoutAwareTables(document: ParsedDocument): ParsedDocument {
  const positioned = document.blocks.flatMap((block) => {
    const value = candidate(block);
    return value ? [value] : [];
  });
  const groups = new Map<string, PositionedBlock[]>();
  for (const item of positioned) {
    const key = `${item.block.page}:${item.box.coordinateOrigin}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const consumed = new Set<number>();
  const replacements: ParsedDocumentBlock[] = [];
  let ambiguous = false;
  for (const group of groups.values()) {
    for (const rows of rowRuns(visualRows(group))) {
      const indexes = rows.flatMap((row) => row.cells.map((cell) => cell.block.index));
      if (indexes.some((index) => consumed.has(index))) continue;
      if (confidentTable(rows)) {
        replacements.push(reconstructedTable(rows));
        indexes.forEach((index) => consumed.add(index));
        continue;
      }
      ambiguous = true;
      for (const row of rows) {
        for (const cell of row.cells) {
          consumed.add(cell.block.index);
          replacements.push(Object.freeze({
            ...cell.block,
            isTable: true,
            table: null,
            type: "table"
          }));
        }
      }
    }
  }
  if (consumed.size === 0) return document;
  const blocks = reindex([
    ...document.blocks.filter((block) => !consumed.has(block.index)),
    ...replacements
  ]);
  return finalizeParsedDocument({
    assets: document.assets,
    attempts: document.attempts,
    blocks,
    engine: document.engine,
    languages: document.languages,
    mediaType: document.mediaType,
    ocrConfidence: document.quality.ocrConfidence,
    pageCount: document.pageCount,
    status: document.status,
    warnings: [
      ...document.warnings,
      ...(ambiguous ? ["table_extraction_degraded" as const] : [])
    ],
    workbook: document.workbook
  });
}
