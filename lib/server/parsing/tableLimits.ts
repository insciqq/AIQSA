import type { ParsedTable, ParsedTableCell } from "./types";

/**
 * The single owner of structured-table bounds. Parser normalization emits only
 * tables that satisfy `parsedTableShapeValid`, the same predicate Knowledge
 * applies to normalized documents, so producer and consumer cannot diverge.
 * A source table beyond these bounds is never cut silently: it is split into
 * consecutive row portions, or, when it is wider than the column bound, kept
 * as text without structure; either outcome carries a document warning.
 */
export const PARSED_TABLE_MAX_ROWS = 2_000;
export const PARSED_TABLE_MAX_COLUMNS = 200;
export const PARSED_TABLE_MAX_CELLS = 10_000;
/** Dense row x column grid of one emitted portion. Consumers materialize this
 * grid, so declared-but-empty rows are bounded as well as populated cells. */
const PARSED_TABLE_MAX_GRID_CELLS = 4 * PARSED_TABLE_MAX_CELLS;

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/** Knowledge semantics: every cell and its spans lie inside the declared grid. */
export function parsedTableShapeValid(table: ParsedTable): boolean {
  if (
    !positiveSafeInteger(table.rowCount) || table.rowCount > PARSED_TABLE_MAX_ROWS ||
    !positiveSafeInteger(table.columnCount) || table.columnCount > PARSED_TABLE_MAX_COLUMNS ||
    table.cells.length > PARSED_TABLE_MAX_CELLS
  ) return false;
  return table.cells.every((cell) =>
    Number.isSafeInteger(cell.row) && cell.row >= 0 && cell.row < table.rowCount &&
    Number.isSafeInteger(cell.column) && cell.column >= 0 && cell.column < table.columnCount &&
    positiveSafeInteger(cell.rowSpan) && cell.row + cell.rowSpan <= table.rowCount &&
    positiveSafeInteger(cell.columnSpan) && cell.column + cell.columnSpan <= table.columnCount);
}

/** Tab-aligned rows; only populated rows are materialized. */
export function parsedTableText(table: ParsedTable | null): string {
  if (!table) return "";
  const rows = new Map<number, string[]>();
  for (const cell of table.cells) {
    const row = rows.get(cell.row) ?? [];
    for (let column = row.length; column < cell.column; column += 1) row.push("");
    row[cell.column] = cell.text;
    rows.set(cell.row, row);
  }
  return [...rows.keys()].sort((left, right) => left - right)
    .map((row) => rows.get(row)!.join("\t").trimEnd())
    .filter(Boolean)
    .join("\n");
}

/** Text of a table kept without structure: row order, then column order. */
function unstructuredTableText(cells: readonly ParsedTableCell[]): string {
  const rows = new Map<number, ParsedTableCell[]>();
  for (const cell of cells) {
    const row = rows.get(cell.row) ?? [];
    row.push(cell);
    rows.set(cell.row, row);
  }
  return [...rows.keys()].sort((left, right) => left - right)
    .map((row) => rows.get(row)!
      .sort((left, right) => left.column - right.column)
      .map((cell) => cell.text)
      .filter(Boolean)
      .join("\t"))
    .filter(Boolean)
    .join("\n");
}

export type ParsedTablePortioning =
  | Readonly<{ kind: "structured"; portions: readonly ParsedTable[] }>
  | Readonly<{ kind: "text_only"; text: string }>;

/**
 * Fits one source table to the shared bounds. `cells` use absolute source
 * rows and positive spans; `rowCount`/`columnCount` are the source's declared
 * extent. A table inside the bounds is returned as one portion.
 */
export function portionParsedTable(input: Readonly<{
  cells: readonly ParsedTableCell[];
  columnCount: number;
  rowCount: number;
}>): ParsedTablePortioning | null {
  if (input.cells.length === 0) return null;
  let columnCount = Number.isSafeInteger(input.columnCount) ? input.columnCount : 0;
  let lastRow = 0;
  const rowCells = new Map<number, number>();
  for (const cell of input.cells) {
    columnCount = Math.max(columnCount, cell.column + cell.columnSpan);
    lastRow = Math.max(lastRow, cell.row);
    rowCells.set(cell.row, (rowCells.get(cell.row) ?? 0) + 1);
  }
  if (
    !Number.isSafeInteger(columnCount) || columnCount > PARSED_TABLE_MAX_COLUMNS ||
    [...rowCells.values()].some((count) => count > PARSED_TABLE_MAX_CELLS)
  ) {
    return Object.freeze({ kind: "text_only", text: unstructuredTableText(input.cells) });
  }

  const rowLimit = Math.min(
    PARSED_TABLE_MAX_ROWS,
    Math.floor(PARSED_TABLE_MAX_GRID_CELLS / columnCount)
  );
  const starts: number[] = [];
  let portionCells = 0;
  for (const row of [...rowCells.keys()].sort((left, right) => left - right)) {
    const count = rowCells.get(row)!;
    const start = starts.at(-1);
    if (start === undefined) {
      starts.push(row < rowLimit ? 0 : row);
      portionCells = count;
    } else if (row >= start + rowLimit || portionCells + count > PARSED_TABLE_MAX_CELLS) {
      starts.push(row);
      portionCells = count;
    } else {
      portionCells += count;
    }
  }

  const declaredRows = Math.max(
    Number.isSafeInteger(input.rowCount) ? input.rowCount : 0,
    lastRow + 1
  );
  const bounds = starts.map((start, index) => ({
    end: Math.min(starts[index + 1] ?? declaredRows, start + rowLimit),
    start
  }));
  const portionCellsByIndex = bounds.map((): ParsedTableCell[] => []);
  for (const cell of input.cells) {
    let low = 0;
    let high = bounds.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (bounds[middle]!.start <= cell.row) low = middle;
      else high = middle - 1;
    }
    const { end, start } = bounds[low]!;
    portionCellsByIndex[low]!.push(Object.freeze({
      column: cell.column,
      columnSpan: cell.columnSpan,
      row: cell.row - start,
      rowSpan: Math.min(cell.rowSpan, end - cell.row),
      text: cell.text
    }));
  }
  return Object.freeze({
    kind: "structured",
    portions: Object.freeze(bounds.map(({ end, start }, index) => Object.freeze({
      cells: Object.freeze(portionCellsByIndex[index]!),
      columnCount,
      rowCount: end - start
    })))
  });
}
