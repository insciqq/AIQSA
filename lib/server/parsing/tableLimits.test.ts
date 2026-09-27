import { describe, expect, it } from "vitest";
import {
  PARSED_TABLE_MAX_ROWS,
  parsedTableShapeValid,
  parsedTableText,
  portionParsedTable
} from "./tableLimits";
import type { ParsedTableCell } from "./types";

function cell(row: number, column: number, text: string, spans: Partial<ParsedTableCell> = {}): ParsedTableCell {
  return { column, columnSpan: 1, row, rowSpan: 1, text, ...spans };
}

describe("parsed table bounds", () => {
  it("returns a table inside the bounds as one portion", () => {
    const result = portionParsedTable({
      cells: [cell(0, 0, "a"), cell(0, 1, "b"), cell(1, 0, "c", { rowSpan: 9 })],
      columnCount: 2,
      rowCount: 3
    });

    expect(result).toEqual({
      kind: "structured",
      portions: [{
        cells: [cell(0, 0, "a"), cell(0, 1, "b"), cell(1, 0, "c", { rowSpan: 2 })],
        columnCount: 2,
        rowCount: 3
      }]
    });
  });

  it("clamps a span at a portion boundary and skips sparse empty rows", () => {
    const result = portionParsedTable({
      cells: [
        cell(PARSED_TABLE_MAX_ROWS - 1, 0, "last", { rowSpan: 5 }),
        cell(PARSED_TABLE_MAX_ROWS, 0, "next"),
        cell(1_000_000, 0, "far")
      ],
      columnCount: 1,
      rowCount: 1_000_001
    });

    expect(result?.kind).toBe("structured");
    const portions = result?.kind === "structured" ? result.portions : [];
    expect(portions.map((table) => table.rowCount)).toEqual([PARSED_TABLE_MAX_ROWS, 2_000, 1]);
    expect(portions[0]!.cells[0]).toMatchObject({ row: PARSED_TABLE_MAX_ROWS - 1, rowSpan: 1 });
    expect(portions.map(parsedTableText)).toEqual(["last", "next", "far"]);
    expect(portions.every(parsedTableShapeValid)).toBe(true);
  });

  it("keeps an over-wide table as unstructured text in reading order", () => {
    expect(portionParsedTable({
      cells: [cell(1, 150, "d", { columnSpan: 100 }), cell(0, 0, "a"), cell(1, 0, "c"), cell(0, 1, "b")],
      columnCount: 0,
      rowCount: 2
    })).toEqual({ kind: "text_only", text: "a\tb\nc\td" });
  });

  it("aligns sparse columns like the dense grid", () => {
    expect(parsedTableText({
      cells: [cell(3, 2, "z"), cell(0, 1, "y"), cell(0, 0, "x")],
      columnCount: 4,
      rowCount: 4
    })).toBe("x\ty\n\t\tz");
  });
});
