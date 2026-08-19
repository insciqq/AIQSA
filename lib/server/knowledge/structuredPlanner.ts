import type {
  ParsedWorkbook,
  ParsedWorkbookCell,
  ParsedWorkbookRegion,
  ParsedWorkbookSheet
} from "../parsing";
import {
  decodeStructuredPlan,
  STRUCTURED_MAX_RESULT_ROWS,
  STRUCTURED_PLAN_VERSION,
  type StructuredAggregatePlan,
  type StructuredArithmeticPlan,
  type StructuredFilter,
  type StructuredFormulaAuditPlan,
  type StructuredJoinPlan,
  type StructuredListRowsPlan,
  type StructuredOutliersPlan,
  type StructuredPlan,
  type StructuredTarget,
  type StructuredTrendPlan
} from "./structuredData";

export type StructuredPlanningResult =
  | Readonly<{
      plan: StructuredPlan;
      status: "ready";
    }>
  | Readonly<{
      code:
        | "structured_column_ambiguous"
        | "structured_hidden_target"
        | "structured_join_ambiguous"
        | "structured_target_ambiguous";
      question: string;
      status: "needs_clarification";
    }>
  | Readonly<{
      status: "not_applicable";
    }>;

type RegionCandidate = Readonly<{
  region: ParsedWorkbookRegion;
  sheet: ParsedWorkbookSheet;
}>;

type ColumnProfile = Readonly<{
  dateValues: number;
  label: string;
  nonEmptyValues: number;
  numericValues: number;
}>;

const STRUCTURED_QUERY_CUE = /(?:\bcsv\b|\bxls[x]?\b|\bods\b|\bspreadsheet\b|\btable\b|\bcolumn\b|\baggregate\b|\baverage\b|\bmedian\b|\bsum\b|\btrend\b|\boutliers?\b|\bjoin\b|\bsort\b|\bfilter\b|\bcalculate\b|\bdifference\b|\bratio\b|\btop\b|\bbottom\b|\bformula(?:s)?\b|таблиц|столбц|средн|медиан|сумм|агрегир|тренд|динамик|выброс|аномал|сортир|фильтр|посчитай|рассчитай|разниц|отношени|формул|сопостав|объедин)/iu;
const INCLUDE_HIDDEN_CUE = /(?:include|including|with|show|use)\s+(?:the\s+)?hidden|включ(?:ая|и)\s+скрыт|со\s+скрыт|учитыва[йт]*\s+скрыт/iu;
const FORMULA_CUE = /(?:\bformula(?:s)?\b|\bcalculation cells?\b|формул|расч[её]тн\w* яче)/iu;
const JOIN_CUE = /(?:\bjoin\b|\bmerge\b|\bmatch\b|\blookup\b|сопостав|объедин|соедин|свяж)/iu;
const OUTLIER_CUE = /(?:\boutliers?\b|\banomal(?:y|ies)\b|выброс|аномал)/iu;
const TREND_CUE = /(?:\btrend\b|\bover time\b|\btime series\b|динамик|тренд|по дат|во времени)/iu;

export function isStructuredDataQuery(query: string): boolean {
  return STRUCTURED_QUERY_CUE.test(query);
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function mentions(query: string, value: string): boolean {
  const label = normalized(value);
  if (!label) return false;
  const expression = label.split(/\s+/u).map(escapeRegex).join("\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${expression}(?:$|[^\\p{L}\\p{N}])`, "iu")
    .test(normalized(query));
}

function cellMap(sheet: ParsedWorkbookSheet): ReadonlyMap<string, ParsedWorkbookCell> {
  return new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
}

function likelyNumericText(value: string): boolean {
  const compact = value.trim().replace(/[\s\u00a0\u202f']/gu, "");
  return /^[+-]?(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?)$/u.test(compact);
}

function profiles(candidate: RegionCandidate): readonly ColumnProfile[] {
  const cells = cellMap(candidate.sheet);
  const start = candidate.region.headerRow === null
    ? candidate.region.rowStart
    : candidate.region.headerRow + 1;
  return Object.freeze(candidate.region.columnLabels.map((label, offset) => {
    const column = candidate.region.columnStart + offset;
    let dateValues = 0;
    let nonEmptyValues = 0;
    let numericValues = 0;
    for (let row = start; row <= candidate.region.rowEnd; row += 1) {
      const cell = cells.get(`${row}:${column}`);
      if (!cell || cell.value === null || cell.value === "") continue;
      nonEmptyValues += 1;
      if (cell.type === "date") dateValues += 1;
      if (cell.type === "number" || typeof cell.value === "string" && likelyNumericText(cell.value)) {
        numericValues += 1;
      }
    }
    return Object.freeze({ dateValues, label, nonEmptyValues, numericValues });
  }));
}

function target(candidate: RegionCandidate): StructuredTarget {
  return Object.freeze({ range: candidate.region.a1, sheet: candidate.sheet.name });
}

function candidates(workbook: ParsedWorkbook, includeHidden: boolean): readonly RegionCandidate[] {
  return Object.freeze(workbook.sheets.flatMap((sheet) => {
    if (!includeHidden && sheet.hidden !== "visible") return [];
    return sheet.regions.map((region) => Object.freeze({ region, sheet }));
  }));
}

function scoreCandidate(query: string, candidate: RegionCandidate): number {
  const sheetScore = mentions(query, candidate.sheet.name) ? 100 : 0;
  const columnScore = candidate.region.columnLabels.reduce((score, label) =>
    score + (mentions(query, label) ? 10 : 0), 0);
  return sheetScore + columnScore;
}

function pickCandidate(
  query: string,
  workbook: ParsedWorkbook,
  includeHidden: boolean
): StructuredPlanningResult | RegionCandidate {
  const available = candidates(workbook, includeHidden);
  if (available.length === 0 && workbook.sheets.some((sheet) => sheet.hidden !== "visible")) {
    return {
      code: "structured_hidden_target",
      question: "Уточните, нужно ли явно включить скрытые листы и строки.",
      status: "needs_clarification"
    };
  }
  const scored = available.map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }));
  const maximum = Math.max(0, ...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === maximum);
  if (maximum === 0 && available.length === 1) return available[0]!;
  if (maximum > 0 && best.length === 1) return best[0]!.candidate;
  return {
    code: "structured_target_ambiguous",
    question: `Уточните лист или таблицу: доступны ${available.slice(0, 8)
      .map((entry) => `${entry.sheet.name}!${entry.region.a1}`).join(", ")}.`,
    status: "needs_clarification"
  };
}

function mentionedProfiles(query: string, values: readonly ColumnProfile[]): readonly ColumnProfile[] {
  return values.filter((profile) => mentions(query, profile.label));
}

function numericProfiles(values: readonly ColumnProfile[]): readonly ColumnProfile[] {
  return values.filter((profile) => profile.numericValues > 0 &&
    profile.numericValues === profile.nonEmptyValues);
}

function dateProfiles(values: readonly ColumnProfile[]): readonly ColumnProfile[] {
  return values.filter((profile) => profile.dateValues > 0 && profile.dateValues === profile.nonEmptyValues);
}

function oneColumn(
  query: string,
  values: readonly ColumnProfile[],
  kind: "date" | "numeric"
): ColumnProfile | null {
  const eligible = kind === "date" ? dateProfiles(values) : numericProfiles(values);
  const mentioned = mentionedProfiles(query, eligible);
  if (mentioned.length === 1) return mentioned[0]!;
  return mentioned.length === 0 && eligible.length === 1 ? eligible[0]! : null;
}

function rowLabelNames(candidate: RegionCandidate): readonly string[] {
  return candidate.region.rowLabelColumns.map((column) =>
    candidate.region.columnLabels[column - candidate.region.columnStart]!).filter(Boolean);
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function limitFromQuery(query: string): number {
  const match = /(?:\btop\b|\bbottom\b|\bfirst\b|\blast\b|\blimit\b|топ|первые?|последние?)\s*[-:]?\s*(\d{1,3})/iu.exec(query);
  const value = match ? Number(match[1]) : 50;
  return Math.max(1, Math.min(STRUCTURED_MAX_RESULT_ROWS, value));
}

function filterValue(value: string): string | number | boolean {
  const unquoted = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2").trim();
  if (/^(?:true|да)$/iu.test(unquoted)) return true;
  if (/^(?:false|нет)$/iu.test(unquoted)) return false;
  const compact = unquoted.replace(/[\s\u00a0\u202f]/gu, "");
  if (/^[+-]?\d+(?:[.,]\d{1,6})?$/u.test(compact)) {
    const number = Number(compact.replace(",", "."));
    if (Number.isFinite(number)) return number;
  }
  return unquoted.slice(0, 1_000);
}

function filtersFromQuery(query: string, values: readonly ColumnProfile[]): readonly StructuredFilter[] {
  const result: StructuredFilter[] = [];
  for (const profile of values) {
    const label = profile.label.split(/\s+/u).map(escapeRegex).join("\\s+");
    const symbolic = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${label}\\s*(>=|<=|!=|=|>|<)\\s*("[^"\\n]{1,1000}"|'[^'\\n]{1,1000}'|[\\p{L}\\p{N}.,+\\-:/]{1,1000})`,
      "iu"
    ).exec(query);
    if (symbolic) {
      const operator = ({
        "!=": "ne",
        "<": "lt",
        "<=": "lte",
        "=": "eq",
        ">": "gt",
        ">=": "gte"
      } as const)[symbolic[1] as "!=" | "<" | "<=" | "=" | ">" | ">="];
      result.push(Object.freeze({
        column: profile.label,
        operator,
        value: filterValue(symbolic[2]!)
      }));
      continue;
    }
    const missing = new RegExp(
      `${label}\\s+(?:is\\s+)?(?:missing|blank|empty)|(?:пуст|пропущ)[\\p{L}]*\\s+(?:в\\s+)?${label}`,
      "iu"
    );
    if (missing.test(query)) {
      result.push(Object.freeze({ column: profile.label, operator: "is_missing" }));
      continue;
    }
    const contains = new RegExp(
      `${label}\\s+(?:contains?|содержит)\\s+("[^"\\n]{1,1000}"|'[^'\\n]{1,1000}'|[\\p{L}\\p{N}._-]{1,1000})`,
      "iu"
    ).exec(query);
    if (contains) {
      result.push(Object.freeze({
        column: profile.label,
        operator: "contains",
        value: filterValue(contains[1]!)
      }));
    }
  }
  return Object.freeze(result.slice(0, 8));
}

function basePlan(query: string, candidate: RegionCandidate, includeHidden: boolean): Readonly<{
  filters: readonly StructuredFilter[];
  includeHidden: boolean;
  limit: number;
  target: StructuredTarget;
  version: typeof STRUCTURED_PLAN_VERSION;
}> {
  return Object.freeze({
    filters: filtersFromQuery(query, profiles(candidate)),
    includeHidden,
    limit: limitFromQuery(query),
    target: target(candidate),
    version: STRUCTURED_PLAN_VERSION
  });
}

function clarification(question: string): StructuredPlanningResult {
  return { code: "structured_column_ambiguous", question, status: "needs_clarification" };
}

function aggregation(query: string): StructuredAggregatePlan["aggregate"] | null {
  if (/(?:\bcount distinct\b|\bdistinct count\b|числ\w* уник|количеств\w* уник)/iu.test(query)) return "count_distinct";
  if (/(?:\baverage\b|\bmean\b|средн)/iu.test(query)) return "average";
  if (/(?:\bmedian\b|медиан)/iu.test(query)) return "median";
  if (/(?:\bminimum\b|\bmin\b|миним)/iu.test(query)) return "min";
  if (/(?:\bmaximum\b|\bmax\b|максим)/iu.test(query)) return "max";
  if (/(?:\bsum\b|\btotal\b|сумм|итого)/iu.test(query)) return "sum";
  if (/(?:\bcount\b|\bhow many\b|количеств|сколько)/iu.test(query)) return "count";
  return null;
}

function groupColumns(query: string, values: readonly ColumnProfile[], valueLabel: string | null): readonly string[] {
  const mentioned = mentionedProfiles(query, values).filter((profile) => profile.label !== valueLabel);
  const explicit = mentioned.filter((profile) => {
    const label = profile.label.split(/\s+/u).map(escapeRegex).join("\\s+");
    return new RegExp(`(?:group(?:ed)?\\s+by|by|по|для каждого)\\s+${label}(?:$|[^\\p{L}\\p{N}])`, "iu")
      .test(query);
  });
  if (explicit.length > 0) return unique(explicit.map((profile) => profile.label)).slice(0, 3);
  return unique(mentioned.filter((profile) => profile.numericValues === 0)
    .map((profile) => profile.label)).slice(0, 3);
}

function planAggregate(
  query: string,
  candidate: RegionCandidate,
  includeHidden: boolean,
  operation: StructuredAggregatePlan["aggregate"]
): StructuredPlanningResult {
  const values = profiles(candidate);
  const value = operation === "count" ? null : oneColumn(query, values, "numeric");
  if (operation !== "count" && !value) {
    return clarification("Уточните одну числовую колонку для расчёта.");
  }
  const plan: StructuredAggregatePlan = {
    ...basePlan(query, candidate, includeHidden),
    aggregate: operation,
    groupBy: groupColumns(query, values, value?.label ?? null),
    operation: "aggregate",
    select: [],
    valueColumn: value?.label ?? null
  };
  return ready(plan);
}

function arithmeticOperator(query: string): StructuredArithmeticPlan["operator"] | null {
  if (/(?:percent(?:age)? change|growth rate|процентн\w* измен|темп рост)/iu.test(query)) return "percent_change";
  if (/(?:\bratio\b|divide|дели|отношени)/iu.test(query)) return "divide";
  if (/(?:multiply|product|умнож|произведени)/iu.test(query)) return "multiply";
  if (/(?:difference|minus|subtract|разниц|вычти)/iu.test(query)) return "subtract";
  if (/(?:\badd\b|\bplus\b|сложи|сумм\w* колон)/iu.test(query)) return "add";
  return null;
}

function planArithmetic(
  query: string,
  candidate: RegionCandidate,
  includeHidden: boolean,
  operator: StructuredArithmeticPlan["operator"]
): StructuredPlanningResult {
  const values = profiles(candidate);
  const numeric = mentionedProfiles(query, numericProfiles(values));
  if (numeric.length !== 2) return clarification("Уточните ровно две числовые колонки для арифметики.");
  const [left, right] = numeric;
  const label = `${operator.replace("_", " ")} ${left!.label} / ${right!.label}`;
  const plan: StructuredArithmeticPlan = {
    ...basePlan(query, candidate, includeHidden),
    leftColumn: left!.label,
    operation: "arithmetic",
    operator,
    resultLabel: label,
    rightColumn: right!.label,
    select: unique([...rowLabelNames(candidate), left!.label, right!.label]).slice(0, 8)
  };
  return ready(plan);
}

function planTrend(query: string, candidate: RegionCandidate, includeHidden: boolean): StructuredPlanningResult {
  const values = profiles(candidate);
  const date = oneColumn(query, values, "date");
  const value = oneColumn(query, values.filter((profile) => profile !== date), "numeric");
  if (!date || !value) return clarification("Уточните одну колонку даты и одну числовую колонку для тренда.");
  const requestedAggregate = aggregation(query);
  if (requestedAggregate === "count_distinct") {
    return clarification("Для тренда выберите sum, average, median, min, max или count.");
  }
  const plan: StructuredTrendPlan = {
    ...basePlan(query, candidate, includeHidden),
    aggregate: requestedAggregate ?? "sum",
    dateColumn: date.label,
    operation: "trend",
    select: [],
    valueColumn: value.label
  };
  return ready(plan);
}

function planOutliers(query: string, candidate: RegionCandidate, includeHidden: boolean): StructuredPlanningResult {
  const value = oneColumn(query, profiles(candidate), "numeric");
  if (!value) return clarification("Уточните одну числовую колонку для поиска выбросов.");
  const plan: StructuredOutliersPlan = {
    ...basePlan(query, candidate, includeHidden),
    method: "iqr",
    operation: "outliers",
    select: unique([...rowLabelNames(candidate), value.label]).slice(0, 8),
    valueColumn: value.label
  };
  return ready(plan);
}

function joinCandidates(query: string, workbook: ParsedWorkbook, includeHidden: boolean): readonly RegionCandidate[] {
  const available = candidates(workbook, includeHidden);
  const sheets = workbook.sheets.filter((sheet) => mentions(query, sheet.name));
  if (sheets.length === 2) {
    return sheets.map((sheet) => available.filter((candidate) => candidate.sheet.index === sheet.index)
      .sort((left, right) => scoreCandidate(query, right) - scoreCandidate(query, left))[0])
      .filter((candidate): candidate is RegionCandidate => Boolean(candidate));
  }
  if (workbook.sheets.length === 2 && available.length === 2) return available;
  return [];
}

function planJoin(query: string, workbook: ParsedWorkbook, includeHidden: boolean): StructuredPlanningResult {
  const selected = joinCandidates(query, workbook, includeHidden);
  if (selected.length !== 2) {
    return {
      code: "structured_join_ambiguous",
      question: "Уточните два листа и общую ключевую колонку для соединения.",
      status: "needs_clarification"
    };
  }
  const [left, right] = selected as readonly [RegionCandidate, RegionCandidate];
  const leftProfiles = profiles(left);
  const rightProfiles = profiles(right);
  const rightByName = new Map(rightProfiles.map((profile) => [normalized(profile.label), profile]));
  const common = leftProfiles.flatMap((profile) => {
    const counterpart = rightByName.get(normalized(profile.label));
    return counterpart ? [{ left: profile, right: counterpart }] : [];
  });
  const mentioned = common.filter((entry) => mentions(query, entry.left.label));
  const keys = mentioned.length > 0 ? mentioned : common;
  if (keys.length !== 1) {
    return {
      code: "structured_join_ambiguous",
      question: `Уточните общую ключевую колонку${common.length > 0
        ? `: ${common.map((entry) => entry.left.label).join(", ")}` : ""}.`,
      status: "needs_clarification"
    };
  }
  const key = keys[0]!;
  const leftMentioned = mentionedProfiles(query, leftProfiles).map((profile) => profile.label);
  const rightMentioned = mentionedProfiles(query, rightProfiles).map((profile) => profile.label);
  const requestedRight = rightMentioned.filter((label) => label !== key.right.label);
  const plan: StructuredJoinPlan = {
    ...basePlan(query, left, includeHidden),
    joinType: /(?:\bleft join\b|лев\w* соедин)/iu.test(query) ? "left" : "inner",
    leftKey: key.left.label,
    operation: "join",
    rightKey: key.right.label,
    rightSelect: unique((requestedRight.length > 0
      ? requestedRight
      : rightProfiles.map((profile) => profile.label).filter((label) => label !== key.right.label)))
      .slice(0, 8),
    rightTarget: target(right),
    select: unique([
      ...rowLabelNames(left),
      ...leftMentioned,
      key.left.label
    ]).slice(0, 8)
  };
  return ready(plan);
}

function planList(query: string, candidate: RegionCandidate, includeHidden: boolean): StructuredPlanningResult {
  const values = profiles(candidate);
  const mentioned = mentionedProfiles(query, values).map((profile) => profile.label);
  const selected = unique(mentioned.length > 0
    ? [...rowLabelNames(candidate), ...mentioned]
    : values.map((profile) => profile.label).slice(0, 8));
  const descending = /(?:\btop\b|\bdesc(?:ending)?\b|highest|largest|топ|убыван|наибольш)/iu.test(query);
  const ascending = /(?:\bbottom\b|\basc(?:ending)?\b|lowest|smallest|возрастан|наименьш)/iu.test(query);
  const sortCandidates = mentionedProfiles(query, numericProfiles(values));
  const sort = (descending || ascending) && sortCandidates.length === 1
    ? [{ column: sortCandidates[0]!.label, direction: descending ? "desc" as const : "asc" as const }]
    : [];
  const plan: StructuredListRowsPlan = {
    ...basePlan(query, candidate, includeHidden),
    operation: "list_rows",
    select: selected.slice(0, 32),
    sort
  };
  return ready(plan);
}

function ready(plan: StructuredPlan): StructuredPlanningResult {
  const decoded = decodeStructuredPlan(plan);
  if (!decoded) throw new Error("structured_planner_produced_invalid_plan");
  return Object.freeze({ plan: decoded, status: "ready" });
}

export function planStructuredDataQuery(queryValue: string, workbook: ParsedWorkbook): StructuredPlanningResult {
  const query = queryValue.trim().slice(0, 4_000);
  if (!query || !isStructuredDataQuery(query)) return Object.freeze({ status: "not_applicable" });
  const includeHidden = INCLUDE_HIDDEN_CUE.test(query);
  if (JOIN_CUE.test(query)) return planJoin(query, workbook, includeHidden);
  const selected = pickCandidate(query, workbook, includeHidden);
  if ("status" in selected) return selected;
  if (FORMULA_CUE.test(query)) {
    const plan: StructuredFormulaAuditPlan = {
      ...basePlan(query, selected, includeHidden),
      filters: [],
      operation: "formula_audit",
      select: []
    };
    return ready(plan);
  }
  if (OUTLIER_CUE.test(query)) return planOutliers(query, selected, includeHidden);
  if (TREND_CUE.test(query)) return planTrend(query, selected, includeHidden);
  const math = arithmeticOperator(query);
  if (math) return planArithmetic(query, selected, includeHidden, math);
  const aggregate = aggregation(query);
  if (aggregate) return planAggregate(query, selected, includeHidden, aggregate);
  return planList(query, selected, includeHidden);
}
