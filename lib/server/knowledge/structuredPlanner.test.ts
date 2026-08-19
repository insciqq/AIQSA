import { utils, write } from "xlsx";
import { parseSpreadsheetDocument, type ParsedWorkbook } from "../parsing";
import { planStructuredDataQuery } from "./structuredPlanner";

function workbook(): ParsedWorkbook {
  const sales = utils.aoa_to_sheet([
    ["Region", "Revenue", "Cost", "Closed at", "Key"],
    ["North", 100, 60, new Date(2026, 0, 1), "N"],
    ["South", 200, 90, new Date(2026, 0, 2), "S"],
    ["West", 5_000, 100, new Date(2026, 0, 3), "W"],
    ["Secret", 10_000, 0, new Date(2026, 0, 4), "X"]
  ], { cellDates: true });
  sales["!rows"] = [{}, {}, {}, {}, { hidden: true }];
  sales.E2 = { f: "CONCAT(\"N\")", t: "s", v: "N" };
  const people = utils.aoa_to_sheet([
    ["Key", "Manager"],
    ["N", "Alice"],
    ["S", "Boris"],
    ["W", "Eli"],
    ["X", "Private"]
  ]);
  const value = utils.book_new();
  utils.book_append_sheet(value, sales, "Sales");
  utils.book_append_sheet(value, people, "People");
  return parseSpreadsheetDocument({
    bytes: write(value, { bookType: "xlsx", type: "buffer" }),
    fileName: "sales.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }).workbook!;
}

describe("structured data planner", () => {
  it("plans a Russian grouped aggregate with exact sheet and column names", () => {
    expect(planStructuredDataQuery(
      "Посчитай сумму Revenue по Region на листе Sales",
      workbook()
    )).toMatchObject({
      plan: {
        aggregate: "sum",
        groupBy: ["Region"],
        operation: "aggregate",
        target: { range: "A1:E5", sheet: "Sales" },
        valueColumn: "Revenue"
      },
      status: "ready"
    });
  });

  it("plans bounded filtering and top-row sorting", () => {
    expect(planStructuredDataQuery(
      "Show top 2 Revenue rows in the Sales spreadsheet where Revenue >= 200",
      workbook()
    )).toMatchObject({
      plan: {
        filters: [{ column: "Revenue", operator: "gte", value: 200 }],
        limit: 2,
        operation: "list_rows",
        select: expect.arrayContaining(["Region", "Revenue"]),
        sort: [{ column: "Revenue", direction: "desc" }]
      },
      status: "ready"
    });
  });

  it("plans arithmetic, trends, outliers, and cached-formula audits", () => {
    expect(planStructuredDataQuery(
      "Calculate the difference between Revenue and Cost in Sales",
      workbook()
    )).toMatchObject({
      plan: {
        leftColumn: "Revenue",
        operation: "arithmetic",
        operator: "subtract",
        rightColumn: "Cost"
      },
      status: "ready"
    });
    expect(planStructuredDataQuery(
      "Show the average Revenue trend over Closed at in Sales",
      workbook()
    )).toMatchObject({
      plan: {
        aggregate: "average",
        dateColumn: "Closed at",
        operation: "trend",
        valueColumn: "Revenue"
      },
      status: "ready"
    });
    expect(planStructuredDataQuery("Find Revenue outliers in Sales", workbook())).toMatchObject({
      plan: { method: "iqr", operation: "outliers", valueColumn: "Revenue" },
      status: "ready"
    });
    expect(planStructuredDataQuery("Audit formulas in Sales", workbook())).toMatchObject({
      plan: { operation: "formula_audit" },
      status: "ready"
    });
  });

  it("plans a two-sheet join by the only explicitly named common key", () => {
    expect(planStructuredDataQuery("Join Sales and People by Key", workbook())).toMatchObject({
      plan: {
        leftKey: "Key",
        operation: "join",
        rightKey: "Key",
        rightSelect: ["Manager"],
        rightTarget: { range: "A1:B5", sheet: "People" },
        target: { range: "A1:E5", sheet: "Sales" }
      },
      status: "ready"
    });
  });

  it("makes hidden-data inclusion explicit in the persisted plan", () => {
    expect(planStructuredDataQuery(
      "Sum Revenue in Sales including hidden rows",
      workbook()
    )).toMatchObject({
      plan: { includeHidden: true, operation: "aggregate" },
      status: "ready"
    });
  });

  it("asks for clarification instead of guessing a table or numeric column", () => {
    expect(planStructuredDataQuery("Show this spreadsheet table", workbook())).toMatchObject({
      code: "structured_target_ambiguous",
      status: "needs_clarification"
    });
    expect(planStructuredDataQuery("Calculate the sum in Sales", workbook())).toMatchObject({
      code: "structured_column_ambiguous",
      status: "needs_clarification"
    });
  });

  it("leaves ordinary prose queries on the normal retrieval path", () => {
    expect(planStructuredDataQuery("What is the retention policy?", workbook()))
      .toEqual({ status: "not_applicable" });
  });
});
