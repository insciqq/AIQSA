import { describe, expect, it } from "vitest";
import type { ParsedDocumentBlock } from "./types";
import { createNativeTextCoverage } from "./pdfTextCoverage";

function paragraph(text: string, page = 1): ParsedDocumentBlock {
  return {
    assetIds: [], boundingBoxes: [], headingPath: [], index: 0, isTable: false,
    languageHints: [], page, pageEnd: page, readingOrder: 0, table: null,
    text, type: "paragraph"
  };
}

function table(rows: string[][]): ParsedDocumentBlock {
  return {
    ...paragraph(rows.map(row => row.join("\t")).join("\n")),
    isTable: true, type: "table",
    table: {
      rowCount: rows.length, columnCount: rows[0]!.length,
      cells: rows.flatMap((row, rowIndex) => row.map((text, column) => ({
        text, row: rowIndex, column, rowSpan: 1, columnSpan: 1
      })))
    }
  };
}

describe("native PDF text coverage", () => {
  it("does not add a degraded native copy of a model formula", () => {
    const formula = String.raw`\[r_a=\frac{a}{a+3}=\frac{2}{7}\]`;
    const covered = createNativeTextCoverage([paragraph(formula)]);
    expect(covered(paragraph("r a = a + 3 = 2 / 7"))).toBe(true);
    expect(covered(paragraph("r a = a + 9 = 2 / 7"))).toBe(false);
  });

  it("recognizes Unicode and LaTeX operands without rewriting the model", () => {
    const original = paragraph(String.raw`The bound is \(\alpha_j\leq\sqrt{5}\,\|v_j\|\).`);
    const covered = createNativeTextCoverage([original]);
    expect(covered(paragraph("The bound is α j ≤ 5 ∥ v j ∥."))).toBe(true);
    expect(original.text).toBe(String.raw`The bound is \(\alpha_j\leq\sqrt{5}\,\|v_j\|\).`);
    expect(covered(paragraph("The bound is α j ≤ 8 ∥ v j ∥."))).toBe(false);
  });

  it("recognizes separate represented columns but retains a missing value", () => {
    const covered = createNativeTextCoverage([
      paragraph(String.raw`The northern sensor measures \(q_i=13\).`),
      paragraph("The southern sensor reports 28 samples.")
    ]);
    expect(covered(table([["The northern sensor measures q i = 13.", "The southern sensor reports 28 samples."]]))).toBe(true);
    expect(covered(table([["The northern sensor measures q i = 13.", "The southern sensor reports 29 samples."]]))).toBe(false);
  });

  it("matches partial native table rows within one complete model row", () => {
    const covered = createNativeTextCoverage([table([
      ["Sensor", "Voltage", "Current"], ["North sensor", "12.8", "3.7"], ["South sensor", "9.4", "6.2"]
    ])]);
    expect(covered(table([["North sensor", "12.8 3.7"]]))).toBe(true);
    expect(covered(table([["North sensor", "3.7 12.8"]]))).toBe(false);
    expect(covered(table([["North sensor", "12.8 6.2"]]))).toBe(false);
  });

  it("uses explicit vertical spans without mixing the values of separate rows", () => {
    const source = table([
      ["Station", "Sensor", "Voltage"],
      ["Northern workshop", "First sensor", "13.6"],
      ["", "Second sensor", "8.2"]
    ]);
    const grouped = {
      ...source,
      table: {
        ...source.table!,
        cells: source.table!.cells.filter(cell => cell.row !== 2 || cell.column !== 0)
          .map(cell => cell.row === 1 && cell.column === 0 ? { ...cell, rowSpan: 2 } : cell)
      }
    };
    const covered = createNativeTextCoverage([grouped]);
    expect(covered(table([["Northern workshop", "Second sensor", "8.2"]]))).toBe(true);
    expect(covered(table([["Second sensor", "8.2"]]))).toBe(true);
    expect(covered(table([["Northern workshop", "First sensor", "8.2"]]))).toBe(false);
    expect(covered(table([["Northern workshop", "Second sensor", "8.9"]]))).toBe(false);
  });

  it("retains novel text, changed diacritics, short ambiguous labels and other pages", () => {
    const covered = createNativeTextCoverage([
      paragraph("The northern station has 17 samples."), paragraph("The café records measurements.")
    ]);
    expect(covered(paragraph("Calibration completed on 2041-02-03."))).toBe(false);
    expect(covered(paragraph("The cafe records measurements."))).toBe(false);
    expect(covered(paragraph("17"))).toBe(false);
    expect(covered(paragraph("The northern station has 17 samples.", 2))).toBe(false);
  });

  it("does not manufacture coverage from separate table rows or scattered prose", () => {
    const covered = createNativeTextCoverage([
      table([["Northern workshop", "Boats"], ["Southern workshop", "Bicycles"]]),
      paragraph("The northern station records many different daily readings during its annual maintenance; the count is 17.")
    ]);
    expect(covered(table([["Northern workshop", "Southern workshop"]]))).toBe(false);
    expect(covered(paragraph("The northern station count is 17."))).toBe(false);
  });
});
