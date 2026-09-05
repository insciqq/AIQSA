import { createHash } from "node:crypto";

export const KNOWLEDGE_DOCUMENT_CONTEXT_VERSION = 1 as const;
export const KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS = 4_096;
export const KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS = 1_024;
export const KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS = 8;
export const KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES = 32 * 1_024;
export type KnowledgeObservationNormalizationVersion = 1 | 2;
const exactDecimalLimit = 4_096;

export type KnowledgeObservationRole =
  | "header"
  | "metadata"
  | "observation"
  | "reference"
  | "target"
  | "threshold";

export type KnowledgeObservationValueKind =
  | "date"
  | "number"
  | "number_range"
  | "text";

export type KnowledgeDocumentAmbiguityReason =
  | "ambiguous_date"
  | "ambiguous_number"
  | "ambiguous_role"
  | "competing_pair"
  | "conflicting_edge"
  | "missing_header"
  | "missing_pair"
  | "unspecified_role";

export type KnowledgeDocumentObservationOriginV1 =
  | Readonly<{
      columnEnd: number;
      columnStart: number;
      kind: "table_cell";
    }>
  | Readonly<{
      cellId: number;
      kind: "field_cell";
    }>;

export type KnowledgeDocumentObservationV1 = Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  confidence: number | null;
  date: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  metric: string | null;
  normalizedValue: string | null;
  origin: KnowledgeDocumentObservationOriginV1;
  rawValue: string;
  role: KnowledgeObservationRole;
  subject: string | null;
  unit: string | null;
  valueKind: KnowledgeObservationValueKind;
}>;

export type KnowledgeTableHeaderLineageV1 = Readonly<{
  columnEnd: number;
  columnStart: number;
  rowIndex: number;
  text: string;
}>;

export type KnowledgeDocumentLocatorV1 =
  | Readonly<{
      blockId: string;
      headerLineage: readonly KnowledgeTableHeaderLineageV1[];
      kind: "table_row";
      rowId: string;
      rowIndex: number;
      rowKind: "data" | "header";
    }>
  | Readonly<{
      blockId: string;
      columnEnd: number;
      columnStart: number;
      headerLineage: readonly KnowledgeTableHeaderLineageV1[];
      kind: "table_row_projection";
      projectionCount: number;
      projectionIndex: number;
      rowId: string;
      rowIndex: number;
      rowKind: "data" | "header";
    }>
  | Readonly<{
      fieldGroupId: string;
      kind: "field_pair";
      labelCellId: number;
      valueCellId: number;
    }>
  | Readonly<{
      candidateCellIds: readonly number[];
      cellId: number;
      fieldGroupId: string;
      kind: "field_ambiguous";
    }>;

export type KnowledgeTableRowProjectionLocatorV1 = Extract<
  KnowledgeDocumentLocatorV1,
  Readonly<{ kind: "table_row_projection" }>
>;

export type KnowledgeDocumentContextV1 = Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  locator: KnowledgeDocumentLocatorV1;
  observations: readonly KnowledgeDocumentObservationV1[];
  version: typeof KNOWLEDGE_DOCUMENT_CONTEXT_VERSION;
}>;

export type KnowledgeTableContextCell = Readonly<{
  columnEnd: number;
  columnStart: number;
  text: string;
}>;

export function isCompleteKnowledgeTableRowProjectionSequence(
  locators: readonly KnowledgeTableRowProjectionLocatorV1[]
): boolean {
  const projectionCount = locators[0]?.projectionCount;
  if (!Number.isSafeInteger(projectionCount) || projectionCount === undefined ||
    projectionCount < 1 || projectionCount > KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS ||
    projectionCount !== locators.length) {
    return false;
  }
  for (const [projectionIndex, locator] of locators.entries()) {
    if (locator.projectionCount !== projectionCount ||
      locator.projectionIndex !== projectionIndex ||
      !Number.isSafeInteger(locator.columnStart) || locator.columnStart < 0 ||
      !Number.isSafeInteger(locator.columnEnd) || locator.columnEnd < locator.columnStart) {
      return false;
    }
    if (projectionIndex === 0) {
      if (locator.columnStart !== 0) return false;
      continue;
    }
    const previous = locators[projectionIndex - 1]!;
    const nextColumnRange = locator.columnStart === previous.columnEnd + 1;
    const sameCellFragment = locator.columnStart === previous.columnStart &&
      locator.columnEnd === previous.columnEnd;
    if (!nextColumnRange && !sameCellFragment) return false;
  }
  return true;
}

type FieldCell = Readonly<{
  confidence: number | null;
  id: number;
  label: "checkbox" | "key" | "unspecified" | "value";
  order: number;
  text: string;
}>;

type FieldLink = Readonly<{
  confidence: number | null;
  label: "to_child" | "to_key" | "to_parent" | "to_value" | "unspecified";
  sourceCellId: number;
  targetCellId: number;
}>;

export type KnowledgeFieldGroupContextInput = Readonly<{
  cells: readonly FieldCell[];
  confidence: number | null;
  id: string;
  links: readonly FieldLink[];
}>;

export type KnowledgeFieldContextSegment = Readonly<{
  cellIds: readonly number[];
  context: KnowledgeDocumentContextV1;
  text: string;
}>;

type Descriptor = Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  kind: "date" | "effective_from" | "effective_to" | "metric" | "subject" | "unit" | "value";
  metric: string | null;
  role: KnowledgeObservationRole;
  unit: string | null;
}>;

type NormalizedObservationValue = Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  date: string | null;
  kind: KnowledgeObservationValueKind;
  normalizedValue: string | null;
  rawValue: string;
  unit: string | null;
}>;

export type KnowledgeTableHeaderPeriodV1 = Readonly<{
  effectiveFrom: string;
  effectiveTo: string;
}>;

const ambiguityReasons = new Set<KnowledgeDocumentAmbiguityReason>([
  "ambiguous_date",
  "ambiguous_number",
  "ambiguous_role",
  "competing_pair",
  "conflicting_edge",
  "missing_header",
  "missing_pair",
  "unspecified_role"
]);

const associationAmbiguityReasons = new Set<KnowledgeDocumentAmbiguityReason>([
  "ambiguous_role",
  "competing_pair",
  "conflicting_edge",
  "missing_header",
  "missing_pair",
  "unspecified_role"
]);

/**
 * Reports only uncertainty about which label/header/row belongs to which
 * value. Lexical normalization uncertainty (for example an alphanumeric
 * identifier that is not safely normalizable as a number) does not invalidate
 * the exact raw cell or its otherwise explicit row/column association.
 */
export function knowledgeDocumentContextHasAssociationAmbiguity(
  context: KnowledgeDocumentContextV1 | null | undefined
): boolean {
  return Boolean(context && (
    context.locator.kind === "field_ambiguous" ||
    context.ambiguityReasons.some((reason) => associationAmbiguityReasons.has(reason))
  ));
}
const observationRoles = new Set<KnowledgeObservationRole>([
  "header",
  "metadata",
  "observation",
  "reference",
  "target",
  "threshold"
]);
const observationKinds = new Set<KnowledgeObservationValueKind>([
  "date",
  "number",
  "number_range",
  "text"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000]/u.test(value);
}

function boundedNullableString(value: unknown, maximum = 1_024): value is string | null {
  return value === null || boundedString(value, maximum);
}

function normalizedDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return Boolean(match && validDate(Number(match[1]), Number(match[2]), Number(match[3])) === value);
}

function index(value: unknown, maximum = 1_000_000): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function confidence(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function canonicalText(value: string, maximum = 1_024): string {
  return value.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function sortedReasons(
  values: readonly KnowledgeDocumentAmbiguityReason[]
): readonly KnowledgeDocumentAmbiguityReason[] {
  return Object.freeze([...new Set(values)].sort());
}

function validDate(year: number, month: number, day: number): string | null {
  if (!Number.isSafeInteger(year) || year < 1_000 || year > 9_999 ||
    !Number.isSafeInteger(month) || month < 1 || month > 12 ||
    !Number.isSafeInteger(day) || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : null;
}

function canonicalDate(value: string): Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  value: string | null;
}> | null {
  const iso = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/u.exec(value);
  if (iso) {
    const normalized = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return { ambiguityReasons: normalized ? [] : ["ambiguous_date"], value: normalized };
  }
  const dmy = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/u.exec(value);
  if (!dmy) return null;
  const first = Number(dmy[1]);
  const second = Number(dmy[3]);
  if (dmy[2] !== "." && first <= 12 && second <= 12) {
    return { ambiguityReasons: ["ambiguous_date"], value: null };
  }
  const normalized = validDate(Number(dmy[4]), second, first);
  return { ambiguityReasons: normalized ? [] : ["ambiguous_date"], value: normalized };
}

function canonicalDecimal(value: string): Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  value: string | null;
}> | null {
  const compact = value.replace(/[\u00a0\u202f ]/gu, "");
  const match = /^([+-]?)(\d+)(?:([.,])(\d+))?(%)?$/u.exec(compact);
  if (!match) return null;
  const integerPart = match[2]!;
  const fractionalPart = match[4] ?? "";
  if (match[3] && fractionalPart.length === 3 && integerPart !== "0") {
    return { ambiguityReasons: ["ambiguous_number"], value: null };
  }
  const integer = integerPart.replace(/^0+(?=\d)/u, "");
  const fractional = fractionalPart.replace(/0+$/u, "");
  const zero = /^0+$/u.test(integer) && !fractional;
  const sign = match[1] === "-" && !zero ? "-" : match[1] === "+" ? "+" : "";
  return {
    ambiguityReasons: [],
    value: `${sign}${integer}${fractional ? `.${fractional}` : ""}${match[5] ?? ""}`
  };
}

function canonicalScientificDecimalLegacyV1(value: string): Readonly<{
  ambiguityReasons: readonly KnowledgeDocumentAmbiguityReason[];
  value: string | null;
}> | null {
  const match = /^(.+?)([eE]([+-]?\d+))?(%)?$/u.exec(value);
  if (!match) return null;
  const ordinary = canonicalDecimal(`${match[1]}${match[4] ?? ""}`);
  if (!match[2]) return ordinary;
  const mantissa = canonicalDecimal(match[1]!);
  const exponent = Number(match[3]);
  const numeric = mantissa?.value === null || mantissa === null
    ? Number.NaN
    : Number(mantissa.value) * (10 ** exponent);
  if (!mantissa || mantissa.ambiguityReasons.length > 0 ||
    !Number.isSafeInteger(exponent) || Math.abs(exponent) > 308 || !Number.isFinite(numeric)) {
    return { ambiguityReasons: ["ambiguous_number"], value: null };
  }
  return {
    ambiguityReasons: [],
    value: `${Object.is(numeric, -0) ? 0 : numeric}${match[4] ?? ""}`
  };
}

/** Shift an exact decimal string. Only the bounded exponent/offset is an
 * integer Number; no observed value or mantissa passes through binary float. */
function canonicalScientificDecimalV2(value: string): ReturnType<typeof canonicalDecimal> {
  const ambiguous = () => ({ ambiguityReasons: ["ambiguous_number" as const], value: null });
  if (value.length > exactDecimalLimit) return ambiguous();
  const match = /^(.+?)([eE]([+-]?\d+))?(%)?$/u.exec(value);
  if (!match) return null;
  if (!match[2]) return canonicalDecimal(value);
  const mantissa = canonicalDecimal(match[1]!);
  if (!mantissa || mantissa.value === null || mantissa.ambiguityReasons.length) return ambiguous();
  const exponentDigits = match[3]!.replace(/^[+-]/u, "").replace(/^0+/u, "") || "0";
  if (exponentDigits.length > 4) return ambiguous();
  const exponent = Number(exponentDigits) * (match[3]!.startsWith("-") ? -1 : 1);
  if (Math.abs(exponent) > exactDecimalLimit) return ambiguous();
  const sign = /^[+-]/u.exec(mantissa.value)?.[0] ?? "";
  const [integer, fraction = ""] = mantissa.value.replace(/^[+-]/u, "").split(".");
  const allDigits = `${integer}${fraction}`;
  const digits = allDigits.replace(/^0+/u, "");
  const suffix = match[4] ?? "";
  if (!digits) return { ambiguityReasons: [], value: `${sign === "+" ? "+" : ""}0${suffix}` };
  const point = integer!.length + exponent - (allDigits.length - digits.length);
  const length = sign.length + suffix.length + (point <= 0 ? 2 - point + digits.length
    : point >= digits.length ? point : digits.length + 1);
  if (length > exactDecimalLimit) return ambiguous();
  const decimal = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const normalized = decimal.includes(".") ? decimal.replace(/0+$/u, "").replace(/\.$/u, "") : decimal;
  return { ambiguityReasons: [], value: `${sign}${normalized}${suffix}` };
}

const knownUnitAtoms = new Set([
  "cm", "g", "h", "kg", "l", "m", "mg", "ml", "mm", "mmol", "mol", "ms", "s", "ug",
  "°c", "°f", "г", "кг", "л", "мг", "мкг", "мл", "ммоль", "моль", "μg"
]);

function canonicalKnownUnit(value: string): string | null {
  const normalized = value.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/µ/gu, "μ")
    .replace(/\s+/gu, "")
    .trim();
  if (normalized.length > 128) return null;
  const canonical = normalized;
  if (!canonical || !/^°?[\p{L}\p{M}]+(?:\^?[+-]?\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]{1,4})?(?:(?:\/|[·⋅*])°?[\p{L}\p{M}]+(?:\^?[+-]?\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]{1,4})?){0,3}$/u
    .test(canonical)) return null;
  const atoms = canonical.split(/(?:\/|[·⋅*])/u).map((atom) =>
    atom.replace(/(?:\^?[+-]?\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]{1,4})$/u, "")
      .toLocaleLowerCase("und"));
  return atoms.every((atom) => knownUnitAtoms.has(atom)) ? canonical : null;
}

export function normalizeKnowledgeTableHeaderPeriodV1(
  value: string
): KnowledgeTableHeaderPeriodV1 | null {
  const normalized = canonicalText(value, 64);
  const year = /^((?:19|20)\d{2})$/u.exec(normalized);
  if (year) return Object.freeze({
    effectiveFrom: `${year[1]}-01-01`,
    effectiveTo: `${year[1]}-12-31`
  });
  const quarter = /^(?:Q([1-4])\s+((?:19|20)\d{2})|((?:19|20)\d{2})\s+Q([1-4]))$/iu
    .exec(normalized);
  if (!quarter) return null;
  const quarterNumber = Number(quarter[1] ?? quarter[4]);
  const quarterYear = quarter[2] ?? quarter[3]!;
  const startMonth = (quarterNumber - 1) * 3 + 1;
  const endMonth = quarterNumber * 3;
  const endDay = endMonth === 3 || endMonth === 12 ? 31 : 30;
  return Object.freeze({
    effectiveFrom: `${quarterYear}-${String(startMonth).padStart(2, "0")}-01`,
    effectiveTo: `${quarterYear}-${String(endMonth).padStart(2, "0")}-${endDay}`
  });
}

export function normalizeKnowledgeObservationValue(
  value: string,
  normalizationVersion: KnowledgeObservationNormalizationVersion = 2
): NormalizedObservationValue {
  const prepared = canonicalText(normalizationVersion === 1 ? value : value.slice(0, exactDecimalLimit + 1),
    normalizationVersion === 1 ? exactDecimalLimit : exactDecimalLimit + 1).replace(/\u2212/gu, "-");
  const rawValue = prepared.slice(0, exactDecimalLimit);
  if (normalizationVersion === 2 && (value.length > exactDecimalLimit || prepared.length > exactDecimalLimit) &&
    /^[+-]?\d/u.test(rawValue)) return Object.freeze({
      ambiguityReasons: Object.freeze(["ambiguous_number" as const]), date: null, kind: "number",
      normalizedValue: null, rawValue, unit: null
    });
  const canonicalScientificDecimal = normalizationVersion === 1
    ? canonicalScientificDecimalLegacyV1 : canonicalScientificDecimalV2;
  const date = canonicalDate(rawValue);
  if (date) {
    return Object.freeze({
      ambiguityReasons: sortedReasons(date.value ? [] : date.ambiguityReasons),
      date: date.value,
      kind: "date",
      normalizedValue: date.value,
      rawValue,
      unit: null
    });
  }
  const range = /^([+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)\s*(?:\.\.|[–—])\s*([+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)\s*([^\s].*)?$/u.exec(rawValue);
  if (range) {
    const start = canonicalScientificDecimal(range[1]!.trim());
    const end = canonicalScientificDecimal(range[2]!.trim());
    if (start && end) {
      const unit = range[3] ? canonicalKnownUnit(range[3]) : null;
      const reasons = sortedReasons([
        ...start.ambiguityReasons,
        ...end.ambiguityReasons,
        ...(normalizationVersion === 2 && start.value && end.value &&
          start.value.length + end.value.length + 2 > exactDecimalLimit ? ["ambiguous_number" as const] : []),
        ...(range[3] && !unit ? ["ambiguous_number" as const] : [])
      ]);
      return Object.freeze({
        ambiguityReasons: reasons,
        date: null,
        kind: "number_range",
        normalizedValue: reasons.length === 0 && start.value && end.value
          ? `${start.value}..${end.value}`
          : null,
        rawValue,
        unit
      });
    }
  }
  const numeric = /^([+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)\s*([^\s].*)?$/u.exec(rawValue);
  if (numeric) {
    const number = canonicalScientificDecimal(numeric[1]!);
    const unit = numeric[2] ? canonicalKnownUnit(numeric[2]) : null;
    const reasons = sortedReasons([
      ...(number?.ambiguityReasons ?? ["ambiguous_number" as const]),
      ...(numeric[2] && !unit ? ["ambiguous_number" as const] : [])
    ]);
    return Object.freeze({
      ambiguityReasons: reasons,
      date: null,
      kind: "number",
      normalizedValue: reasons.length === 0 ? number?.value ?? null : null,
      rawValue,
      unit
    });
  }
  if (/^[+-]?\d/u.test(rawValue)) return Object.freeze({
    ambiguityReasons: Object.freeze(["ambiguous_number" as const]),
    date: null,
    kind: "number",
    normalizedValue: null,
    rawValue,
    unit: null
  });
  return Object.freeze({
    ambiguityReasons: Object.freeze([]),
    date: null,
    kind: "text",
    normalizedValue: rawValue || null,
    rawValue,
    unit: null
  });
}

function unitFromLabel(value: string): string | null {
  const match = /\(([^()]{1,64})\)\s*$/u.exec(value);
  const unit = match ? canonicalText(match[1]!, 64) : "";
  return unit && /[\p{L}%°/]/u.test(unit) ? unit : null;
}

function descriptor(value: string): Descriptor {
  const label = canonicalText(value, 512);
  const lower = label.toLocaleLowerCase("und");
  const matchedRoles: KnowledgeObservationRole[] = [];
  if (/\b(?:actual|observed|result|value|measured)\b|(?:^|\s)(?:факт|результат|значение|измерено)(?:\s|$)/u.test(lower)) {
    matchedRoles.push("observation");
  }
  if (/\b(?:reference|ref\.?|normal range)\b|(?:^|\s)(?:референс|референсный|норма)(?:\s|$)/u.test(lower)) {
    matchedRoles.push("reference");
  }
  if (/\b(?:target|goal)\b|(?:^|\s)(?:цель|план)(?:\s|$)/u.test(lower)) matchedRoles.push("target");
  if (/\b(?:threshold|limit)\b|(?:^|\s)(?:порог|предел)(?:\s|$)/u.test(lower)) {
    matchedRoles.push("threshold");
  }
  const role = matchedRoles.length === 1 ? matchedRoles[0]! : "metadata";
  const ambiguity = matchedRoles.length > 1 ? ["ambiguous_role" as const] : [];
  const kind = /\b(?:effective|valid)\s+from\b|(?:^|\s)(?:действует\s+с|с\s+даты)(?:\s|$)/u.test(lower)
    ? "effective_from"
    : /\b(?:effective|valid)\s+(?:to|until)\b|(?:^|\s)(?:действует\s+до|по\s+дату)(?:\s|$)/u.test(lower)
      ? "effective_to"
      : /\b(?:date|time|period)\b|(?:^|\s)(?:дата|время|период)(?:\s|$)/u.test(lower)
        ? "date"
        : /\b(?:subject|entity|patient|object)\b|(?:^|\s)(?:субъект|объект|пациент)(?:\s|$)/u.test(lower)
          ? "subject"
          : /\b(?:metric|analyte|indicator|field|parameter)\b|(?:^|\s)(?:метрика|аналит|показатель|поле|параметр)(?:\s|$)/u.test(lower)
            ? "metric"
            : /\b(?:unit|units)\b|(?:^|\s)(?:единица|единицы|ед\.?)(?:\s|$)/u.test(lower)
              ? "unit"
              : "value";
  const withoutUnit = label.replace(/\s*\([^()]{1,64}\)\s*$/u, "");
  const stripped = canonicalText(withoutUnit.replace(
    /\b(?:actual|observed|result|value|measured|reference|ref|normal|range|target|goal|threshold|limit)\b|(?:^|\s)(?:факт|результат|значение|измерено|референс|референсный|норма|цель|план|порог|предел)(?=\s|$)/giu,
    " "
  ), 512);
  return Object.freeze({
    ambiguityReasons: Object.freeze(ambiguity),
    kind,
    metric: kind === "value" && stripped ? stripped : null,
    role,
    unit: unitFromLabel(label)
  });
}

/** Existing role grammar can corroborate a column schema; an arbitrary text
 * value (for example a person's name) is not a header merely because later
 * rows contain numbers. Unknown schemas remain available as raw evidence. */
export function knowledgeTableHeaderRoleIsExplicitV1(value: string): boolean {
  const details = descriptor(value);
  return details.ambiguityReasons.length === 0 &&
    (details.kind !== "value" || details.role !== "metadata" || details.unit !== null);
}

function minimumConfidence(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : Math.min(...values as number[]);
}

function singleShared(values: readonly string[], maximum = 1_024): Readonly<{
  ambiguous: boolean;
  value: string | null;
}> {
  const unique = [...new Set(values.map((value) => canonicalText(value, maximum)).filter(Boolean))];
  return { ambiguous: unique.length > 1, value: unique.length === 1 ? unique[0]! : null };
}

function resolvedObservationUnit(
  values: readonly (string | null)[]
): Readonly<{ ambiguous: boolean; value: string | null }> {
  const units = values.filter((value): value is string => Boolean(value));
  const unique = new Map<string, string>();
  for (const unit of units) {
    const key = unit.normalize("NFKC").replace(/µ/gu, "μ").replace(/\s+/gu, "")
      .toLocaleLowerCase("und");
    if (key) unique.set(key, unique.get(key) ?? unit);
  }
  return unique.size > 1
    ? Object.freeze({ ambiguous: true, value: null })
    : Object.freeze({ ambiguous: false, value: unique.values().next().value ?? null });
}

type ColumnObservationCell = Readonly<{
  confidence: number | null;
  header: string | null;
  origin: KnowledgeDocumentObservationOriginV1;
  text: string;
}>;

type InlinePairEvidence = "singleton_table" | "sparse_row";

/**
 * Recovers the explicit key/value relation of a form-like row that a parser
 * represented as a table. Adjacent cells require proof that this is the only
 * logical row; otherwise a structural gap is required and ordinary tabular
 * data stays fail-closed.
 */
function observationForInlinePair(
  cells: readonly ColumnObservationCell[],
  evidence: InlinePairEvidence,
  normalizationVersion: KnowledgeObservationNormalizationVersion
): KnowledgeDocumentObservationV1 | null {
  if (cells.length !== 2 || cells.some((cell) => cell.header !== null ||
    cell.origin.kind !== "table_cell")) return null;
  const [labelCell, valueCell] = [...cells].sort((left, right) => {
    if (left.origin.kind !== "table_cell" || right.origin.kind !== "table_cell") return 0;
    return left.origin.columnStart - right.origin.columnStart ||
      left.origin.columnEnd - right.origin.columnEnd;
  });
  if (!labelCell || !valueCell || labelCell.origin.kind !== "table_cell" ||
    valueCell.origin.kind !== "table_cell" ||
    valueCell.origin.columnStart <= labelCell.origin.columnEnd ||
    evidence === "sparse_row" &&
      valueCell.origin.columnStart <= labelCell.origin.columnEnd + 1) return null;
  const label = canonicalText(labelCell.text, 256);
  if (!label || label.length > 160 || label.split(/\s+/u).length > 12 ||
    !/[\p{L}\p{M}]/u.test(label)) return null;
  const normalizedLabel = normalizeKnowledgeObservationValue(label, normalizationVersion);
  if (normalizedLabel.kind !== "text" || normalizedLabel.ambiguityReasons.length > 0) return null;

  const details = descriptor(label);
  const value = normalizeKnowledgeObservationValue(valueCell.text, normalizationVersion);
  const unit = details.kind === "unit"
    ? Object.freeze({ ambiguous: false, value: canonicalText(valueCell.text, 128) || null })
    : resolvedObservationUnit([value.unit, details.unit]);
  const reasons = sortedReasons([
    ...details.ambiguityReasons,
    ...value.ambiguityReasons,
    ...(unit.ambiguous ? ["ambiguous_role" as const] : [])
  ]);
  return Object.freeze({
    ambiguityReasons: reasons,
    confidence: minimumConfidence([labelCell.confidence, valueCell.confidence]),
    date: details.kind === "date" ? value.date : null,
    effectiveFrom: details.kind === "effective_from" ? value.date : null,
    effectiveTo: details.kind === "effective_to" ? value.date : null,
    metric: details.kind === "metric"
      ? canonicalText(valueCell.text, 1_024) || null
      : details.metric,
    normalizedValue: value.normalizedValue,
    origin: valueCell.origin,
    rawValue: value.rawValue,
    role: details.kind === "value" ? details.role : "metadata",
    subject: details.kind === "subject"
      ? canonicalText(valueCell.text, 1_024) || null
      : null,
    unit: unit.value,
    valueKind: value.kind
  });
}

function observationsForColumns(input: Readonly<{
  cells: readonly ColumnObservationCell[];
  normalizationVersion: KnowledgeObservationNormalizationVersion;
}>): readonly KnowledgeDocumentObservationV1[] {
  const described = input.cells.map((cell) => ({
    cell,
    descriptor: cell.header ? descriptor(cell.header) : null,
    period: cell.header ? normalizeKnowledgeTableHeaderPeriodV1(cell.header) : null,
    value: normalizeKnowledgeObservationValue(cell.text, input.normalizationVersion)
  }));
  const sharedSubject = singleShared(described.filter(({ descriptor }) => descriptor?.kind === "subject")
    .map(({ cell }) => cell.text));
  const sharedMetric = singleShared(described.filter(({ descriptor }) => descriptor?.kind === "metric")
    .map(({ cell }) => cell.text));
  const sharedUnit = singleShared(described.filter(({ descriptor }) => descriptor?.kind === "unit")
    .map(({ cell }) => cell.text), 128);
  const sharedDate = singleShared(described.filter(({ descriptor, value }) =>
    descriptor?.kind === "date" && value.date).map(({ value }) => value.date!));
  const effectiveFrom = singleShared(described.filter(({ descriptor, value }) =>
    descriptor?.kind === "effective_from" && value.date).map(({ value }) => value.date!));
  const effectiveTo = singleShared(described.filter(({ descriptor, value }) =>
    descriptor?.kind === "effective_to" && value.date).map(({ value }) => value.date!));
  const sharedAmbiguous = sharedSubject.ambiguous || sharedMetric.ambiguous || sharedUnit.ambiguous ||
    sharedDate.ambiguous || effectiveFrom.ambiguous || effectiveTo.ambiguous;

  return Object.freeze(described.filter(({ cell }) => canonicalText(cell.text, 4_096)).map((entry) => {
    const descriptorValue = entry.descriptor;
    const unit = descriptorValue?.kind === "unit"
      ? Object.freeze({
          ambiguous: false,
          value: canonicalText(entry.cell.text, 128) || null
        })
      : resolvedObservationUnit([
          entry.value.unit,
          sharedUnit.value,
          descriptorValue?.unit ?? null
        ]);
    const reasons = sortedReasons([
      ...entry.value.ambiguityReasons,
      ...(entry.descriptor?.ambiguityReasons ?? ["missing_header" as const]),
      ...(sharedAmbiguous || unit.ambiguous ? ["ambiguous_role" as const] : [])
    ]);
    return Object.freeze({
      ambiguityReasons: reasons,
      confidence: entry.cell.confidence,
      date: descriptorValue?.kind === "date" ? entry.value.date : sharedDate.value,
      effectiveFrom: descriptorValue?.kind === "effective_from"
        ? entry.value.date
        : entry.period?.effectiveFrom ?? effectiveFrom.value,
      effectiveTo: descriptorValue?.kind === "effective_to"
        ? entry.value.date
        : entry.period?.effectiveTo ?? effectiveTo.value,
      metric: entry.period
        ? sharedMetric.value
        : descriptorValue?.kind === "metric"
          ? canonicalText(entry.cell.text, 1_024) || null
          : sharedMetric.value ?? descriptorValue?.metric ?? null,
      normalizedValue: entry.value.normalizedValue,
      origin: entry.cell.origin,
      rawValue: entry.value.rawValue,
      role: entry.period && (entry.value.kind === "number" || entry.value.kind === "number_range")
        ? "observation"
        : descriptorValue?.kind === "date" || descriptorValue?.kind === "effective_from" ||
        descriptorValue?.kind === "effective_to" || descriptorValue?.kind === "metric" ||
        descriptorValue?.kind === "subject" || descriptorValue?.kind === "unit"
          ? "metadata"
          : descriptorValue?.role ?? "metadata",
      subject: descriptorValue?.kind === "subject"
        ? canonicalText(entry.cell.text, 1_024) || null
        : sharedSubject.value,
      unit: unit.value,
      valueKind: entry.value.kind
    });
  }));
}

export function knowledgeTableRowId(blockId: string, rowIndex: number): string {
  return `ktr_${createHash("sha256").update(blockId, "utf8").update("\0", "utf8")
    .update(String(rowIndex), "utf8").digest("hex").slice(0, 32)}`;
}

export function createKnowledgeTableDocumentContext(input: Readonly<{
  blockId: string;
  cells: readonly KnowledgeTableContextCell[];
  columnEnd?: number;
  columnStart?: number;
  headerLineage: readonly KnowledgeTableHeaderLineageV1[];
  inlinePairEvidence?: InlinePairEvidence;
  normalizationVersion?: KnowledgeObservationNormalizationVersion;
  projectionCount?: number;
  projectionIndex?: number;
  rowIndex: number;
  rowKind?: "data" | "header";
}>): KnowledgeDocumentContextV1 {
  const projection = input.columnStart !== undefined || input.columnEnd !== undefined ||
    input.projectionIndex !== undefined || input.projectionCount !== undefined;
  if (!boundedString(input.blockId, 512) || !index(input.rowIndex, 2_000) ||
    input.inlinePairEvidence !== undefined &&
      input.inlinePairEvidence !== "singleton_table" && input.inlinePairEvidence !== "sparse_row" ||
    input.cells.length < 1 || input.cells.length > 200 ||
    input.headerLineage.length > 256 || input.cells.some((cell) =>
      !index(cell.columnStart, 199) || !index(cell.columnEnd, 199) ||
      cell.columnEnd < cell.columnStart ||
      !boundedString(cell.text, KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS)) ||
    input.headerLineage.some((header) =>
      !index(header.columnStart, 199) || !index(header.columnEnd, 199) ||
      header.columnEnd < header.columnStart || !index(header.rowIndex, 2_000) ||
      !boundedString(header.text, KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS))) {
    throw new Error("knowledge_document_context_invalid");
  }
  const headers = new Map<number, string>();
  for (const header of input.headerLineage) {
    for (let column = header.columnStart; column <= header.columnEnd; column += 1) {
      const previous = headers.get(column);
      headers.set(column, previous ? `${previous} / ${header.text}` : header.text);
    }
  }
  const rowKind = input.rowKind ?? "data";
  const columnCells = input.cells.map((cell) => ({
    confidence: null,
    header: headers.get(cell.columnStart) ?? null,
    origin: Object.freeze({
      columnEnd: cell.columnEnd,
      columnStart: cell.columnStart,
      kind: "table_cell" as const
    }),
    text: cell.text
  }));
  const inlinePair = rowKind === "data" && input.inlinePairEvidence !== undefined &&
    input.headerLineage.length === 0
    ? observationForInlinePair(columnCells, input.inlinePairEvidence, input.normalizationVersion ?? 2)
    : null;
  const observations = rowKind === "header"
    ? Object.freeze(input.cells.filter((cell) => canonicalText(cell.text, 4_096)).map((cell) => {
        const value = normalizeKnowledgeObservationValue(cell.text, input.normalizationVersion ?? 2);
        return Object.freeze({
          ambiguityReasons: value.ambiguityReasons,
          confidence: null,
          date: value.date,
          effectiveFrom: null,
          effectiveTo: null,
          metric: null,
          normalizedValue: value.normalizedValue,
          origin: Object.freeze({
            columnEnd: cell.columnEnd,
            columnStart: cell.columnStart,
            kind: "table_cell" as const
          }),
          rawValue: value.rawValue,
          role: "header" as const,
          subject: null,
          unit: null,
          valueKind: value.kind
        });
      }))
    : inlinePair
      ? Object.freeze([inlinePair])
      : observationsForColumns({ cells: columnCells, normalizationVersion: input.normalizationVersion ?? 2 });
  const reasons = sortedReasons(observations.flatMap((observation) => observation.ambiguityReasons));
  const common = {
    blockId: input.blockId,
    headerLineage: Object.freeze([...input.headerLineage]),
    rowId: knowledgeTableRowId(input.blockId, input.rowIndex),
    rowIndex: input.rowIndex,
    rowKind
  };
  let locator: KnowledgeDocumentLocatorV1;
  if (projection) {
    const projectionCount = input.projectionCount;
    const projectionIndex = input.projectionIndex;
    if (!index(input.columnStart, 199) || !index(input.columnEnd, 199) ||
      input.columnEnd < input.columnStart || !index(projectionIndex, 199) ||
      !Number.isSafeInteger(projectionCount) || projectionCount === undefined || projectionCount < 1 ||
      projectionCount > KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS || projectionIndex >= projectionCount) {
      throw new Error("knowledge_document_context_invalid");
    }
    locator = Object.freeze({
      ...common,
      columnEnd: input.columnEnd,
      columnStart: input.columnStart,
      kind: "table_row_projection",
      projectionCount,
      projectionIndex
    });
  } else {
    locator = Object.freeze({ ...common, kind: "table_row" });
  }
  return Object.freeze({
    ambiguityReasons: reasons,
    locator,
    observations,
    version: KNOWLEDGE_DOCUMENT_CONTEXT_VERSION
  });
}

function fieldPairKey(labelId: number, valueId: number): string {
  return `${labelId}:${valueId}`;
}

export function createKnowledgeFieldContextSegments(
  group: KnowledgeFieldGroupContextInput,
  normalizationVersion: KnowledgeObservationNormalizationVersion = 2
): readonly KnowledgeFieldContextSegment[] {
  const cells = new Map(group.cells.map((cell) => [cell.id, cell]));
  const candidates = new Map<number, Set<number>>();
  const conflicts = new Set<number>();
  const pairConfidences = new Map<string, (number | null)[]>();
  for (const link of group.links) {
    const source = cells.get(link.sourceCellId);
    const target = cells.get(link.targetCellId);
    if (!source || !target) continue;
    const directed = link.label === "to_value" && source.label === "key" && target.label === "value"
      ? [source.id, target.id] as const
      : link.label === "to_key" && source.label === "value" && target.label === "key"
        ? [target.id, source.id] as const
        : null;
    if (!directed) {
      if (link.label === "to_key" || link.label === "to_value") {
        conflicts.add(source.id);
        conflicts.add(target.id);
      }
      continue;
    }
    const [labelId, valueId] = directed;
    const labelCandidates = candidates.get(labelId) ?? new Set<number>();
    labelCandidates.add(valueId);
    candidates.set(labelId, labelCandidates);
    const valueCandidates = candidates.get(valueId) ?? new Set<number>();
    valueCandidates.add(labelId);
    candidates.set(valueId, valueCandidates);
    const key = fieldPairKey(labelId, valueId);
    pairConfidences.set(key, [...(pairConfidences.get(key) ?? []), link.confidence]);
  }

  const paired = new Set<number>();
  const resolvedPairs: Array<Readonly<{ label: FieldCell; value: FieldCell; confidence: number | null }>> = [];
  for (const label of [...cells.values()].filter((cell) => cell.label === "key")
    .sort((left, right) => left.order - right.order || left.id - right.id)) {
    const counterparts = [...(candidates.get(label.id) ?? [])];
    if (counterparts.length !== 1 || conflicts.has(label.id)) continue;
    const value = cells.get(counterparts[0]!);
    if (!value || value.label !== "value" || conflicts.has(value.id) ||
      (candidates.get(value.id)?.size ?? 0) !== 1) continue;
    paired.add(label.id);
    paired.add(value.id);
    resolvedPairs.push(Object.freeze({
      confidence: minimumConfidence([
        group.confidence,
        label.confidence,
        value.confidence,
        ...(pairConfidences.get(fieldPairKey(label.id, value.id)) ?? [])
      ]),
      label,
      value
    }));
  }

  const pairDescriptors = resolvedPairs.map((pair) => ({
    pair,
    descriptor: descriptor(pair.label.text),
    value: normalizeKnowledgeObservationValue(pair.value.text, normalizationVersion)
  }));
  const sharedSubject = singleShared(pairDescriptors.filter(({ descriptor }) => descriptor.kind === "subject")
    .map(({ pair }) => pair.value.text));
  const sharedMetric = singleShared(pairDescriptors.filter(({ descriptor }) => descriptor.kind === "metric")
    .map(({ pair }) => pair.value.text));
  const sharedUnit = singleShared(pairDescriptors.filter(({ descriptor }) => descriptor.kind === "unit")
    .map(({ pair }) => pair.value.text), 128);
  const sharedDate = singleShared(pairDescriptors.filter(({ descriptor, value }) =>
    descriptor.kind === "date" && value.date).map(({ value }) => value.date!));
  const sharedEffectiveFrom = singleShared(pairDescriptors.filter(({ descriptor, value }) =>
    descriptor.kind === "effective_from" && value.date).map(({ value }) => value.date!));
  const sharedEffectiveTo = singleShared(pairDescriptors.filter(({ descriptor, value }) =>
    descriptor.kind === "effective_to" && value.date).map(({ value }) => value.date!));

  const result: KnowledgeFieldContextSegment[] = resolvedPairs.map((pair) => {
    const details = pairDescriptors.find((entry) => entry.pair === pair)!;
    const unit = details.descriptor.kind === "unit"
      ? Object.freeze({
          ambiguous: false,
          value: canonicalText(pair.value.text, 128) || null
        })
      : resolvedObservationUnit([
          details.value.unit,
          sharedUnit.value,
          details.descriptor.unit
        ]);
    const reasons = sortedReasons([
      ...details.descriptor.ambiguityReasons,
      ...details.value.ambiguityReasons,
      ...(sharedSubject.ambiguous || sharedMetric.ambiguous || sharedUnit.ambiguous ||
        sharedDate.ambiguous || sharedEffectiveFrom.ambiguous || sharedEffectiveTo.ambiguous ||
        unit.ambiguous
        ? ["ambiguous_role" as const]
        : [])
    ]);
    const observation: KnowledgeDocumentObservationV1 = Object.freeze({
      ambiguityReasons: reasons,
      confidence: pair.confidence,
      date: details.descriptor.kind === "date" ? details.value.date : sharedDate.value,
      effectiveFrom: details.descriptor.kind === "effective_from"
        ? details.value.date
        : sharedEffectiveFrom.value,
      effectiveTo: details.descriptor.kind === "effective_to"
        ? details.value.date
        : sharedEffectiveTo.value,
      metric: details.descriptor.kind === "metric"
        ? canonicalText(pair.value.text, 1_024) || null
        : sharedMetric.value ?? details.descriptor.metric,
      normalizedValue: details.value.normalizedValue,
      origin: Object.freeze({ cellId: pair.value.id, kind: "field_cell" }),
      rawValue: details.value.rawValue,
      role: details.descriptor.kind === "value" ? details.descriptor.role : "metadata",
      subject: details.descriptor.kind === "subject"
        ? canonicalText(pair.value.text, 1_024) || null
        : sharedSubject.value,
      unit: unit.value,
      valueKind: details.value.kind
    });
    return Object.freeze({
      cellIds: Object.freeze([pair.label.id, pair.value.id]),
      context: Object.freeze({
        ambiguityReasons: reasons,
        locator: Object.freeze({
          fieldGroupId: group.id,
          kind: "field_pair",
          labelCellId: pair.label.id,
          valueCellId: pair.value.id
        }),
        observations: Object.freeze([observation]),
        version: KNOWLEDGE_DOCUMENT_CONTEXT_VERSION
      }),
      text: `${pair.label.text}\t${pair.value.text}`
    });
  });

  for (const cell of [...cells.values()].sort((left, right) => left.order - right.order || left.id - right.id)) {
    if (paired.has(cell.id) || !canonicalText(cell.text, 4_096)) continue;
    const cellCandidates = [...(candidates.get(cell.id) ?? [])].sort((left, right) => left - right);
    const counterpartCompetes = cellCandidates.some((candidate) =>
      (candidates.get(candidate)?.size ?? 0) !== 1);
    const reasons = sortedReasons([
      ...(conflicts.has(cell.id) ? ["conflicting_edge" as const] : []),
      ...(cellCandidates.length > 1 || counterpartCompetes ? ["competing_pair" as const] : []),
      ...(cellCandidates.length === 0 ? ["missing_pair" as const] : []),
      ...(cell.label === "unspecified" || cell.label === "checkbox"
        ? ["unspecified_role" as const]
        : [])
    ]);
    const value = normalizeKnowledgeObservationValue(cell.text, normalizationVersion);
    const observation: KnowledgeDocumentObservationV1 = Object.freeze({
      ambiguityReasons: sortedReasons([...reasons, ...value.ambiguityReasons]),
      confidence: minimumConfidence([group.confidence, cell.confidence]),
      date: value.date,
      effectiveFrom: null,
      effectiveTo: null,
      metric: null,
      normalizedValue: value.normalizedValue,
      origin: Object.freeze({ cellId: cell.id, kind: "field_cell" }),
      rawValue: value.rawValue,
      role: "metadata",
      subject: null,
      unit: null,
      valueKind: value.kind
    });
    result.push(Object.freeze({
      cellIds: Object.freeze([cell.id]),
      context: Object.freeze({
        ambiguityReasons: observation.ambiguityReasons,
        locator: Object.freeze({
          candidateCellIds: Object.freeze(cellCandidates),
          cellId: cell.id,
          fieldGroupId: group.id,
          kind: "field_ambiguous"
        }),
        observations: Object.freeze([observation]),
        version: KNOWLEDGE_DOCUMENT_CONTEXT_VERSION
      }),
      text: cell.text
    }));
  }
  return Object.freeze(result);
}

function decodeReasons(value: unknown): readonly KnowledgeDocumentAmbiguityReason[] | null {
  if (!Array.isArray(value) || value.length > 16 || value.some((reason) =>
    typeof reason !== "string" || !ambiguityReasons.has(reason as KnowledgeDocumentAmbiguityReason))) return null;
  const sorted = sortedReasons(value as KnowledgeDocumentAmbiguityReason[]);
  return sorted.length === value.length && sorted.every((reason, position) => reason === value[position])
    ? sorted
    : null;
}

function decodeHeaderLineage(value: unknown): readonly KnowledgeTableHeaderLineageV1[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const decoded: KnowledgeTableHeaderLineageV1[] = [];
  for (const item of value) {
    if (!record(item) || !exactKeys(item, ["columnEnd", "columnStart", "rowIndex", "text"]) ||
      !index(item.columnStart, 199) || !index(item.columnEnd, 199) || item.columnEnd < item.columnStart ||
      !index(item.rowIndex, 2_000) ||
      !boundedString(item.text, KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS)) return null;
    decoded.push(Object.freeze({
      columnEnd: item.columnEnd,
      columnStart: item.columnStart,
      rowIndex: item.rowIndex,
      text: item.text
    }));
  }
  return Object.freeze(decoded);
}

function decodeLocator(value: unknown): KnowledgeDocumentLocatorV1 | null {
  if (!record(value) || typeof value.kind !== "string") return null;
  if (value.kind === "table_row" || value.kind === "table_row_projection") {
    const projected = value.kind === "table_row_projection";
    const keys = projected
      ? ["blockId", "columnEnd", "columnStart", "headerLineage", "kind", "projectionCount", "projectionIndex", "rowId", "rowIndex", "rowKind"]
      : ["blockId", "headerLineage", "kind", "rowId", "rowIndex", "rowKind"];
    const headers = decodeHeaderLineage(value.headerLineage);
    if (!exactKeys(value, keys) || !boundedString(value.blockId, 512) ||
      !boundedString(value.rowId, 128) || !index(value.rowIndex, 2_000) || !headers) return null;
    if (value.rowKind !== "data" && value.rowKind !== "header") return null;
    if (value.rowId !== knowledgeTableRowId(value.blockId, value.rowIndex)) return null;
    if (!projected) return Object.freeze({
      blockId: value.blockId,
      headerLineage: headers,
      kind: "table_row",
      rowId: value.rowId,
      rowIndex: value.rowIndex,
      rowKind: value.rowKind
    });
    const projectionCount = value.projectionCount;
    if (!index(value.columnStart, 199) || !index(value.columnEnd, 199) ||
      value.columnEnd < value.columnStart || !index(value.projectionIndex, 199) ||
      !Number.isSafeInteger(projectionCount) || typeof projectionCount !== "number" ||
      projectionCount < 1 || projectionCount > KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS ||
      value.projectionIndex >= projectionCount) return null;
    return Object.freeze({
      blockId: value.blockId,
      columnEnd: value.columnEnd,
      columnStart: value.columnStart,
      headerLineage: headers,
      kind: "table_row_projection",
      projectionCount,
      projectionIndex: value.projectionIndex,
      rowId: value.rowId,
      rowIndex: value.rowIndex,
      rowKind: value.rowKind
    });
  }
  if (value.kind === "field_pair") {
    if (!exactKeys(value, ["fieldGroupId", "kind", "labelCellId", "valueCellId"]) ||
      !boundedString(value.fieldGroupId, 512) || !index(value.labelCellId) || !index(value.valueCellId) ||
      value.labelCellId === value.valueCellId) return null;
    return Object.freeze({
      fieldGroupId: value.fieldGroupId,
      kind: "field_pair",
      labelCellId: value.labelCellId,
      valueCellId: value.valueCellId
    });
  }
  if (value.kind === "field_ambiguous") {
    if (!exactKeys(value, ["candidateCellIds", "cellId", "fieldGroupId", "kind"]) ||
      !boundedString(value.fieldGroupId, 512) || !index(value.cellId) ||
      !Array.isArray(value.candidateCellIds) || value.candidateCellIds.length > 256 ||
      value.candidateCellIds.some((candidate) => !index(candidate) || candidate === value.cellId)) return null;
    const candidateCellIds = value.candidateCellIds as unknown[];
    const candidates = [...new Set(candidateCellIds as number[])].sort((left, right) => left - right);
    if (candidates.length !== candidateCellIds.length || candidates.some((candidate, position) =>
      candidate !== candidateCellIds[position])) return null;
    return Object.freeze({
      candidateCellIds: Object.freeze(candidates),
      cellId: value.cellId,
      fieldGroupId: value.fieldGroupId,
      kind: "field_ambiguous"
    });
  }
  return null;
}

function decodeOrigin(value: unknown): KnowledgeDocumentObservationOriginV1 | null {
  if (!record(value) || typeof value.kind !== "string") return null;
  if (value.kind === "table_cell") {
    return exactKeys(value, ["columnEnd", "columnStart", "kind"]) &&
      index(value.columnStart, 199) && index(value.columnEnd, 199) && value.columnEnd >= value.columnStart
      ? Object.freeze({
          columnEnd: value.columnEnd,
          columnStart: value.columnStart,
          kind: "table_cell"
        })
      : null;
  }
  return value.kind === "field_cell" && exactKeys(value, ["cellId", "kind"]) && index(value.cellId)
    ? Object.freeze({ cellId: value.cellId, kind: "field_cell" })
    : null;
}

function decodeObservation(value: unknown): KnowledgeDocumentObservationV1 | null {
  if (!record(value) || !exactKeys(value, [
    "ambiguityReasons", "confidence", "date", "effectiveFrom", "effectiveTo", "metric",
    "normalizedValue", "origin", "rawValue", "role", "subject", "unit", "valueKind"
  ])) return null;
  const reasons = decodeReasons(value.ambiguityReasons);
  const origin = decodeOrigin(value.origin);
  if (!reasons || !origin || !confidence(value.confidence) ||
    !normalizedDate(value.date) || !normalizedDate(value.effectiveFrom) ||
    !normalizedDate(value.effectiveTo) || !boundedNullableString(value.metric) ||
    !boundedNullableString(value.normalizedValue, 4_096) || !boundedString(value.rawValue, 4_096) ||
    typeof value.role !== "string" || !observationRoles.has(value.role as KnowledgeObservationRole) ||
    !boundedNullableString(value.subject) || !boundedNullableString(value.unit, 128) ||
    typeof value.valueKind !== "string" ||
    !observationKinds.has(value.valueKind as KnowledgeObservationValueKind)) return null;
  return Object.freeze({
    ambiguityReasons: reasons,
    confidence: value.confidence,
    date: value.date,
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
    metric: value.metric,
    normalizedValue: value.normalizedValue,
    origin,
    rawValue: value.rawValue,
    role: value.role as KnowledgeObservationRole,
    subject: value.subject,
    unit: value.unit,
    valueKind: value.valueKind as KnowledgeObservationValueKind
  });
}

export function decodeKnowledgeDocumentContext(value: unknown): KnowledgeDocumentContextV1 | null {
  if (!record(value) || !exactKeys(value, ["ambiguityReasons", "locator", "observations", "version"]) ||
    value.version !== KNOWLEDGE_DOCUMENT_CONTEXT_VERSION || !Array.isArray(value.observations) ||
    value.observations.length > 256) return null;
  const reasons = decodeReasons(value.ambiguityReasons);
  const locator = decodeLocator(value.locator);
  const observations = value.observations.map(decodeObservation);
  if (!reasons || !locator || observations.some((observation) => observation === null)) return null;
  const observationReasons = sortedReasons((observations as KnowledgeDocumentObservationV1[])
    .flatMap((observation) => observation.ambiguityReasons));
  if (reasons.length !== observationReasons.length || reasons.some((reason, index) =>
    reason !== observationReasons[index])) return null;
  return Object.freeze({
    ambiguityReasons: reasons,
    locator,
    observations: Object.freeze(observations as KnowledgeDocumentObservationV1[]),
    version: KNOWLEDGE_DOCUMENT_CONTEXT_VERSION
  });
}
