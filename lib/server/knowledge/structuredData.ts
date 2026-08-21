import { utils as spreadsheetUtils } from "xlsx";

/** Historical receipt schema only; query-time spreadsheet execution is retired. */
export const STRUCTURED_PLAN_VERSION = 1 as const;
export const STRUCTURED_MAX_FILTERS = 8;
export const STRUCTURED_MAX_RESULT_ROWS = 200;
export const STRUCTURED_MAX_SCAN_ROWS = 100_000;
export const STRUCTURED_MAX_SERIALIZED_BYTES = 64 * 1_024;

export type StructuredScalar = string | number | boolean | null;
export type StructuredFilterOperator =
  | "contains"
  | "eq"
  | "gt"
  | "gte"
  | "is_missing"
  | "is_present"
  | "lt"
  | "lte"
  | "ne";

export type StructuredTarget = Readonly<{ range: string; sheet: string }>;
export type StructuredFilter = Readonly<{
  column: string;
  operator: StructuredFilterOperator;
  value?: Exclude<StructuredScalar, null>;
}>;
export type StructuredSort = Readonly<{ column: string; direction: "asc" | "desc" }>;

type StructuredPlanBase = Readonly<{
  filters: readonly StructuredFilter[];
  includeHidden: boolean;
  limit: number;
  select: readonly string[];
  target: StructuredTarget;
  version: typeof STRUCTURED_PLAN_VERSION;
}>;

export type StructuredAggregatePlan = StructuredPlanBase & Readonly<{
  aggregate: "average" | "count" | "count_distinct" | "max" | "median" | "min" | "sum";
  groupBy: readonly string[];
  operation: "aggregate";
  valueColumn: string | null;
}>;
export type StructuredArithmeticPlan = StructuredPlanBase & Readonly<{
  leftColumn: string;
  operation: "arithmetic";
  operator: "add" | "divide" | "multiply" | "percent_change" | "subtract";
  resultLabel: string;
  rightColumn: string;
}>;
export type StructuredFormulaAuditPlan = StructuredPlanBase &
  Readonly<{ operation: "formula_audit" }>;
export type StructuredJoinPlan = StructuredPlanBase & Readonly<{
  joinType: "inner" | "left";
  leftKey: string;
  operation: "join";
  rightKey: string;
  rightSelect: readonly string[];
  rightTarget: StructuredTarget;
}>;
export type StructuredListRowsPlan = StructuredPlanBase & Readonly<{
  operation: "list_rows";
  sort: readonly StructuredSort[];
}>;
export type StructuredOutliersPlan = StructuredPlanBase & Readonly<{
  method: "iqr";
  operation: "outliers";
  valueColumn: string;
}>;
export type StructuredTrendPlan = StructuredPlanBase & Readonly<{
  aggregate: "average" | "count" | "max" | "median" | "min" | "sum";
  dateColumn: string;
  operation: "trend";
  valueColumn: string;
}>;

export type StructuredPlan =
  | StructuredAggregatePlan
  | StructuredArithmeticPlan
  | StructuredFormulaAuditPlan
  | StructuredJoinPlan
  | StructuredListRowsPlan
  | StructuredOutliersPlan
  | StructuredTrendPlan;

export type StructuredInputRange = Readonly<{
  range: string;
  role: "filter" | "group" | "join" | "read" | "sort" | "value";
  sheet: string;
  sheetIndex: number;
}>;
export type StructuredOperationReceipt = Readonly<{
  formulaCellsUsed: number;
  hiddenRowsExcluded: number;
  inputRanges: readonly StructuredInputRange[];
  operation: StructuredPlan["operation"];
  operationSummary: string;
  outputRows: number;
  plan: StructuredPlan;
  rowsMatched: number;
  rowsScanned: number;
  warnings: readonly string[];
}>;
export type StructuredAnalysisResult = Readonly<{
  columns: readonly string[];
  receipt: StructuredOperationReceipt;
  rows: readonly (readonly StructuredScalar[])[];
}>;

const PLAN_OPERATIONS = new Set<StructuredPlan["operation"]>([
  "aggregate",
  "arithmetic",
  "formula_audit",
  "join",
  "list_rows",
  "outliers",
  "trend"
]);
const FILTER_OPERATORS = new Set<StructuredFilterOperator>([
  "contains",
  "eq",
  "gt",
  "gte",
  "is_missing",
  "is_present",
  "lt",
  "lte",
  "ne"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const accepted = new Set(keys);
  return Object.keys(value).every((key) => accepted.has(key));
}

function boundedText(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string" || /\u0000/u.test(value)) return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function stringList(value: unknown, maximum: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const result = value.map((item) => boundedText(item));
  return result.some((item) => item === null) || new Set(result).size !== result.length
    ? null
    : result as string[];
}

function target(value: unknown): StructuredTarget | null {
  if (!record(value) || !onlyKeys(value, ["range", "sheet"])) return null;
  const range = boundedText(value.range, 32);
  const sheet = boundedText(value.sheet);
  if (!range || !sheet) return null;
  try {
    if (spreadsheetUtils.encode_range(spreadsheetUtils.decode_range(range)) !== range) return null;
  } catch {
    return null;
  }
  return Object.freeze({ range, sheet });
}

function filters(value: unknown): readonly StructuredFilter[] | null {
  if (!Array.isArray(value) || value.length > STRUCTURED_MAX_FILTERS) return null;
  const parsed: StructuredFilter[] = [];
  for (const candidate of value) {
    if (!record(candidate) || !onlyKeys(candidate, ["column", "operator", "value"])) return null;
    const column = boundedText(candidate.column);
    if (!column || !FILTER_OPERATORS.has(candidate.operator as StructuredFilterOperator)) {
      return null;
    }
    const operator = candidate.operator as StructuredFilterOperator;
    const missing = operator === "is_missing" || operator === "is_present";
    if (missing !== (candidate.value === undefined) || !missing && (
      candidate.value === null || !["boolean", "number", "string"].includes(
        typeof candidate.value
      )
    ) || typeof candidate.value === "number" && !Number.isFinite(candidate.value) ||
      typeof candidate.value === "string" && !boundedText(candidate.value, 1_000)) return null;
    parsed.push(Object.freeze({
      column,
      operator,
      ...(missing ? {} : { value: candidate.value as Exclude<StructuredScalar, null> })
    }));
  }
  return Object.freeze(parsed);
}

function basePlan(value: Record<string, unknown>): StructuredPlanBase | null {
  const parsedTarget = target(value.target);
  const parsedFilters = filters(value.filters);
  const select = stringList(value.select, 32);
  if (!parsedTarget || !parsedFilters || !select || value.version !== STRUCTURED_PLAN_VERSION ||
    typeof value.includeHidden !== "boolean" || !Number.isSafeInteger(value.limit) ||
    Number(value.limit) < 1 || Number(value.limit) > STRUCTURED_MAX_RESULT_ROWS) return null;
  return Object.freeze({
    filters: parsedFilters,
    includeHidden: value.includeHidden,
    limit: Number(value.limit),
    select,
    target: parsedTarget,
    version: STRUCTURED_PLAN_VERSION
  });
}

function parsedSort(value: unknown): readonly StructuredSort[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const result: StructuredSort[] = [];
  for (const candidate of value) {
    if (!record(candidate) || !onlyKeys(candidate, ["column", "direction"])) return null;
    const column = boundedText(candidate.column);
    if (!column || candidate.direction !== "asc" && candidate.direction !== "desc") return null;
    result.push(Object.freeze({ column, direction: candidate.direction }));
  }
  return Object.freeze(result);
}

function withinPlanSize(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= 16 * 1_024;
  } catch {
    return false;
  }
}

/** Strict decoder retained solely for immutable historical citation receipts. */
export function decodeStructuredPlan(value: unknown): StructuredPlan | null {
  if (!record(value) || !PLAN_OPERATIONS.has(value.operation as StructuredPlan["operation"]) ||
    !withinPlanSize(value)) return null;
  const base = basePlan(value);
  if (!base) return null;
  if (value.operation === "list_rows") {
    if (!onlyKeys(value, [
      "filters", "includeHidden", "limit", "operation", "select", "sort", "target", "version"
    ])) return null;
    const sort = parsedSort(value.sort);
    return sort ? Object.freeze({ ...base, operation: "list_rows", sort }) : null;
  }
  if (value.operation === "aggregate") {
    if (!onlyKeys(value, [
      "aggregate", "filters", "groupBy", "includeHidden", "limit", "operation", "select",
      "target", "valueColumn", "version"
    ])) return null;
    const aggregate = value.aggregate;
    const groupBy = stringList(value.groupBy, 3);
    const valueColumn = value.valueColumn === null ? null : boundedText(value.valueColumn);
    if (!groupBy || base.select.length > 0 || ![
      "average", "count", "count_distinct", "max", "median", "min", "sum"
    ].includes(String(aggregate)) || aggregate === "count" && valueColumn !== null ||
      aggregate !== "count" && !valueColumn) return null;
    return Object.freeze({
      ...base,
      aggregate,
      groupBy,
      operation: "aggregate",
      valueColumn
    }) as StructuredAggregatePlan;
  }
  if (value.operation === "arithmetic") {
    if (!onlyKeys(value, [
      "filters", "includeHidden", "leftColumn", "limit", "operation", "operator",
      "resultLabel", "rightColumn", "select", "target", "version"
    ])) return null;
    const leftColumn = boundedText(value.leftColumn);
    const rightColumn = boundedText(value.rightColumn);
    const resultLabel = boundedText(value.resultLabel);
    if (!leftColumn || !rightColumn || !resultLabel || ![
      "add", "divide", "multiply", "percent_change", "subtract"
    ].includes(String(value.operator))) return null;
    return Object.freeze({
      ...base,
      leftColumn,
      operation: "arithmetic",
      operator: value.operator,
      resultLabel,
      rightColumn
    }) as StructuredArithmeticPlan;
  }
  if (value.operation === "formula_audit") {
    return onlyKeys(value, [
      "filters", "includeHidden", "limit", "operation", "select", "target", "version"
    ]) && base.filters.length === 0 && base.select.length === 0
      ? Object.freeze({ ...base, operation: "formula_audit" })
      : null;
  }
  if (value.operation === "join") {
    if (!onlyKeys(value, [
      "filters", "includeHidden", "joinType", "leftKey", "limit", "operation", "rightKey",
      "rightSelect", "rightTarget", "select", "target", "version"
    ])) return null;
    const leftKey = boundedText(value.leftKey);
    const rightKey = boundedText(value.rightKey);
    const rightSelect = stringList(value.rightSelect, 16);
    const rightTarget = target(value.rightTarget);
    if (!leftKey || !rightKey || !rightSelect || !rightTarget ||
      value.joinType !== "inner" && value.joinType !== "left") return null;
    return Object.freeze({
      ...base,
      joinType: value.joinType,
      leftKey,
      operation: "join",
      rightKey,
      rightSelect,
      rightTarget
    });
  }
  if (value.operation === "outliers") {
    if (!onlyKeys(value, [
      "filters", "includeHidden", "limit", "method", "operation", "select", "target",
      "valueColumn", "version"
    ])) return null;
    const valueColumn = boundedText(value.valueColumn);
    return value.method === "iqr" && valueColumn
      ? Object.freeze({ ...base, method: "iqr", operation: "outliers", valueColumn })
      : null;
  }
  if (!onlyKeys(value, [
    "aggregate", "dateColumn", "filters", "includeHidden", "limit", "operation", "select",
    "target", "valueColumn", "version"
  ])) return null;
  const dateColumn = boundedText(value.dateColumn);
  const valueColumn = boundedText(value.valueColumn);
  if (!dateColumn || !valueColumn || base.select.length > 0 || ![
    "average", "count", "max", "median", "min", "sum"
  ].includes(String(value.aggregate))) return null;
  return Object.freeze({
    ...base,
    aggregate: value.aggregate,
    dateColumn,
    operation: "trend",
    valueColumn
  }) as StructuredTrendPlan;
}

/** Strict read-only decoder retained for immutable receipts and citation history. */
export function decodeStructuredAnalysisResult(value: unknown): StructuredAnalysisResult | null {
  if (!record(value) || !onlyKeys(value, ["columns", "receipt", "rows"]) ||
    !Array.isArray(value.columns) || !Array.isArray(value.rows) || !record(value.receipt)) return null;
  const columns = value.columns;
  const rows = value.rows;
  const receipt = value.receipt;
  if (columns.length < 1 || columns.length > 64 ||
    columns.some((column) => !boundedText(column, 256)) ||
    rows.length > STRUCTURED_MAX_RESULT_ROWS || rows.some((row) =>
      !Array.isArray(row) || row.length !== columns.length || row.some((cell) =>
        cell !== null && (
          typeof cell === "number" && !Number.isFinite(cell) ||
          !["boolean", "number", "string"].includes(typeof cell) ||
          typeof cell === "string" && (cell.length > 32_767 || /\u0000/u.test(cell))
        ))) || !onlyKeys(receipt, [
      "formulaCellsUsed", "hiddenRowsExcluded", "inputRanges", "operation",
      "operationSummary", "outputRows", "plan", "rowsMatched", "rowsScanned", "warnings"
    ])) return null;
  const plan = decodeStructuredPlan(receipt.plan);
  const integer = (candidate: unknown, maximum = STRUCTURED_MAX_SCAN_ROWS) =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= maximum;
  if (!plan || receipt.operation !== plan.operation ||
    !boundedText(receipt.operationSummary, 2_000) || !integer(receipt.formulaCellsUsed) ||
    !integer(receipt.hiddenRowsExcluded) || !integer(receipt.rowsMatched) ||
    !integer(receipt.rowsScanned) || !integer(receipt.outputRows, STRUCTURED_MAX_RESULT_ROWS) ||
    receipt.outputRows !== rows.length || !Array.isArray(receipt.inputRanges) ||
    receipt.inputRanges.length < 1 || receipt.inputRanges.length > 64 ||
    !Array.isArray(receipt.warnings) || receipt.warnings.length > 32 ||
    receipt.warnings.some((warning) => !boundedText(warning, 256)) ||
    new Set(receipt.warnings).size !== receipt.warnings.length ||
    receipt.inputRanges.some((candidate) => {
      if (!record(candidate) || !onlyKeys(candidate, ["range", "role", "sheet", "sheetIndex"]) ||
        !boundedText(candidate.range, 32) || !boundedText(candidate.sheet, 256) ||
        !["filter", "group", "join", "read", "sort", "value"].includes(
          String(candidate.role)
        ) || !Number.isSafeInteger(candidate.sheetIndex) || Number(candidate.sheetIndex) < 0 ||
        Number(candidate.sheetIndex) >= 64) return true;
      try {
        return spreadsheetUtils.encode_range(
          spreadsheetUtils.decode_range(candidate.range as string)
        ) !== candidate.range;
      } catch {
        return true;
      }
    }) || Buffer.byteLength(JSON.stringify(value), "utf8") > STRUCTURED_MAX_SERIALIZED_BYTES) {
    return null;
  }
  return Object.freeze({
    columns: Object.freeze([...(columns as string[])]),
    receipt: Object.freeze({
      formulaCellsUsed: Number(receipt.formulaCellsUsed),
      hiddenRowsExcluded: Number(receipt.hiddenRowsExcluded),
      inputRanges: Object.freeze(receipt.inputRanges as StructuredInputRange[]),
      operation: plan.operation,
      operationSummary: String(receipt.operationSummary),
      outputRows: Number(receipt.outputRows),
      plan,
      rowsMatched: Number(receipt.rowsMatched),
      rowsScanned: Number(receipt.rowsScanned),
      warnings: Object.freeze([...(receipt.warnings as string[])])
    }),
    rows: Object.freeze((rows as StructuredScalar[][]).map((row) => Object.freeze([...row])))
  });
}
