import { performance } from "node:perf_hooks";
import { utils, write, type BookType } from "xlsx";
import { parseSpreadsheetDocument, type ParsedWorkbook } from "../../lib/server/parsing";
import type { KnowledgeExtractionConfig } from "../../lib/server/knowledge/knowledgeExtractionConfig";
import { encodeKnowledgeNormalizedDocument } from "../../lib/server/knowledge/normalizedDocument";
import {
  executeStructuredPlan,
  STRUCTURED_PLAN_VERSION,
  type StructuredPlan
} from "../../lib/server/knowledge/structuredData";
import { planStructuredDataQuery } from "../../lib/server/knowledge/structuredPlanner";
import { analyzeStructuredKnowledgeSources } from "../../lib/server/knowledge/structuredRetrieval";

export const KNOWLEDGE_STRUCTURED_EVAL_VERSION = 1 as const;

export const knowledgeStructuredLaunchGates = Object.freeze({
  ambiguitySafetyMinimum: 1,
  boundedFailureMinimum: 1,
  cachedFormulaMinimum: 1,
  dateExactnessMinimum: 1,
  formatPassRateMinimum: 1,
  formulaInjectionBlocked: true,
  hiddenPolicyMinimum: 1,
  localeExactnessMinimum: 1,
  maximumExecutionP95Ms: 100,
  missingValueMinimum: 1,
  multiSheetMinimum: 1,
  numericExactnessMinimum: 1,
  ordinaryFallbackMinimum: 1,
  plannerRoutingMinimum: 1
});

export type KnowledgeStructuredEvalReport = Readonly<{
  fixtureCount: number;
  gates: typeof knowledgeStructuredLaunchGates;
  metrics: Readonly<{
    ambiguitySafety: number;
    boundedFailure: number;
    cachedFormula: number;
    dateExactness: number;
    executionP95Ms: number;
    formatPassRate: number;
    formulaInjectionBlocked: boolean;
    hiddenPolicy: number;
    localeExactness: number;
    missingValue: number;
    multiSheet: number;
    numericExactness: number;
    ordinaryFallback: number;
    plannerRouting: number;
  }>;
  passed: boolean;
  version: typeof KNOWLEDGE_STRUCTURED_EVAL_VERSION;
}>;

const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const extractionConfig: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 2_000_000,
  maxNormalizedChars: 2_000_000,
  maxNormalizedObjectBytes: 8_000_000,
  maxPages: 100
};

function workbookBytes(bookType: BookType): Buffer {
  const sales = utils.aoa_to_sheet([
    ["Region", "Revenue", "Cost", "Closed at", "Key", "Margin", "Note"],
    ["North", 100, 60, new Date(2026, 0, 1), "N", null, "safe"],
    ["South", "110,50", 90, new Date(2026, 0, 2), "S", null, "safe"],
    ["Central", 120, 80, new Date(2026, 0, 3), "C", null, "safe"],
    ["East", null, 40, new Date(2026, 0, 4), "E", null, "safe"],
    ["Secret", 10_000, 0, new Date(2026, 0, 5), "X", null, "hidden"]
  ], { cellDates: true });
  sales.F2 = { f: "B2-C2", t: "n", v: 40, w: "40", z: "0" };
  sales["!rows"] = [{}, {}, {}, {}, {}, { hidden: true }];
  const people = utils.aoa_to_sheet([
    ["Key", "Manager"],
    ["N", "Alice"],
    ["S", "Boris"],
    ["C", "Chao"],
    ["E", "Daria"],
    ["X", "Private"]
  ]);
  const value = utils.book_new();
  utils.book_append_sheet(value, sales, "Sales");
  utils.book_append_sheet(value, people, "People");
  return write(value, { bookType, type: "buffer" });
}

function parsedWorkbook(bookType: "ods" | "xls" | "xlsx" = "xlsx"): ParsedWorkbook {
  const mimeType = bookType === "xls"
    ? "application/vnd.ms-excel"
    : bookType === "ods"
      ? "application/vnd.oasis.opendocument.spreadsheet"
      : xlsxMime;
  return parseSpreadsheetDocument({
    bytes: workbookBytes(bookType),
    fileName: `structured-golden.${bookType}`,
    mimeType
  }).workbook!;
}

function listPlan(overrides: Record<string, unknown> = {}): StructuredPlan {
  const value: Record<string, unknown> = {
    filters: [],
    includeHidden: false,
    limit: 20,
    operation: "list_rows",
    select: ["Region", "Revenue"],
    sort: [],
    target: { range: "A1:G6", sheet: "Sales" },
    version: STRUCTURED_PLAN_VERSION,
    ...overrides
  };
  if (value.operation !== "list_rows") delete value.sort;
  return value as StructuredPlan;
}

function aggregatePlan(valueColumn: string, includeHidden = false): StructuredPlan {
  return listPlan({
    aggregate: "sum",
    groupBy: [],
    includeHidden,
    operation: "aggregate",
    select: [],
    valueColumn
  });
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
    fileName: "structured-large.xlsx",
    mimeType: xlsxMime
  }).workbook!;
}

function catchesCode(run: () => unknown, code: string): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === code;
  }
}

async function formulaInjectionIsBlocked(): Promise<boolean> {
  const parsed = parseSpreadsheetDocument({
    bytes: Buffer.from(
      "Region;Revenue;Note\nNorth;1,25;=HYPERLINK(\"https://invalid\")\nSouth;2,75;safe\n"
    ),
    fileName: "structured-locale.csv",
    mimeType: "text/csv"
  });
  const encoded = encodeKnowledgeNormalizedDocument(parsed, extractionConfig, {
    sourceDisplayName: "Structured locale"
  });
  const result = await analyzeStructuredKnowledgeSources({
    candidates: [{
      artifactId: "synthetic-structured-artifact",
      baseName: "Synthetic structured base",
      bindingOrdinal: 0,
      documentId: "synthetic-structured-document",
      documentVersionId: "synthetic-structured-version",
      documentVersionNumber: 1,
      fileName: "structured-locale.csv",
      knowledgeBaseId: "synthetic-structured-base",
      normalizedTextByteSize: encoded.body.byteLength,
      normalizedTextChecksum: encoded.checksum,
      normalizedTextStorageKey: "synthetic/structured-locale.json",
      sourceName: "Structured locale"
    }],
    config: extractionConfig,
    loadAnchor: async () => ({
      contentHash: "a".repeat(64),
      headingPath: ["structured-locale"],
      id: "synthetic-structured-passage",
      ordinal: 0,
      sectionId: "synthetic-structured-section"
    }),
    query: "Show the structured-locale table column Note",
    storage: {
      getObject: async (storageKey: string) => ({
        body: encoded.body,
        contentType: "application/json",
        storageKey
      })
    }
  });
  const formulaLikeCell = parsed.workbook?.sheets[0]?.cells.find((cell) => cell.address === "C2");
  return result.kind === "complete" && formulaLikeCell?.formula === null &&
    result.passage.text.includes("'=HYPERLINK") && result.passage.structuredAnalysis
      ?.receipt.formulaCellsUsed === 0;
}

export async function runKnowledgeStructuredEval(): Promise<KnowledgeStructuredEvalReport> {
  const formats = (["xls", "xlsx", "ods"] as const).map((format) => {
    const result = executeStructuredPlan(parsedWorkbook(format), aggregatePlan("Revenue"));
    return result.rows[0]?.[0] === (format === "xlsx" ? 330.5 : 10_330.5);
  });
  const value = parsedWorkbook();
  const visible = executeStructuredPlan(value, aggregatePlan("Revenue"));
  const hidden = executeStructuredPlan(value, aggregatePlan("Revenue", true));
  const cachedFormula = executeStructuredPlan(value, aggregatePlan("Margin"));
  const filteredDates = executeStructuredPlan(value, listPlan({
    filters: [{ column: "Closed at", operator: "gte", value: "2026-01-02" }],
    select: ["Region"]
  }));
  const joined = executeStructuredPlan(value, listPlan({
    joinType: "left",
    leftKey: "Key",
    operation: "join",
    rightKey: "Key",
    rightSelect: ["Manager"],
    rightTarget: { range: "A1:B6", sheet: "People" },
    select: ["Region", "Key"]
  }));
  const csv = parseSpreadsheetDocument({
    bytes: Buffer.from("Region;Revenue\nNorth;1,25\nSouth;2,75\n"),
    fileName: "locale.csv",
    mimeType: "text/csv"
  }).workbook!;
  const locale = executeStructuredPlan(csv, {
    aggregate: "sum",
    filters: [],
    groupBy: [],
    includeHidden: false,
    limit: 20,
    operation: "aggregate",
    select: [],
    target: { range: "A1:B3", sheet: "Sheet1" },
    valueColumn: "Revenue",
    version: STRUCTURED_PLAN_VERSION
  });
  const routed = planStructuredDataQuery(
    "Посчитай сумму Revenue по Region на листе Sales",
    value
  );
  const ambiguous = planStructuredDataQuery("Calculate the sum in Sales", value);
  const ordinary = planStructuredDataQuery("What is the retention policy?", value);

  const controller = new AbortController();
  controller.abort();
  const boundedChecks = [
    catchesCode(
      () => executeStructuredPlan(value, listPlan(), { signal: controller.signal }),
      "structured_execution_aborted"
    ),
    catchesCode(
      () => executeStructuredPlan(oversizedResultWorkbook(), listPlan({
        limit: 200,
        select: ["Payload"],
        target: { range: "A1:B101", sheet: "Large" }
      })),
      "structured_result_too_large"
    ),
    catchesCode(
      () => executeStructuredPlan(
        value,
        { ...listPlan(), command: "eval(source)" } as unknown as StructuredPlan
      ),
      "structured_plan_invalid"
    )
  ];

  const durations: number[] = [];
  for (let index = 0; index < 200; index += 1) {
    const startedAt = performance.now();
    executeStructuredPlan(value, aggregatePlan("Revenue"));
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const executionP95Ms = Number((durations[Math.floor(durations.length * 0.95)] ??
    Number.POSITIVE_INFINITY).toFixed(3));

  const metrics = {
    ambiguitySafety: ambiguous.status === "needs_clarification" ? 1 : 0,
    boundedFailure: boundedChecks.filter(Boolean).length / boundedChecks.length,
    cachedFormula: cachedFormula.rows[0]?.[0] === 40 &&
      cachedFormula.receipt.formulaCellsUsed === 1 ? 1 : 0,
    dateExactness: JSON.stringify(filteredDates.rows) ===
      JSON.stringify([["South"], ["Central"], ["East"]]) ? 1 : 0,
    executionP95Ms,
    formatPassRate: formats.filter(Boolean).length / formats.length,
    formulaInjectionBlocked: await formulaInjectionIsBlocked(),
    hiddenPolicy: visible.rows[0]?.[0] === 330.5 && hidden.rows[0]?.[0] === 10_330.5 ? 1 : 0,
    localeExactness: locale.rows[0]?.[0] === 4 ? 1 : 0,
    missingValue: visible.receipt.warnings.includes("missing_values_excluded") ? 1 : 0,
    multiSheet: joined.rows.length === 4 && joined.rows[1]?.[2] === "Boris" ? 1 : 0,
    numericExactness: visible.rows[0]?.[0] === 330.5 ? 1 : 0,
    ordinaryFallback: ordinary.status === "not_applicable" ? 1 : 0,
    plannerRouting: routed.status === "ready" && routed.plan.operation === "aggregate" ? 1 : 0
  };
  const gates = knowledgeStructuredLaunchGates;
  const passed = metrics.ambiguitySafety >= gates.ambiguitySafetyMinimum &&
    metrics.boundedFailure >= gates.boundedFailureMinimum &&
    metrics.cachedFormula >= gates.cachedFormulaMinimum &&
    metrics.dateExactness >= gates.dateExactnessMinimum &&
    metrics.executionP95Ms <= gates.maximumExecutionP95Ms &&
    metrics.formatPassRate >= gates.formatPassRateMinimum &&
    metrics.formulaInjectionBlocked === gates.formulaInjectionBlocked &&
    metrics.hiddenPolicy >= gates.hiddenPolicyMinimum &&
    metrics.localeExactness >= gates.localeExactnessMinimum &&
    metrics.missingValue >= gates.missingValueMinimum &&
    metrics.multiSheet >= gates.multiSheetMinimum &&
    metrics.numericExactness >= gates.numericExactnessMinimum &&
    metrics.ordinaryFallback >= gates.ordinaryFallbackMinimum &&
    metrics.plannerRouting >= gates.plannerRoutingMinimum;
  return {
    fixtureCount: 18,
    gates,
    metrics,
    passed,
    version: KNOWLEDGE_STRUCTURED_EVAL_VERSION
  };
}

export function assertKnowledgeStructuredEvalGates(report: KnowledgeStructuredEvalReport): void {
  if (!report.passed) throw new Error("knowledge_structured_eval_gate_failed");
}
