import { utils, write, type BookType } from "xlsx";
import {
  assertBoundedSpreadsheetArchive,
  parseSpreadsheetDocument
} from "./spreadsheet";
import {
  SPREADSHEET_MAX_COLUMNS_PER_SHEET,
  SPREADSHEET_MAX_UNCOMPRESSED_BYTES
} from "./spreadsheetLimits";

function workbookBytes(bookType: BookType): Buffer {
  const sheet = utils.aoa_to_sheet([
    ["Region", "Revenue", "Revenue", "Closed at", "Total"],
    ["North", 10, 2, new Date("2026-01-02T00:00:00.000Z"), null],
    ["South", 20, null, new Date("2026-01-03T00:00:00.000Z"), null]
  ], { cellDates: true });
  sheet.E2 = { f: "SUM(B2:B3)", t: "n", v: 30, w: "30.00", z: "0.00" };
  sheet["!rows"] = [{}, { hidden: true }];
  sheet["!cols"] = [{}, { hidden: true }];
  sheet["!merges"] = [utils.decode_range("A1:A2")];
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sales");
  workbook.Workbook = { Sheets: [{ Hidden: 1 }] };
  return write(workbook, { bookType, cellStyles: true, type: "buffer" });
}

const mimeByType: Readonly<Record<"ods" | "xls" | "xlsx", string>> = {
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet"
};

describe("bounded spreadsheet parsing", () => {
  it.each(["xls", "xlsx", "ods"] as const)("normalizes typed %s workbooks", (bookType) => {
    const document = parseSpreadsheetDocument({
      bytes: workbookBytes(bookType),
      fileName: `sales.${bookType}`,
      mimeType: mimeByType[bookType]
    });

    expect(document).toMatchObject({
      engine: "spreadsheet",
      pageCount: 1,
      workbook: {
        sheets: [{
          cells: expect.arrayContaining([
            expect.objectContaining({ address: "B2", type: "number", value: 10 }),
            expect.objectContaining({ address: "E2", value: 30 })
          ]),
          name: "Sales",
          regions: [expect.objectContaining({ a1: "A1:E3", headerRow: 0 })]
        }]
      }
    });
    expect(document.blocks[0]).toMatchObject({
      headingPath: ["Sales", expect.any(String)],
      type: "table"
    });
    if (bookType !== "ods") {
      expect(document.workbook?.sheets[0]).toMatchObject({
        hidden: "hidden",
        hiddenColumns: [1]
      });
      expect(document.workbook?.warnings).toContain("hidden_data_present");
    }
    if (bookType === "xlsx") {
      expect(document.workbook?.sheets[0]?.hiddenRows).toEqual([1]);
    }
    expect(document.workbook?.warnings).toContain("duplicate_headers");
    expect(document.workbook?.sheets[0]?.regions[0]?.columnLabels).toEqual([
      "Region",
      "Revenue",
      "Revenue [2]",
      "Closed at",
      "Total"
    ]);
    if (bookType === "xls") {
      expect(document.workbook?.sheets[0]?.cells.find((cell) => cell.address === "E2")?.formula)
        .toBeNull();
    } else {
      expect(document.workbook?.sheets[0]?.cells.find((cell) => cell.address === "E2")?.formula)
        .toContain("SUM");
    }
  });

  it("keeps CSV formula-like text inert and preserves missing cells", () => {
    const document = parseSpreadsheetDocument({
      bytes: Buffer.from("name;amount;note\nalpha;1,25;=HYPERLINK(\"https://invalid\")\nbeta;;safe\n"),
      fileName: "locale.csv",
      mimeType: "text/csv"
    });
    const sheet = document.workbook!.sheets[0]!;
    expect(sheet.cells.find((cell) => cell.address === "C2")).toMatchObject({
      formula: null,
      type: "string",
      value: "=HYPERLINK(\"https://invalid\")"
    });
    expect(sheet.cells.some((cell) => cell.address === "B3")).toBe(false);
    expect(document.workbook?.warnings).toContain("formula_like_text");
    expect(document.text).toContain("'=HYPERLINK");
  });

  it("rejects workbook dimensions above the reviewed column bound", () => {
    const row = Array.from({ length: SPREADSHEET_MAX_COLUMNS_PER_SHEET + 1 }, (_value, index) => index);
    const sheet = utils.aoa_to_sheet([row]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Wide");
    expect(() => parseSpreadsheetDocument({
      bytes: write(workbook, { bookType: "xlsx", type: "buffer" }),
      fileName: "wide.xlsx",
      mimeType: mimeByType.xlsx
    })).toThrowError(expect.objectContaining({ code: "parser_output_too_large" }));
  });

  it("rejects an archive that advertises unbounded inflated content", () => {
    const centralOffset = 30;
    const centralSize = 46;
    const eocdOffset = centralOffset + centralSize;
    const bytes = Buffer.alloc(eocdOffset + 22);
    bytes.writeUInt32LE(0x02014b50, centralOffset);
    bytes.writeUInt32LE(1, centralOffset + 20);
    bytes.writeUInt32LE(SPREADSHEET_MAX_UNCOMPRESSED_BYTES + 1, centralOffset + 24);
    bytes.writeUInt32LE(0x06054b50, eocdOffset);
    bytes.writeUInt16LE(1, eocdOffset + 8);
    bytes.writeUInt16LE(1, eocdOffset + 10);
    bytes.writeUInt32LE(centralSize, eocdOffset + 12);
    bytes.writeUInt32LE(centralOffset, eocdOffset + 16);
    expect(() => assertBoundedSpreadsheetArchive(bytes))
      .toThrowError(expect.objectContaining({ code: "parser_output_too_large" }));
  });

  it("rejects a truncated spreadsheet archive with a stable parser error", () => {
    expect(() => assertBoundedSpreadsheetArchive(Buffer.from("PK")))
      .toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });
});
