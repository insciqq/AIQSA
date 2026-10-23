import { normalizeTikaResponse } from "./normalization";
import {
  PARSED_TABLE_MAX_CELLS,
  PARSED_TABLE_MAX_ROWS,
  parsedTableShapeValid
} from "./tableLimits";
import type { ParsedDocument } from "./types";

function tikaTableDocument(rows: readonly string[]): ParsedDocument {
  return normalizeTikaResponse([{
    "X-TIKA:content": `<html><body><table>${rows.join("")}</table></body></html>`
  }], "application/msword");
}

function tableRows(count: number, columns: number): string[] {
  return Array.from({ length: count }, (_, row) =>
    `<tr>${Array.from({ length: columns }, (_, column) => `<td>r${row + 1}c${column + 1}</td>`).join("")}</tr>`);
}

function expectValidTables(parsed: ParsedDocument): void {
  for (const block of parsed.blocks) {
    if (block.table) expect(parsedTableShapeValid(block.table)).toBe(true);
  }
}

describe("Tika normalization", () => {
  it("uses XHTML page containers and retains heading/table structure", () => {
    const parsed = normalizeTikaResponse([{
      "Content-Type": "application/msword",
      "X-TIKA:content": `
        <html><body>
          <div class="page"><h1>Sample guide</h1><p>First page</p></div>
          <div class="page"><h2>Details</h2><p>Second page</p>
            <table><tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
          </div>
        </body></html>`
    }], "application/msword");

    expect(parsed.pageCount).toBe(2);
    expect(parsed.blocks).toMatchObject([
      { headingPath: ["Sample guide"], index: 0, isTable: false, page: 1, text: "Sample guide" },
      { headingPath: ["Sample guide"], index: 1, isTable: false, page: 1, text: "First page" },
      { headingPath: ["Sample guide", "Details"], index: 2, isTable: false, page: 2, text: "Details" },
      { headingPath: ["Sample guide", "Details"], index: 3, isTable: false, page: 2, text: "Second page" },
      { headingPath: ["Sample guide", "Details"], index: 4, isTable: true, page: 2, text: "Key\tValue\na\t1" }
    ]);
    expect(parsed.blocks[4]?.table).toMatchObject({ columnCount: 2, rowCount: 2 });
  });

  it("falls back to one page for Tika XHTML without page containers", () => {
    const parsed = normalizeTikaResponse([{
      "X-TIKA:content": "<html><body><p>Only page</p></body></html>"
    }], "application/rtf");
    expect(parsed.pageCount).toBe(1);
    expect(parsed.blocks[0]).toMatchObject({ page: 1, text: "Only page" });
  });

  it("keeps every row of a table taller than the row bound in consecutive portions", () => {
    const parsed = tikaTableDocument(tableRows(2_500, 2));

    expect(parsed.status).toBe("complete");
    expect(parsed.warnings).toContain("table_extraction_degraded");
    expect(parsed.blocks.map((block) => block.table?.rowCount)).toEqual([PARSED_TABLE_MAX_ROWS, 500]);
    expect(parsed.text).toContain("r2000c2\n");
    expect(parsed.text).toContain("r2001c1\tr2001c2");
    expect(parsed.text).toContain("r2500c2");
    expectValidTables(parsed);
  });

  it("splits a table beyond the cell bound instead of rejecting the document", () => {
    const parsed = tikaTableDocument(tableRows(1_700, 6));

    expect(parsed.warnings).toContain("table_extraction_degraded");
    expect(parsed.blocks.length).toBeGreaterThan(1);
    expect(parsed.blocks.reduce((total, block) => total + (block.table?.cells.length ?? 0), 0))
      .toBe(1_700 * 6);
    expect(parsed.blocks.every((block) =>
      (block.table?.cells.length ?? 0) <= PARSED_TABLE_MAX_CELLS)).toBe(true);
    expect(parsed.text).toContain("r1700c6");
    expectValidTables(parsed);
  });

  it("keeps a table wider than the column bound as text instead of an invalid structure", () => {
    const wide = Array.from({ length: 3 }, (_, row) =>
      `<tr>${Array.from({ length: 3 }, (_, column) =>
        `<td colspan="100">r${row + 1}c${column + 1}</td>`).join("")}</tr>`);
    const parsed = tikaTableDocument(wide);

    expect(parsed.warnings).toContain("table_extraction_degraded");
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({ isTable: true, table: null, type: "table" });
    expect(parsed.blocks[0]!.text).toBe("r1c1\tr1c2\tr1c3\nr2c1\tr2c2\tr2c3\nr3c1\tr3c2\tr3c3");
  });

  it("keeps spans inside the declared grid", () => {
    const parsed = tikaTableDocument([
      "<tr><td rowspan=\"9\">a</td><td colspan=\"2\">b</td></tr>",
      "<tr><td>c</td><td>d</td></tr>"
    ]);

    expect(parsed.warnings).not.toContain("table_extraction_degraded");
    expect(parsed.blocks[0]?.table).toMatchObject({ columnCount: 3, rowCount: 2 });
    expect(parsed.blocks[0]?.table?.cells[0]).toMatchObject({ row: 0, rowSpan: 2 });
    expectValidTables(parsed);
  });

  it("clamps HTML spans and still bounds the retained columns", () => {
    const parsed = tikaTableDocument(["<tr><td colspan=\"999999\">x</td></tr>"]);
    expect(parsed.blocks[0]).toMatchObject({ table: null, text: "x" });
    expect(parsed.warnings).toContain("table_extraction_degraded");
  });
});
