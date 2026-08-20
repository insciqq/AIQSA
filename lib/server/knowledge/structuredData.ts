import { utils as spreadsheetUtils } from "xlsx";
import type {
  ParsedWorkbook,
  ParsedWorkbookCell,
  ParsedWorkbookRegion,
  ParsedWorkbookSheet
} from "../parsing";
import { isSpreadsheetDateValue } from "../parsing/spreadsheetDate";

export const STRUCTURED_PLAN_VERSION = 1 as const;
export const STRUCTURED_MAX_FILTERS = 8;
export const STRUCTURED_MAX_RESULT_ROWS = 200;
export const STRUCTURED_MAX_SCAN_ROWS = 100_000;
export const STRUCTURED_MAX_SERIALIZED_BYTES = 64 * 1_024;
// Arithmetic stays a JSON number; 15 significant decimal digits remove binary tail noise.
export const STRUCTURED_ARITHMETIC_SIGNIFICANT_DIGITS = 15;

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

export type StructuredTarget = Readonly<{
  range: string;
  sheet: string;
}>;

export type StructuredFilter = Readonly<{
  column: string;
  operator: StructuredFilterOperator;
  value?: Exclude<StructuredScalar, null>;
}>;

export type StructuredSort = Readonly<{
  column: string;
  direction: "asc" | "desc";
}>;

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

export type StructuredFormulaAuditPlan = StructuredPlanBase & Readonly<{
  operation: "formula_audit";
}>;

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

export type StructuredDataErrorCode =
  | "structured_column_unavailable"
  | "structured_execution_aborted"
  | "structured_execution_limit_exceeded"
  | "structured_execution_timeout"
  | "structured_hidden_data_requires_opt_in"
  | "structured_mixed_type"
  | "structured_no_rows"
  | "structured_numeric_overflow"
  | "structured_plan_invalid"
  | "structured_result_too_large"
  | "structured_source_incomplete"
  | "structured_target_unavailable";

export class StructuredDataError extends Error {
  constructor(readonly code: StructuredDataErrorCode) {
    super(code);
    this.name = "StructuredDataError";
  }
}

type ResolvedTable = Readonly<{
  cellByCoordinate: ReadonlyMap<string, ParsedWorkbookCell>;
  columnByLabel: ReadonlyMap<string, number>;
  dataRowEnd: number;
  dataRowStart: number;
  region: ParsedWorkbookRegion;
  sheet: ParsedWorkbookSheet;
}>;

type TableRow = Readonly<{
  row: number;
  values: ReadonlyMap<number, ParsedWorkbookCell>;
}>;

type ExecutionState = {
  deadline: number;
  formulaCellsUsed: Set<string>;
  hiddenRowsExcluded: number;
  rowsMatched: number;
  rowsScanned: number;
  signal?: AbortSignal;
  warnings: Set<string>;
};

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

function fail(code: StructuredDataErrorCode): never {
  throw new StructuredDataError(code);
}

function canonicalArithmeticNumber(value: number): number {
  if (!Number.isFinite(value)) fail("structured_numeric_overflow");
  if (Object.is(value, -0)) return 0;
  if (Number.isSafeInteger(value)) return value;
  const canonical = Number(value.toPrecision(STRUCTURED_ARITHMETIC_SIGNIFICANT_DIGITS));
  if (!Number.isFinite(canonical)) fail("structured_numeric_overflow");
  return Object.is(canonical, -0) ? 0 : canonical;
}

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
    if (!column || !FILTER_OPERATORS.has(candidate.operator as StructuredFilterOperator)) return null;
    const operator = candidate.operator as StructuredFilterOperator;
    const missing = operator === "is_missing" || operator === "is_present";
    if (missing !== (candidate.value === undefined) || !missing &&
      (candidate.value === null || !["boolean", "number", "string"].includes(typeof candidate.value)) ||
      typeof candidate.value === "number" && !Number.isFinite(candidate.value) ||
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

export function decodeStructuredPlan(value: unknown): StructuredPlan | null {
  if (!record(value) || !PLAN_OPERATIONS.has(value.operation as StructuredPlan["operation"]) ||
    !withinPlanSize(value)) return null;
  const base = basePlan(value);
  if (!base) return null;
  if (value.operation === "list_rows") {
    if (!onlyKeys(value, ["filters", "includeHidden", "limit", "operation", "select", "sort", "target", "version"])) return null;
    const sort = parsedSort(value.sort);
    return sort ? Object.freeze({ ...base, operation: "list_rows", sort }) : null;
  }
  if (value.operation === "aggregate") {
    if (!onlyKeys(value, ["aggregate", "filters", "groupBy", "includeHidden", "limit", "operation", "select", "target", "valueColumn", "version"])) return null;
    const aggregate = value.aggregate;
    const groupBy = stringList(value.groupBy, 3);
    const valueColumn = value.valueColumn === null ? null : boundedText(value.valueColumn);
    if (!groupBy || base.select.length > 0 ||
      !["average", "count", "count_distinct", "max", "median", "min", "sum"].includes(String(aggregate)) ||
      aggregate === "count" && valueColumn !== null || aggregate !== "count" && !valueColumn) return null;
    return Object.freeze({ ...base, aggregate, groupBy, operation: "aggregate", valueColumn }) as StructuredAggregatePlan;
  }
  if (value.operation === "arithmetic") {
    if (!onlyKeys(value, ["filters", "includeHidden", "leftColumn", "limit", "operation", "operator", "resultLabel", "rightColumn", "select", "target", "version"])) return null;
    const leftColumn = boundedText(value.leftColumn);
    const rightColumn = boundedText(value.rightColumn);
    const resultLabel = boundedText(value.resultLabel);
    if (!leftColumn || !rightColumn || !resultLabel ||
      !["add", "divide", "multiply", "percent_change", "subtract"].includes(String(value.operator))) return null;
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
    return onlyKeys(value, ["filters", "includeHidden", "limit", "operation", "select", "target", "version"]) &&
      base.filters.length === 0 && base.select.length === 0
      ? Object.freeze({ ...base, operation: "formula_audit" })
      : null;
  }
  if (value.operation === "join") {
    if (!onlyKeys(value, ["filters", "includeHidden", "joinType", "leftKey", "limit", "operation", "rightKey", "rightSelect", "rightTarget", "select", "target", "version"])) return null;
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
    if (!onlyKeys(value, ["filters", "includeHidden", "limit", "method", "operation", "select", "target", "valueColumn", "version"])) return null;
    const valueColumn = boundedText(value.valueColumn);
    return value.method === "iqr" && valueColumn
      ? Object.freeze({ ...base, method: "iqr", operation: "outliers", valueColumn })
      : null;
  }
  if (!onlyKeys(value, ["aggregate", "dateColumn", "filters", "includeHidden", "limit", "operation", "select", "target", "valueColumn", "version"])) return null;
  const dateColumn = boundedText(value.dateColumn);
  const valueColumn = boundedText(value.valueColumn);
  if (!dateColumn || !valueColumn || base.select.length > 0 ||
    !["average", "count", "max", "median", "min", "sum"].includes(String(value.aggregate))) return null;
  return Object.freeze({
    ...base,
    aggregate: value.aggregate,
    dateColumn,
    operation: "trend",
    valueColumn
  }) as StructuredTrendPlan;
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function coordinate(row: number, column: number): string {
  return `${row}:${column}`;
}

function resolveTable(workbook: ParsedWorkbook, targetValue: StructuredTarget): ResolvedTable {
  const sheetMatches = workbook.sheets.filter((sheet) =>
    normalizedName(sheet.name) === normalizedName(targetValue.sheet));
  if (sheetMatches.length !== 1) fail("structured_target_unavailable");
  const sheet = sheetMatches[0]!;
  if (sheet.truncated) fail("structured_source_incomplete");
  const region = sheet.regions.find((candidate) => candidate.a1 === targetValue.range);
  if (!region) fail("structured_target_unavailable");
  const columnByLabel = new Map<string, number>();
  region.columnLabels.forEach((label, offset) => {
    columnByLabel.set(normalizedName(label), region.columnStart + offset);
  });
  return {
    cellByCoordinate: new Map(sheet.cells.map((cell) => [coordinate(cell.row, cell.column), cell])),
    columnByLabel,
    dataRowEnd: region.rowEnd,
    dataRowStart: region.headerRow === null ? region.rowStart : region.headerRow + 1,
    region,
    sheet
  };
}

function columnIndex(table: ResolvedTable, label: string, includeHidden: boolean): number {
  const index = table.columnByLabel.get(normalizedName(label));
  if (index === undefined) fail("structured_column_unavailable");
  if (!includeHidden && table.sheet.hiddenColumns.includes(index)) {
    fail("structured_hidden_data_requires_opt_in");
  }
  return index;
}

function assertVisibleTable(table: ResolvedTable, includeHidden: boolean): void {
  if (!includeHidden && table.sheet.hidden !== "visible") {
    fail("structured_hidden_data_requires_opt_in");
  }
}

function checkExecution(state: ExecutionState): void {
  if (state.signal?.aborted) fail("structured_execution_aborted");
  if (Date.now() > state.deadline) fail("structured_execution_timeout");
  if (state.rowsScanned > STRUCTURED_MAX_SCAN_ROWS) fail("structured_execution_limit_exceeded");
}

function rows(table: ResolvedTable, includeHidden: boolean, state: ExecutionState): readonly TableRow[] {
  const result: TableRow[] = [];
  const hiddenRows = new Set(table.sheet.hiddenRows);
  for (let row = table.dataRowStart; row <= table.dataRowEnd; row += 1) {
    state.rowsScanned += 1;
    checkExecution(state);
    if (!includeHidden && hiddenRows.has(row)) {
      state.hiddenRowsExcluded += 1;
      continue;
    }
    const values = new Map<number, ParsedWorkbookCell>();
    for (let column = table.region.columnStart; column <= table.region.columnEnd; column += 1) {
      const cell = table.cellByCoordinate.get(coordinate(row, column));
      if (cell) values.set(column, cell);
    }
    if (values.size > 0) result.push(Object.freeze({ row, values }));
  }
  return Object.freeze(result);
}

function scalar(cell: ParsedWorkbookCell | undefined, state: ExecutionState): StructuredScalar {
  if (!cell || cell.type === "blank") return null;
  if (cell.formula) state.formulaCellsUsed.add(cell.address);
  return cell.value;
}

function localeNumber(value: string): number | null {
  const text = value.trim().replace(/[\s\u00a0\u202f']/gu, "");
  if (!text || !/^[+-]?[\d.,]+$/u.test(text)) return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  let normalized = text;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    normalized = normalized.replaceAll(grouping, "").replace(decimal, ".");
  } else {
    const separator = comma >= 0 ? "," : dot >= 0 ? "." : null;
    if (separator) {
      const pieces = normalized.replace(/^[+-]/u, "").split(separator);
      if (pieces.length > 2 && pieces.slice(1).every((piece) => piece.length === 3)) {
        normalized = normalized.replaceAll(separator, "");
      } else if (pieces.length === 2 && pieces[1]!.length === 3) {
        return null;
      } else if (pieces.length === 2) {
        normalized = normalized.replace(separator, ".");
      } else return null;
    }
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function numeric(cell: ParsedWorkbookCell | undefined, state: ExecutionState): number | null {
  const value = scalar(cell, state);
  if (value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = localeNumber(value);
    if (parsed !== null) {
      state.warnings.add("locale_numeric_text_coerced");
      return parsed;
    }
  }
  fail("structured_mixed_type");
}

function comparable(value: StructuredScalar): Readonly<{ kind: string; value: boolean | number | string }> | null {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return { kind: typeof value, value };
  if (isSpreadsheetDateValue(value)) return { kind: "date", value };
  const number = localeNumber(value);
  return number === null
    ? { kind: "string", value: normalizedName(value) }
    : { kind: "number", value: number };
}

function compare(left: StructuredScalar, right: StructuredScalar): number | null {
  const leftValue = comparable(left);
  const rightValue = comparable(right);
  if (!leftValue || !rightValue || leftValue.kind !== rightValue.kind) return null;
  if (leftValue.value === rightValue.value) return 0;
  return leftValue.value < rightValue.value ? -1 : 1;
}

function matchesFilters(
  row: TableRow,
  table: ResolvedTable,
  planFilters: readonly StructuredFilter[],
  includeHidden: boolean,
  state: ExecutionState
): boolean {
  return planFilters.every((filter) => {
    const cell = row.values.get(columnIndex(table, filter.column, includeHidden));
    const value = scalar(cell, state);
    if (filter.operator === "is_missing") return value === null || value === "";
    if (filter.operator === "is_present") return value !== null && value !== "";
    if (filter.operator === "contains") {
      return typeof value === "string" && typeof filter.value === "string" &&
        normalizedName(value).includes(normalizedName(filter.value));
    }
    const order = compare(value, filter.value!);
    if (filter.operator === "eq") return order === 0;
    if (filter.operator === "ne") return order === null ? false : order !== 0;
    if (order === null) return false;
    if (filter.operator === "gt") return order > 0;
    if (filter.operator === "gte") return order >= 0;
    if (filter.operator === "lt") return order < 0;
    return order <= 0;
  });
}

function filteredRows(table: ResolvedTable, plan: StructuredPlanBase, state: ExecutionState): readonly TableRow[] {
  const result = rows(table, plan.includeHidden, state).filter((row) =>
    matchesFilters(row, table, plan.filters, plan.includeHidden, state));
  state.rowsMatched += result.length;
  return result;
}

function selectedColumns(table: ResolvedTable, select: readonly string[], includeHidden: boolean): Readonly<{
  indexes: readonly number[];
  labels: readonly string[];
}> {
  const labels = select.length > 0
    ? [...select]
    : table.region.columnLabels.filter((_label, offset) => includeHidden ||
      !table.sheet.hiddenColumns.includes(table.region.columnStart + offset)).slice(0, 32);
  return Object.freeze({
    indexes: Object.freeze(labels.map((label) => columnIndex(table, label, includeHidden))),
    labels: Object.freeze(labels)
  });
}

function rowValues(row: TableRow, indexes: readonly number[], state: ExecutionState): readonly StructuredScalar[] {
  return Object.freeze(indexes.map((index) => scalar(row.values.get(index), state)));
}

function aggregate(values: readonly number[], operation: StructuredAggregatePlan["aggregate"] | StructuredTrendPlan["aggregate"]): number {
  if (operation === "count") return values.length;
  if (values.length === 0) fail("structured_no_rows");
  const sorted = [...values].sort((left, right) => left - right);
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const corrected = value - correction;
    const next = total + corrected;
    correction = next - total - corrected;
    total = next;
  }
  if (operation === "sum") return total;
  if (operation === "average") return total / values.length;
  if (operation === "min") return sorted[0]!;
  if (operation === "max") return sorted.at(-1)!;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function stableScalarKey(value: StructuredScalar): string {
  return `${value === null ? "null" : typeof value}:${String(value)}`;
}

function executeList(
  table: ResolvedTable,
  plan: StructuredListRowsPlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  const selected = selectedColumns(table, plan.select, plan.includeHidden);
  const sort = plan.sort.map((entry) => ({
    direction: entry.direction,
    index: columnIndex(table, entry.column, plan.includeHidden)
  }));
  const selectedRows = [...filteredRows(table, plan, state)];
  selectedRows.sort((left, right) => {
    for (const entry of sort) {
      const leftValue = scalar(left.values.get(entry.index), state);
      const rightValue = scalar(right.values.get(entry.index), state);
      if (leftValue === null && rightValue !== null) return 1;
      if (leftValue !== null && rightValue === null) return -1;
      const order = compare(leftValue, rightValue);
      if (order !== null && order !== 0) return entry.direction === "asc" ? order : -order;
    }
    return left.row - right.row;
  });
  return {
    columns: selected.labels,
    rows: Object.freeze(selectedRows.slice(0, plan.limit).map((row) =>
      rowValues(row, selected.indexes, state))),
    summary: `Listed ${Math.min(selectedRows.length, plan.limit)} matching rows` +
      (sort.length > 0 ? ` sorted by ${plan.sort.map((entry) => entry.column).join(", ")}` : "")
  };
}

function executeAggregate(
  table: ResolvedTable,
  plan: StructuredAggregatePlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  const groupIndexes = plan.groupBy.map((label) => columnIndex(table, label, plan.includeHidden));
  const valueIndex = plan.valueColumn === null ? null : columnIndex(table, plan.valueColumn, plan.includeHidden);
  const groups = new Map<string, { labels: StructuredScalar[]; numbers: number[]; values: Set<string> }>();
  for (const row of filteredRows(table, plan, state)) {
    const labels = groupIndexes.map((index) => scalar(row.values.get(index), state));
    const key = labels.map(stableScalarKey).join("\u001f");
    const group = groups.get(key) ?? { labels, numbers: [], values: new Set<string>() };
    if (plan.aggregate === "count") group.numbers.push(1);
    else if (plan.aggregate === "count_distinct") {
      const value = scalar(row.values.get(valueIndex!), state);
      if (value !== null) group.values.add(stableScalarKey(value));
    } else {
      const value = numeric(row.values.get(valueIndex!), state);
      if (value !== null) group.numbers.push(value);
      else state.warnings.add("missing_values_excluded");
    }
    groups.set(key, group);
  }
  if (groups.size === 0) fail("structured_no_rows");
  const resultLabel = plan.aggregate === "count"
    ? "Count"
    : `${plan.aggregate.replace("_", " ")} ${plan.valueColumn}`;
  const output = [...groups.values()].map((group) => Object.freeze([
    ...group.labels,
    plan.aggregate === "count_distinct"
      ? group.values.size
      : aggregate(group.numbers, plan.aggregate)
  ] as StructuredScalar[])).sort((left, right) => {
    for (let index = 0; index < plan.groupBy.length; index += 1) {
      const order = compare(left[index]!, right[index]!);
      if (order !== null && order !== 0) return order;
    }
    return 0;
  }).slice(0, plan.limit);
  return {
    columns: Object.freeze([...plan.groupBy, resultLabel]),
    rows: Object.freeze(output),
    summary: `${resultLabel}${plan.groupBy.length > 0 ? ` grouped by ${plan.groupBy.join(", ")}` : ""}`
  };
}

function executeArithmetic(
  table: ResolvedTable,
  plan: StructuredArithmeticPlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  const selected = selectedColumns(table, plan.select, plan.includeHidden);
  const left = columnIndex(table, plan.leftColumn, plan.includeHidden);
  const right = columnIndex(table, plan.rightColumn, plan.includeHidden);
  let zeroDivisors = 0;
  const output = filteredRows(table, plan, state).slice(0, plan.limit).map((row) => {
    const leftValue = numeric(row.values.get(left), state);
    const rightValue = numeric(row.values.get(right), state);
    let result: number | null = null;
    if (leftValue !== null && rightValue !== null) {
      if ((plan.operator === "divide" || plan.operator === "percent_change") && rightValue === 0) {
        zeroDivisors += 1;
      } else if (plan.operator === "add") result = leftValue + rightValue;
      else if (plan.operator === "subtract") result = leftValue - rightValue;
      else if (plan.operator === "multiply") result = leftValue * rightValue;
      else if (plan.operator === "divide") result = leftValue / rightValue;
      else result = (leftValue - rightValue) / Math.abs(rightValue) * 100;
    }
    if (result !== null) result = canonicalArithmeticNumber(result);
    return Object.freeze([...rowValues(row, selected.indexes, state), result]);
  });
  if (zeroDivisors > 0) state.warnings.add(`division_by_zero:${zeroDivisors}`);
  if (output.length === 0) fail("structured_no_rows");
  return {
    columns: Object.freeze([...selected.labels, plan.resultLabel]),
    rows: Object.freeze(output),
    summary: `${plan.resultLabel}: ${plan.operator.replace("_", " ")} ${plan.leftColumn} and ${plan.rightColumn}`
  };
}

function executeFormulaAudit(
  table: ResolvedTable,
  plan: StructuredFormulaAuditPlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  assertVisibleTable(table, plan.includeHidden);
  const hiddenColumns = new Set(table.sheet.hiddenColumns);
  const output: StructuredScalar[][] = [];
  for (const row of rows(table, plan.includeHidden, state)) {
    for (const [column, cell] of row.values) {
      if (!cell.formula || !plan.includeHidden && hiddenColumns.has(column)) continue;
      output.push([
        cell.address,
        cell.formula,
        cell.value,
        cell.type === "error" ? "error" : cell.value === null ? "cached value missing" : "cached value present"
      ]);
      state.formulaCellsUsed.add(cell.address);
      if (output.length >= plan.limit) break;
    }
    if (output.length >= plan.limit) break;
  }
  state.rowsMatched += output.length;
  if (output.length === 0) fail("structured_no_rows");
  return {
    columns: Object.freeze(["Cell", "Formula", "Cached value", "Status"]),
    rows: Object.freeze(output.map((row) => Object.freeze(row))),
    summary: `Audited ${output.length} formula cells without evaluating formulas`
  };
}

function executeJoin(
  leftTable: ResolvedTable,
  rightTable: ResolvedTable,
  plan: StructuredJoinPlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  assertVisibleTable(rightTable, plan.includeHidden);
  const leftSelected = selectedColumns(leftTable, plan.select, plan.includeHidden);
  const rightSelected = selectedColumns(rightTable, plan.rightSelect, plan.includeHidden);
  const leftKey = columnIndex(leftTable, plan.leftKey, plan.includeHidden);
  const rightKey = columnIndex(rightTable, plan.rightKey, plan.includeHidden);
  const rightRows = rows(rightTable, plan.includeHidden, state);
  const rightByKey = new Map<string, TableRow[]>();
  for (const row of rightRows) {
    const key = scalar(row.values.get(rightKey), state);
    if (key === null) continue;
    const stable = stableScalarKey(key);
    const matches = rightByKey.get(stable) ?? [];
    matches.push(row);
    rightByKey.set(stable, matches);
  }
  const output: StructuredScalar[][] = [];
  for (const leftRow of filteredRows(leftTable, plan, state)) {
    const key = scalar(leftRow.values.get(leftKey), state);
    const matches = key === null ? [] : rightByKey.get(stableScalarKey(key)) ?? [];
    if (matches.length === 0 && plan.joinType === "left") {
      output.push([...rowValues(leftRow, leftSelected.indexes, state),
        ...rightSelected.indexes.map(() => null)]);
    } else {
      for (const rightRow of matches) {
        output.push([
          ...rowValues(leftRow, leftSelected.indexes, state),
          ...rowValues(rightRow, rightSelected.indexes, state)
        ]);
        if (output.length >= plan.limit) break;
      }
    }
    if (output.length >= plan.limit) break;
  }
  if (output.length === 0) fail("structured_no_rows");
  return {
    columns: Object.freeze([
      ...leftSelected.labels,
      ...rightSelected.labels.map((label) => `${rightTable.sheet.name}.${label}`)
    ]),
    rows: Object.freeze(output.slice(0, plan.limit).map((row) => Object.freeze(row))),
    summary: `${plan.joinType} join ${leftTable.sheet.name} to ${rightTable.sheet.name} by ${plan.leftKey} = ${plan.rightKey}`
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? sorted[lower]!
    : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function executeOutliers(
  table: ResolvedTable,
  plan: StructuredOutliersPlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  const selected = selectedColumns(table, plan.select, plan.includeHidden);
  const valueIndex = columnIndex(table, plan.valueColumn, plan.includeHidden);
  const candidates = filteredRows(table, plan, state).map((row) => ({
    row,
    value: numeric(row.values.get(valueIndex), state)
  })).filter((entry): entry is { row: TableRow; value: number } => entry.value !== null);
  if (candidates.length < 4) fail("structured_no_rows");
  const sorted = candidates.map((entry) => entry.value).sort((left, right) => left - right);
  const first = quantile(sorted, 0.25);
  const third = quantile(sorted, 0.75);
  const spread = third - first;
  const lower = first - spread * 1.5;
  const upper = third + spread * 1.5;
  const output = candidates.filter((entry) => entry.value < lower || entry.value > upper)
    .slice(0, plan.limit)
    .map((entry) => Object.freeze([
      ...rowValues(entry.row, selected.indexes, state),
      entry.value < lower ? "below" : "above"
    ] as StructuredScalar[]));
  if (output.length === 0) fail("structured_no_rows");
  return {
    columns: Object.freeze([...selected.labels, "Outlier direction"]),
    rows: Object.freeze(output),
    summary: `IQR outliers in ${plan.valueColumn}; bounds ${lower} to ${upper}`
  };
}

function executeTrend(
  table: ResolvedTable,
  plan: StructuredTrendPlan,
  state: ExecutionState
): Readonly<{ columns: readonly string[]; rows: readonly (readonly StructuredScalar[])[]; summary: string }> {
  const dateIndex = columnIndex(table, plan.dateColumn, plan.includeHidden);
  const valueIndex = columnIndex(table, plan.valueColumn, plan.includeHidden);
  const groups = new Map<string, number[]>();
  for (const row of filteredRows(table, plan, state)) {
    const date = scalar(row.values.get(dateIndex), state);
    if (typeof date !== "string" || !isSpreadsheetDateValue(date)) fail("structured_mixed_type");
    const value = plan.aggregate === "count" ? 1 : numeric(row.values.get(valueIndex), state);
    if (value === null) {
      state.warnings.add("missing_values_excluded");
      continue;
    }
    const values = groups.get(date) ?? [];
    values.push(value);
    groups.set(date, values);
  }
  const output = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .slice(0, plan.limit)
    .map(([date, values]) => Object.freeze([
      date,
      aggregate(values, plan.aggregate)
    ] as StructuredScalar[]));
  if (output.length === 0) fail("structured_no_rows");
  const first = output[0]?.[1];
  const last = output.at(-1)?.[1];
  const change = typeof first === "number" && typeof last === "number" ? last - first : null;
  return {
    columns: Object.freeze([plan.dateColumn, `${plan.aggregate} ${plan.valueColumn}`]),
    rows: Object.freeze(output),
    summary: `${plan.aggregate} ${plan.valueColumn} trend by ${plan.dateColumn}` +
      (change === null ? "" : `; first-to-last change ${change}`)
  };
}

function defaultSelectedLabels(
  workbook: ParsedWorkbook,
  targetValue: StructuredTarget,
  includeHidden: boolean
): readonly string[] {
  const table = resolveTable(workbook, targetValue);
  return table.region.columnLabels.filter((_label, offset) => includeHidden ||
    !table.sheet.hiddenColumns.includes(table.region.columnStart + offset)).slice(0, 32);
}

function referencedColumns(
  workbook: ParsedWorkbook,
  plan: StructuredPlan
): Array<Readonly<{ column: string; role: StructuredInputRange["role"]; target: StructuredTarget }>> {
  const defaultSelect = plan.select.length === 0 &&
    ["arithmetic", "join", "list_rows", "outliers"].includes(plan.operation)
    ? defaultSelectedLabels(workbook, plan.target, plan.includeHidden)
    : [];
  const columns: Array<Readonly<{ column: string; role: StructuredInputRange["role"]; target: StructuredTarget }>> = [
    ...(plan.select.length > 0 ? plan.select : defaultSelect)
      .map((column) => ({ column, role: "read" as const, target: plan.target })),
    ...plan.filters.map((filter) => ({ column: filter.column, role: "filter" as const, target: plan.target }))
  ];
  if (plan.operation === "list_rows") {
    columns.push(...plan.sort.map((sort) => ({ column: sort.column, role: "sort", target: plan.target } as const)));
  } else if (plan.operation === "aggregate") {
    columns.push(...plan.groupBy.map((column) => ({ column, role: "group", target: plan.target } as const)));
    if (plan.valueColumn) columns.push({ column: plan.valueColumn, role: "value", target: plan.target });
  } else if (plan.operation === "arithmetic") {
    columns.push({ column: plan.leftColumn, role: "value", target: plan.target });
    columns.push({ column: plan.rightColumn, role: "value", target: plan.target });
  } else if (plan.operation === "join") {
    columns.push({ column: plan.leftKey, role: "join", target: plan.target });
    columns.push({ column: plan.rightKey, role: "join", target: plan.rightTarget });
    const rightSelect = plan.rightSelect.length > 0
      ? plan.rightSelect
      : defaultSelectedLabels(workbook, plan.rightTarget, plan.includeHidden);
    columns.push(...rightSelect.map((column) => ({
      column,
      role: "read",
      target: plan.rightTarget
    } as const)));
  } else if (plan.operation === "outliers") {
    columns.push({ column: plan.valueColumn, role: "value", target: plan.target });
  } else if (plan.operation === "trend") {
    columns.push({ column: plan.dateColumn, role: "group", target: plan.target });
    columns.push({ column: plan.valueColumn, role: "value", target: plan.target });
  }
  return columns;
}

function inputRanges(workbook: ParsedWorkbook, plan: StructuredPlan): readonly StructuredInputRange[] {
  const entries = referencedColumns(workbook, plan);
  if (entries.length === 0) {
    const table = resolveTable(workbook, plan.target);
    return Object.freeze([{
      range: table.region.a1,
      role: "read",
      sheet: table.sheet.name,
      sheetIndex: table.sheet.index
    }]);
  }
  const unique = new Map<string, StructuredInputRange>();
  for (const entry of entries) {
    const table = resolveTable(workbook, entry.target);
    const column = columnIndex(table, entry.column, plan.includeHidden);
    const range = spreadsheetUtils.encode_range({
      e: { c: column, r: table.dataRowEnd },
      s: { c: column, r: table.dataRowStart }
    });
    const result: StructuredInputRange = {
      range,
      role: entry.role,
      sheet: table.sheet.name,
      sheetIndex: table.sheet.index
    };
    unique.set(`${result.sheetIndex}:${result.range}:${result.role}`, result);
  }
  return Object.freeze([...unique.values()]);
}

export function executeStructuredPlan(
  workbook: ParsedWorkbook,
  planValue: StructuredPlan,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
): StructuredAnalysisResult {
  const plan = decodeStructuredPlan(planValue);
  if (!plan) fail("structured_plan_invalid");
  if (workbook.warnings.includes("spreadsheet_cells_truncated") ||
    workbook.warnings.includes("spreadsheet_rows_truncated")) fail("structured_source_incomplete");
  const timeoutMs = Math.max(10, Math.min(2_000, Math.floor(options.timeoutMs ?? 500)));
  const state: ExecutionState = {
    deadline: Date.now() + timeoutMs,
    formulaCellsUsed: new Set<string>(),
    hiddenRowsExcluded: 0,
    rowsMatched: 0,
    rowsScanned: 0,
    ...(options.signal ? { signal: options.signal } : {}),
    warnings: new Set<string>()
  };
  const table = resolveTable(workbook, plan.target);
  assertVisibleTable(table, plan.includeHidden);
  let executed: Readonly<{
    columns: readonly string[];
    rows: readonly (readonly StructuredScalar[])[];
    summary: string;
  }>;
  if (plan.operation === "list_rows") executed = executeList(table, plan, state);
  else if (plan.operation === "aggregate") executed = executeAggregate(table, plan, state);
  else if (plan.operation === "arithmetic") executed = executeArithmetic(table, plan, state);
  else if (plan.operation === "formula_audit") executed = executeFormulaAudit(table, plan, state);
  else if (plan.operation === "join") {
    executed = executeJoin(table, resolveTable(workbook, plan.rightTarget), plan, state);
  } else if (plan.operation === "outliers") executed = executeOutliers(table, plan, state);
  else executed = executeTrend(table, plan, state);
  checkExecution(state);
  if (executed.rows.some((row) => row.some((value) =>
    typeof value === "number" && !Number.isFinite(value)))) {
    fail("structured_numeric_overflow");
  }
  const result: StructuredAnalysisResult = Object.freeze({
    columns: Object.freeze([...executed.columns]),
    receipt: Object.freeze({
      formulaCellsUsed: state.formulaCellsUsed.size,
      hiddenRowsExcluded: state.hiddenRowsExcluded,
      inputRanges: inputRanges(workbook, plan),
      operation: plan.operation,
      operationSummary: executed.summary,
      outputRows: executed.rows.length,
      plan,
      rowsMatched: state.rowsMatched,
      rowsScanned: state.rowsScanned,
      warnings: Object.freeze([...state.warnings].sort())
    }),
    rows: Object.freeze(executed.rows.map((row) => Object.freeze([...row])))
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > STRUCTURED_MAX_SERIALIZED_BYTES) {
    fail("structured_result_too_large");
  }
  return result;
}

export function decodeStructuredAnalysisResult(value: unknown): StructuredAnalysisResult | null {
  if (!record(value) || !onlyKeys(value, ["columns", "receipt", "rows"]) ||
    !Array.isArray(value.columns) || !Array.isArray(value.rows) || !record(value.receipt)) return null;
  const columns = value.columns;
  const rows = value.rows;
  const receipt = value.receipt;
  if (columns.length < 1 || columns.length > 64 ||
    columns.some((column) => !boundedText(column, 256)) ||
    rows.length > STRUCTURED_MAX_RESULT_ROWS ||
    rows.some((row) => !Array.isArray(row) || row.length !== columns.length ||
      row.some((cell) => cell !== null &&
        (typeof cell === "number" && !Number.isFinite(cell) ||
          !["boolean", "number", "string"].includes(typeof cell) ||
          typeof cell === "string" && (cell.length > 32_767 || /\u0000/u.test(cell))))) ||
    !onlyKeys(receipt, [
      "formulaCellsUsed",
      "hiddenRowsExcluded",
      "inputRanges",
      "operation",
      "operationSummary",
      "outputRows",
      "plan",
      "rowsMatched",
      "rowsScanned",
      "warnings"
    ])) return null;
  const plan = decodeStructuredPlan(receipt.plan);
  const integer = (candidate: unknown, maximum = STRUCTURED_MAX_SCAN_ROWS) =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= maximum;
  if (!plan || receipt.operation !== plan.operation ||
    !boundedText(receipt.operationSummary, 2_000) ||
    !integer(receipt.formulaCellsUsed) || !integer(receipt.hiddenRowsExcluded) ||
    !integer(receipt.rowsMatched) || !integer(receipt.rowsScanned) ||
    !integer(receipt.outputRows, STRUCTURED_MAX_RESULT_ROWS) ||
    receipt.outputRows !== rows.length ||
    !Array.isArray(receipt.inputRanges) || receipt.inputRanges.length < 1 ||
    receipt.inputRanges.length > 64 ||
    !Array.isArray(receipt.warnings) || receipt.warnings.length > 32 ||
    receipt.warnings.some((warning) => !boundedText(warning, 256)) ||
    new Set(receipt.warnings).size !== receipt.warnings.length ||
    receipt.inputRanges.some((candidate) => {
      if (!record(candidate) || !onlyKeys(candidate, ["range", "role", "sheet", "sheetIndex"]) ||
        !boundedText(candidate.range, 32) || !boundedText(candidate.sheet, 256) ||
        !["filter", "group", "join", "read", "sort", "value"].includes(String(candidate.role)) ||
        !Number.isSafeInteger(candidate.sheetIndex) || Number(candidate.sheetIndex) < 0 ||
        Number(candidate.sheetIndex) >= 64) return true;
      try {
        return spreadsheetUtils.encode_range(spreadsheetUtils.decode_range(candidate.range as string)) !==
          candidate.range;
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("structured_plan_invalid");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!record(value)) fail("structured_plan_invalid");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function verifyStructuredAnalysisResult(
  workbook: ParsedWorkbook,
  value: unknown
): boolean {
  try {
    const decoded = decodeStructuredAnalysisResult(value);
    if (!decoded || canonicalJson(value) !== canonicalJson(decoded)) return false;
    const recomputed = executeStructuredPlan(workbook, decoded.receipt.plan);
    return canonicalJson(decoded) === canonicalJson(recomputed);
  } catch {
    return false;
  }
}
