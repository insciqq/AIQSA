import { utils, write } from "xlsx";
import { vi } from "vitest";
import { parseSpreadsheetDocument, type ParsedWorkbook } from "../parsing";
import {
  decodeStructuredPlan,
  executeStructuredPlan,
  STRUCTURED_ARITHMETIC_SIGNIFICANT_DIGITS,
  STRUCTURED_PLAN_VERSION,
  verifyStructuredAnalysisResult,
  type StructuredPlan
} from "./structuredData";

function workbook(): ParsedWorkbook {
  const sales = utils.aoa_to_sheet([
    ["Region", "Revenue", "Cost", "Closed at", "Status", "Key", "Margin"],
    ["North", 100, 60, new Date(2026, 0, 1), "Open", "N", null],
    ["South", "110,50", 90, new Date(2026, 0, 2), "Closed", "S", null],
    ["Central", 120, 80, new Date(2026, 0, 3), "Open", "C", null],
    ["East", null, 40, new Date(2026, 0, 4), "Open", "E", null],
    ["West", 5_000, 100, new Date(2026, 0, 5), "=HYPERLINK(\"https://invalid\")", "W", null],
    ["Secret", 10_000, 0, new Date(2026, 0, 6), "Hidden", "X", null]
  ], { cellDates: true });
  sales.G2 = { f: "B2-C2", t: "n", v: 40, z: "0.00" };
  sales["!rows"] = [{}, {}, {}, {}, {}, {}, { hidden: true }];
  const people = utils.aoa_to_sheet([
    ["Key", "Manager"],
    ["N", "Alice"],
    ["S", "Boris"],
    ["C", "Chao"],
    ["E", "Daria"],
    ["W", "Eli"],
    ["X", "Private"]
  ]);
  const value = utils.book_new();
  utils.book_append_sheet(value, sales, "Sales");
  utils.book_append_sheet(value, people, "People");
  const parsed = parseSpreadsheetDocument({
    bytes: write(value, { bookType: "xlsx", type: "buffer" }),
    fileName: "sales.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  return parsed.workbook!;
}

function base(overrides: Record<string, unknown> = {}): StructuredPlan {
  const value: Record<string, unknown> = {
    filters: [],
    includeHidden: false,
    limit: 20,
    operation: "list_rows",
    select: ["Region", "Revenue"],
    sort: [],
    target: { range: "A1:G7", sheet: "Sales" },
    version: STRUCTURED_PLAN_VERSION,
    ...overrides
  };
  if (value.operation !== "list_rows") delete value.sort;
  return value as StructuredPlan;
}

function oversizedResultWorkbook(): ParsedWorkbook {
  const sheet = utils.aoa_to_sheet([
    ["Key", "Payload"],
    ...Array.from({ length: 100 }, (_value, index) => [index + 1, "x".repeat(1_000)])
  ]);
  const value = utils.book_new();
  utils.book_append_sheet(value, sheet, "Large");
  return parseSpreadsheetDocument({
    bytes: write(value, { bookType: "xlsx", type: "buffer" }),
    fileName: "large.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }).workbook!;
}

function overflowWorkbook(): ParsedWorkbook {
  const sheet = utils.aoa_to_sheet([
    ["Value"],
    [1e308],
    [1e308]
  ]);
  const value = utils.book_new();
  utils.book_append_sheet(value, sheet, "Overflow");
  return parseSpreadsheetDocument({
    bytes: write(value, { bookType: "xlsx", type: "buffer" }),
    fileName: "overflow.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }).workbook!;
}

function decimalArithmeticWorkbook(englishRight = "0.2"): ParsedWorkbook {
  const sheet = utils.aoa_to_sheet([
    ["Locale", "Left", "Right"],
    ["EN point", "0.1", englishRight],
    ["RU comma", "0,1", "0,2"]
  ]);
  const value = utils.book_new();
  utils.book_append_sheet(value, sheet, "Arithmetic");
  return parseSpreadsheetDocument({
    bytes: write(value, { bookType: "xlsx", type: "buffer" }),
    fileName: "decimal-arithmetic.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }).workbook!;
}

function decimalArithmeticPlan(): StructuredPlan {
  return {
    filters: [],
    includeHidden: false,
    leftColumn: "Left",
    limit: 20,
    operation: "arithmetic",
    operator: "add",
    resultLabel: "Total",
    rightColumn: "Right",
    select: ["Locale"],
    target: { range: "A1:C3", sheet: "Arithmetic" },
    version: STRUCTURED_PLAN_VERSION
  };
}

function sparseJoinWorkbook(rowsPerSheet: number): ParsedWorkbook {
  const sheet = (name: string, index: number) => ({
    cells: [{
      address: "A1",
      column: 0,
      display: "Key",
      formula: null,
      numberFormat: null,
      row: 0,
      type: "string" as const,
      value: "Key"
    }],
    columnCount: 1,
    hidden: "visible" as const,
    hiddenColumns: [],
    hiddenRows: [],
    index,
    merges: [],
    name,
    regions: [{
      a1: `A1:A${rowsPerSheet + 1}`,
      columnEnd: 0,
      columnLabels: ["Key"],
      columnStart: 0,
      headerRow: 0,
      rowEnd: rowsPerSheet,
      rowLabelColumns: [0],
      rowStart: 0
    }],
    rowCount: rowsPerSheet + 1,
    truncated: false
  });
  return {
    dateSystem: "1900",
    sheets: [sheet("Left", 0), sheet("Right", 1)],
    warnings: []
  };
}

describe("bounded structured workbook execution", () => {
  it("aggregates locale-formatted numbers and excludes hidden rows by default", () => {
    const result = executeStructuredPlan(workbook(), base({
      aggregate: "sum",
      groupBy: [],
      operation: "aggregate",
      select: [],
      valueColumn: "Revenue"
    }));

    expect(result).toMatchObject({
      columns: ["sum Revenue"],
      rows: [[5_330.5]],
      receipt: {
        hiddenRowsExcluded: 1,
        operation: "aggregate",
        rowsMatched: 5,
        warnings: ["locale_numeric_text_coerced", "missing_values_excluded"]
      }
    });
    expect(result.receipt.inputRanges).toContainEqual({
      range: "B2:B7",
      role: "value",
      sheet: "Sales",
      sheetIndex: 0
    });
  });

  it("filters typed dates, sorts numeric values, and keeps formula-like text inert", () => {
    const result = executeStructuredPlan(workbook(), base({
      filters: [{ column: "Closed at", operator: "gte", value: "2026-01-03" }],
      operation: "list_rows",
      select: ["Region", "Revenue", "Status"],
      sort: [{ column: "Revenue", direction: "desc" }]
    }));

    expect(result.rows).toEqual([
      ["West", 5_000, "=HYPERLINK(\"https://invalid\")"],
      ["Central", 120, "Open"],
      ["East", null, "Open"]
    ]);
    expect(result.receipt.formulaCellsUsed).toBe(0);
  });

  it("runs row arithmetic without evaluating source formulas", () => {
    const result = executeStructuredPlan(workbook(), base({
      leftColumn: "Revenue",
      operation: "arithmetic",
      operator: "subtract",
      resultLabel: "Revenue less cost",
      rightColumn: "Cost",
      select: ["Region"]
    }));

    expect(result.columns).toEqual(["Region", "Revenue less cost"]);
    expect(result.rows.slice(0, 4)).toEqual([
      ["North", 40],
      ["South", 20.5],
      ["Central", 40],
      ["East", null]
    ]);
  });

  it("recomputes persisted decimal arithmetic and rejects any result or receipt tamper", () => {
    const source = decimalArithmeticWorkbook();
    const result = executeStructuredPlan(source, decimalArithmeticPlan());

    expect(STRUCTURED_ARITHMETIC_SIGNIFICANT_DIGITS).toBe(15);
    expect(result.rows).toEqual([
      ["EN point", 0.3],
      ["RU comma", 0.3]
    ]);
    expect(result.receipt.warnings).toEqual(["locale_numeric_text_coerced"]);
    expect(verifyStructuredAnalysisResult(source, result)).toBe(true);

    const [firstRange, ...remainingRanges] = result.receipt.inputRanges;
    expect(firstRange).toBeDefined();
    const tamperedValues: readonly unknown[] = [
      {
        ...result,
        rows: result.rows.map((row, index) => index === 0 ? [row[0]!, 0.30000000000000004] : row)
      },
      { ...result, columns: ["Locale", "Changed"] },
      {
        ...result,
        receipt: { ...result.receipt, plan: { ...result.receipt.plan, operator: "subtract" } }
      },
      {
        ...result,
        receipt: {
          ...result.receipt,
          inputRanges: [{ ...firstRange!, range: "A1:A1" }, ...remainingRanges]
        }
      },
      { ...result, receipt: { ...result.receipt, warnings: [] } },
      {
        ...result,
        receipt: { ...result.receipt, rowsScanned: result.receipt.rowsScanned + 1 }
      },
      { ...result, unexpected: true }
    ];
    for (const tampered of tamperedValues) {
      expect(verifyStructuredAnalysisResult(source, tampered)).toBe(false);
    }
    expect(verifyStructuredAnalysisResult(decimalArithmeticWorkbook("0.4"), result)).toBe(false);
  });

  it("uses cached formula values as data and records that use", () => {
    const result = executeStructuredPlan(workbook(), base({
      aggregate: "sum",
      groupBy: [],
      operation: "aggregate",
      select: [],
      valueColumn: "Margin"
    }));

    expect(result.rows).toEqual([[40]]);
    expect(result.receipt.formulaCellsUsed).toBe(1);
    expect(result.receipt.warnings).toContain("missing_values_excluded");
  });

  it("audits formulas from cached values and never mistakes text for a formula", () => {
    const result = executeStructuredPlan(workbook(), base({
      operation: "formula_audit",
      select: []
    }));

    expect(result.rows).toEqual([["G2", "B2-C2", 40, "cached value present"]]);
    expect(JSON.stringify(result)).not.toContain("HYPERLINK");
    expect(result.receipt.operationSummary).toContain("without evaluating formulas");
    expect(result.receipt).toMatchObject({ hiddenRowsExcluded: 1, rowsScanned: 6 });
  });

  it("cites every default output column when a plan omits an explicit projection", () => {
    const result = executeStructuredPlan(workbook(), base({ select: [] }));
    expect(result.columns).toEqual([
      "Region",
      "Revenue",
      "Cost",
      "Closed at",
      "Status",
      "Key",
      "Margin"
    ]);
    expect(result.receipt.inputRanges).toEqual(expect.arrayContaining([
      { range: "A2:A7", role: "read", sheet: "Sales", sheetIndex: 0 },
      { range: "G2:G7", role: "read", sheet: "Sales", sheetIndex: 0 }
    ]));
  });

  it("joins two sheets by an exact typed key", () => {
    const result = executeStructuredPlan(workbook(), base({
      joinType: "left",
      leftKey: "Key",
      operation: "join",
      rightKey: "Key",
      rightSelect: ["Manager"],
      rightTarget: { range: "A1:B7", sheet: "People" },
      select: ["Region", "Key"]
    }));

    expect(result.columns).toEqual(["Region", "Key", "People.Manager"]);
    expect(result.rows).toEqual([
      ["North", "N", "Alice"],
      ["South", "S", "Boris"],
      ["Central", "C", "Chao"],
      ["East", "E", "Daria"],
      ["West", "W", "Eli"]
    ]);
    expect(result.receipt.inputRanges).toContainEqual({
      range: "A2:A7",
      role: "join",
      sheet: "People",
      sheetIndex: 1
    });
  });

  it("finds IQR outliers and produces an ordered date trend", () => {
    const value = workbook();
    const outliers = executeStructuredPlan(value, base({
      method: "iqr",
      operation: "outliers",
      select: ["Region", "Revenue"],
      valueColumn: "Revenue"
    }));
    expect(outliers.rows).toEqual([["West", 5_000, "above"]]);

    const trend = executeStructuredPlan(value, base({
      aggregate: "sum",
      dateColumn: "Closed at",
      operation: "trend",
      select: [],
      valueColumn: "Revenue"
    }));
    expect(trend.rows).toEqual([
      ["2026-01-01", 100],
      ["2026-01-02", 110.5],
      ["2026-01-03", 120],
      ["2026-01-05", 5_000]
    ]);
    expect(trend.receipt.operationSummary).toContain("first-to-last change 4900");
  });

  it("requires explicit opt-in for hidden data", () => {
    const visible = executeStructuredPlan(workbook(), base({
      aggregate: "sum",
      groupBy: [],
      operation: "aggregate",
      select: [],
      valueColumn: "Revenue"
    }));
    const allRows = executeStructuredPlan(workbook(), base({
      aggregate: "sum",
      groupBy: [],
      includeHidden: true,
      operation: "aggregate",
      select: [],
      valueColumn: "Revenue"
    }));
    expect(visible.rows).toEqual([[5_330.5]]);
    expect(allRows.rows).toEqual([[15_330.5]]);
  });

  it("fails closed for mixed arithmetic types, incomplete sources, and aborts", () => {
    expect(() => executeStructuredPlan(workbook(), base({
      aggregate: "sum",
      groupBy: [],
      operation: "aggregate",
      select: [],
      valueColumn: "Status"
    }))).toThrowError(expect.objectContaining({ code: "structured_mixed_type" }));

    const value = workbook();
    const incomplete = { ...value, warnings: [
      ...value.warnings,
      "spreadsheet_cells_truncated" as const
    ] };
    expect(() => executeStructuredPlan(incomplete, base()))
      .toThrowError(expect.objectContaining({ code: "structured_source_incomplete" }));

    const controller = new AbortController();
    controller.abort();
    expect(() => executeStructuredPlan(value, base(), { signal: controller.signal }))
      .toThrowError(expect.objectContaining({ code: "structured_execution_aborted" }));
  });

  it("enforces timeout, aggregate scan, and serialized-result bounds", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(20);
    try {
      expect(() => executeStructuredPlan(workbook(), base(), { timeoutMs: 10 }))
        .toThrowError(expect.objectContaining({ code: "structured_execution_timeout" }));
    } finally {
      clock.mockRestore();
    }

    expect(() => executeStructuredPlan(sparseJoinWorkbook(50_001), {
      filters: [],
      includeHidden: false,
      joinType: "inner",
      leftKey: "Key",
      limit: 20,
      operation: "join",
      rightKey: "Key",
      rightSelect: [],
      rightTarget: { range: "A1:A50002", sheet: "Right" },
      select: ["Key"],
      target: { range: "A1:A50002", sheet: "Left" },
      version: STRUCTURED_PLAN_VERSION
    }, { timeoutMs: 2_000 })).toThrowError(expect.objectContaining({
      code: "structured_execution_limit_exceeded"
    }));

    expect(() => executeStructuredPlan(oversizedResultWorkbook(), base({
      limit: 200,
      select: ["Payload"],
      target: { range: "A1:B101", sheet: "Large" }
    }))).toThrowError(expect.objectContaining({ code: "structured_result_too_large" }));

    expect(() => executeStructuredPlan(overflowWorkbook(), {
      aggregate: "sum",
      filters: [],
      groupBy: [],
      includeHidden: false,
      limit: 20,
      operation: "aggregate",
      select: [],
      target: { range: "A1:A3", sheet: "Overflow" },
      valueColumn: "Value",
      version: STRUCTURED_PLAN_VERSION
    })).toThrowError(expect.objectContaining({ code: "structured_numeric_overflow" }));
  });

  it("rejects malformed or over-permissive persisted plans", () => {
    const valid = base();
    expect(decodeStructuredPlan(valid)).toEqual(valid);
    expect(decodeStructuredPlan({ ...valid, command: "fetch('https://invalid')" })).toBeNull();
    expect(decodeStructuredPlan({ ...valid, limit: 10_000 })).toBeNull();
    expect(decodeStructuredPlan({
      ...valid,
      filters: [{ column: "Revenue", operator: "execute", value: "process.exit()" }]
    })).toBeNull();
  });
});
