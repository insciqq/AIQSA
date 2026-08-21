import { describe, expect, it } from "vitest";
import {
  decodeStructuredAnalysisResult,
  decodeStructuredPlan,
  STRUCTURED_PLAN_VERSION
} from "./structuredData";

function plan() {
  return {
    filters: [],
    includeHidden: false,
    limit: 20,
    operation: "aggregate",
    select: [],
    target: { range: "A1:B3", sheet: "Sales" },
    aggregate: "sum",
    groupBy: [],
    valueColumn: "Revenue",
    version: STRUCTURED_PLAN_VERSION
  } as const;
}

function receipt() {
  return {
    columns: ["sum Revenue"],
    receipt: {
      formulaCellsUsed: 0,
      hiddenRowsExcluded: 0,
      inputRanges: [{ range: "B2:B3", role: "value", sheet: "Sales", sheetIndex: 0 }],
      operation: "aggregate",
      operationSummary: "sum Revenue",
      outputRows: 1,
      plan: plan(),
      rowsMatched: 2,
      rowsScanned: 2,
      warnings: []
    },
    rows: [[300]]
  } as const;
}

describe("historical structured Knowledge receipt decoder", () => {
  it("decodes the exact immutable plan and analysis receipt", () => {
    expect(decodeStructuredPlan(plan())).toEqual(plan());
    expect(decodeStructuredAnalysisResult(receipt())).toEqual(receipt());
  });

  it("rejects executable extensions and malformed ranges", () => {
    expect(decodeStructuredPlan({ ...plan(), command: "fetch('https://invalid')" })).toBeNull();
    expect(decodeStructuredAnalysisResult({
      ...receipt(),
      receipt: {
        ...receipt().receipt,
        inputRanges: [{ range: "not-a-range", role: "value", sheet: "Sales", sheetIndex: 0 }]
      }
    })).toBeNull();
  });

  it("rejects unattributed or non-finite result cells", () => {
    expect(decodeStructuredAnalysisResult({
      ...receipt(),
      rows: [[Number.POSITIVE_INFINITY]]
    })).toBeNull();
    expect(decodeStructuredAnalysisResult({
      ...receipt(),
      receipt: { ...receipt().receipt, inputRanges: [] }
    })).toBeNull();
  });
});
