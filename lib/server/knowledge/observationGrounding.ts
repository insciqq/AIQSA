import {
  decodeKnowledgeDocumentContext,
  normalizeKnowledgeObservationValue,
  type KnowledgeDocumentContextV1,
  type KnowledgeDocumentObservationV1,
  type KnowledgeObservationRole
} from "./documentContext";

export const KNOWLEDGE_OBSERVATION_GROUNDING_VERSION = 1 as const;

export const knowledgeObservationGroundingReasonCodes = [
  "ambiguous_claim",
  "ambiguous_context",
  "invalid_context",
  "missing_claim_observation",
  "observation_context_mismatch",
  "observation_not_unique"
] as const;

export type KnowledgeObservationGroundingReasonCode =
  typeof knowledgeObservationGroundingReasonCodes[number];

export type KnowledgeObservationGroundingVocabularyV1 = Readonly<{
  metrics: readonly string[];
  subjects: readonly string[];
  units: readonly string[];
  version: typeof KNOWLEDGE_OBSERVATION_GROUNDING_VERSION;
}>;

export type KnowledgeObservationGroundingResultV1 = Readonly<{
  matchedObservationIndexes: readonly number[];
  reasonCodes: readonly KnowledgeObservationGroundingReasonCode[];
  supported: boolean;
  version: typeof KNOWLEDGE_OBSERVATION_GROUNDING_VERSION;
}>;

type ClaimAtom = Readonly<{
  end: number;
  kind: "date" | "scalar";
  normalizedValue: string;
  start: number;
  unit: string | null;
}>;

type SourceVersionAtom = Readonly<{
  end: number;
  start: number;
  value: number;
}>;

type DateConstraint = Readonly<{
  field: "any" | "date" | "effective_from" | "effective_to";
  value: string;
}> | Readonly<{
  effectiveFrom: string;
  effectiveTo: string;
  field: "period";
}>;

type PhraseOccurrence = Readonly<{
  end: number;
  label: string;
  start: number;
}>;

type RoleOccurrence = Readonly<{
  end: number;
  role: KnowledgeObservationRole;
  start: number;
  strong: boolean;
}>;

const claimAtom = /(?<![\p{L}\p{N}_])(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?\s*(?:\.\.|[–—])\s*[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?|[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)(?!\p{N})/gu;
const unitSuffix = /^(\s*)((?:°?[\p{L}\p{M}%µμ]{1,16}(?:\^?[+-]?\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]{1,4})?)(?:(?:\/|[·⋅*])(?:°?[\p{L}\p{M}%µμ]{1,16}(?:\^?[+-]?\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]{1,4})?)){0,3})(?![\p{L}\p{M}\p{N}_])/u;
const nonUnitScalarContinuations = new Set([
  "and", "as", "at", "before", "but", "by", "for", "from", "in", "is", "of", "on", "or",
  "than", "then", "to", "was", "were", "with", "а", "был", "была", "были", "в", "для", "до",
  "за", "и", "или", "на", "но", "от", "по", "при", "равен", "равна", "равно", "с", "со", "чем"
]);
const sourceVersion = /(?:(?:\b(?:source\s+)?versions?|(?:^|\s)(?:верси\p{L}*|редакци\p{L}*))\s*(?:no\.?|№|#)?\s*(?:v\s*)?|(?<![\p{L}\p{N}_])v\s*)([+-]?\d+(?:[.,]\d+)?)(?![.,/-]\d|[\p{L}\p{N}_])/giu;
const sourceVersionCue = /(?:\b(?:source\s+)?versions?|(?:^|\s)(?:верси\p{L}*|редакци\p{L}*)|(?<![\p{L}\p{N}_])v(?=\s*[+-]?\d))/giu;
const numericComparatorPrefix = /(?:[<>≤≥]=?|±|\b(?:above|below|under|over|maximum|minimum|at\s+(?:(?:or\s+)?(?:above|below)|least|most)|less\s+than|more\s+than|greater\s+than|lower\s+than|higher\s+than|no\s+(?:less|more|greater|fewer)\s+than|up\s+to)|(?:^|\s)(?:выше|ниже|максимум|минимум|не\s+(?:менее|более|больше|меньше|выше|ниже|превышает)|меньше|больше|свыше|превышает))\s*$/u;
const numericComparatorSuffix = /^\s*(?:\+|±|\b(?:(?:or|and)\s+(?:more|less|above|below)|(?:max(?:imum)?|min(?:imum)?))\b|(?:и|или)\s+(?:более|менее|больше|меньше|выше|ниже)(?=$|\s|[.,;:]))/u;
const verbalRange = /(?:(?:\b(?:ranges?\s+from|between)\s*)|(?:(?:^|\s)(?:от|между)\s*))([+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)\s*(?:\b(?:to|and)\b|(?:до|и)(?=\s))\s*([+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)(?!\p{N})/giu;
const verbalRangeCue = /(?:\b(?:ranges?\s+from|between)\b|(?:^|\s)(?:от|между)(?=\s*[+-]?\d))/giu;
const quarterPeriod = /(?<![\p{L}\p{N}_])(?:q([1-4])\s*((?:19|20|21)\d{2})|((?:19|20|21)\d{2})\s*q([1-4]))(?![\p{L}\p{N}_]|[-./]\d)/giu;
const yearPeriod = /(?:\b(?:in|during|for)(?:\s+the\s+year)?\s+((?:19|20|21)\d{2})|(?:^|\s)(?:в|за)\s+((?:19|20|21)\d{2})(?:\s*г(?:од(?:у|а)?|\.)?)?)(?![\p{L}\p{N}_]|[-./]\d)/giu;
const word = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*/gu;
const rolePatterns: readonly Readonly<{
  pattern: RegExp;
  role: KnowledgeObservationRole;
  strong: boolean;
}>[] = Object.freeze([
  {
    pattern: /\b(?:actual|observed|measured)\b|(?:^|\s)(?:факт|фактическ\p{L}*|наблюдаем\p{L}*|измеренн\p{L}*)(?=\s|$)/giu,
    role: "observation",
    strong: true
  },
  {
    pattern: /\b(?:reference|ref\.?|normal(?:\s+(?:range|value))?|expected|baseline)\b|(?:^|\s)(?:референс\p{L}*|норм(?:а|атив\p{L}*)|ожидаем\p{L}*)(?=\s|$)/giu,
    role: "reference",
    strong: true
  },
  {
    pattern: /\b(?:target|goal|planned)\b|(?:^|\s)(?:цель|целев\p{L}*|план(?:ов\p{L}*)?)(?=\s|$)/giu,
    role: "target",
    strong: true
  },
  {
    pattern: /\b(?:threshold|limit)\b|(?:^|\s)(?:порог|предел)(?=\s|$)/giu,
    role: "threshold",
    strong: true
  },
  {
    pattern: /\b(?:result|value)\b|(?:^|\s)(?:результат|значение)(?=\s|$)/giu,
    role: "observation",
    strong: false
  }
]);
const metricCueWords = new Set([
  "analyte", "field", "indicator", "level", "measure", "metric", "parameter",
  "аналит", "индикатор", "индикатора", "метрика", "метрики", "параметр", "параметра",
  "показатель", "показателя", "показателю", "показателем", "поле", "уровень", "уровня"
]);
const subjectCueWords = new Set([
  "entity", "object", "patient", "subject", "объект", "объекта", "пациент", "пациента",
  "субъект", "субъекта"
]);
const cueIgnoredWords = new Set([
  "a", "an", "and", "are", "as", "at", "by", "called", "equals", "for", "from", "in",
  "is", "named", "of", "on", "the", "to", "was", "were", "with", "а", "в", "для", "до",
  "из", "на", "от", "по", "равен", "равна", "равно", "с", "со"
]);
const roleCueWords = new Set([
  "actual", "baseline", "expected", "goal", "limit", "measured", "normal", "observed", "planned",
  "reference", "result", "target", "threshold", "value", "значение", "измеренный", "норма",
  "норматив", "ожидаемый", "план", "плановый", "порог", "предел", "результат", "референс", "факт",
  "цель"
]);

function canonical(value: string): string {
  return value.normalize("NFKC").replace(/\u2212/gu, "-")
    .toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function stem(value: string): string {
  if (value.length <= 4) return value;
  if (/^[a-z]+$/u.test(value)) {
    return value.replace(/(?:ations?|ments?|ingly|edly|ing|ers?|ed|es|s)$/u, "") || value;
  }
  if (/^[а-яё]+$/u.test(value)) {
    return value.replace(
      /(?:иями|ями|ами|ого|ему|ому|ими|ий|ый|ая|яя|ое|ее|ые|ие|ых|их|ую|юю|ов|ев|ам|ям|ах|ях|ом|ем|ой|ей|ы|и|а|я|у|ю|е|о)$/u,
      ""
    ) || value;
  }
  return value;
}

function labelTokens(value: string): readonly string[] {
  return Object.freeze([...new Set((canonical(value).match(word) ?? [])
    .filter((token) => !/^\d/u.test(token))
    .map(stem))]);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map(canonical).filter(Boolean))].sort());
}

function normalizeScientificObservationValue(value: string): ReturnType<
  typeof normalizeKnowledgeObservationValue
> {
  const ordinary = normalizeKnowledgeObservationValue(value);
  if (ordinary.kind !== "text") return ordinary;
  const match = /^([+-]?\d+(?:[.,]\d+)?)[eE]([+-]?\d+)$/u.exec(value);
  if (!match) return ordinary;
  const mantissa = normalizeKnowledgeObservationValue(match[1]!);
  const exponent = Number(match[2]);
  const numeric = mantissa.normalizedValue === null
    ? Number.NaN
    : Number(mantissa.normalizedValue) * (10 ** exponent);
  if (mantissa.kind !== "number" || mantissa.ambiguityReasons.length > 0 ||
    !Number.isSafeInteger(exponent) || Math.abs(exponent) > 308 || !Number.isFinite(numeric)) {
    return Object.freeze({
      ambiguityReasons: Object.freeze(["ambiguous_number" as const]),
      date: null,
      kind: "number" as const,
      normalizedValue: null,
      rawValue: value,
      unit: null
    });
  }
  return Object.freeze({
    ambiguityReasons: Object.freeze([]),
    date: null,
    kind: "number" as const,
    normalizedValue: String(Object.is(numeric, -0) ? 0 : numeric),
    rawValue: value,
    unit: null
  });
}

function attachedUnitAt(text: string, end: number): string | null {
  const match = unitSuffix.exec(text.slice(end));
  if (!match?.[2]) return null;
  const unit = canonical(match[2]);
  return match[1] && nonUnitScalarContinuations.has(unit) ? null : unit;
}

function hasNumericComparator(text: string, start: number, end: number): boolean {
  return numericComparatorPrefix.test(text.slice(Math.max(0, start - 64), start)) ||
    numericComparatorSuffix.test(text.slice(end, Math.min(text.length, end + 32)));
}

function periodConstraint(year: number, quarter?: number): DateConstraint {
  const firstMonth = quarter ? ((quarter - 1) * 3) + 1 : 1;
  const lastMonth = quarter ? firstMonth + 2 : 12;
  const lastDay = new Date(Date.UTC(year, lastMonth, 0)).getUTCDate();
  return Object.freeze({
    effectiveFrom: `${year}-${String(firstMonth).padStart(2, "0")}-01`,
    effectiveTo: `${year}-${String(lastMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    field: "period" as const
  });
}

export function createKnowledgeObservationGroundingVocabularyV1(
  contexts: readonly KnowledgeDocumentContextV1[]
): KnowledgeObservationGroundingVocabularyV1 {
  const observations = contexts.flatMap((context) =>
    decodeKnowledgeDocumentContext(context)?.observations ?? []);
  return Object.freeze({
    metrics: sortedUnique(observations.flatMap((observation) =>
      observation.metric ? [observation.metric] : [])),
    subjects: sortedUnique(observations.flatMap((observation) =>
      observation.subject ? [observation.subject] : [])),
    units: sortedUnique(observations.flatMap((observation) =>
      observation.unit ? [observation.unit] : [])),
    version: KNOWLEDGE_OBSERVATION_GROUNDING_VERSION
  });
}

function result(
  supported: boolean,
  reasonCodes: readonly KnowledgeObservationGroundingReasonCode[],
  matchedObservationIndexes: readonly number[] = []
): KnowledgeObservationGroundingResultV1 {
  return Object.freeze({
    matchedObservationIndexes: Object.freeze([...new Set(matchedObservationIndexes)].sort((left, right) =>
      left - right)),
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
    supported,
    version: KNOWLEDGE_OBSERVATION_GROUNDING_VERSION
  });
}

function parseClaimAtoms(value: string): Readonly<{
  ambiguous: boolean;
  atoms: readonly ClaimAtom[];
  periods: readonly DateConstraint[];
  text: string;
  versions: readonly SourceVersionAtom[];
}> {
  const text = canonical(value);
  const atoms: ClaimAtom[] = [];
  const periods: DateConstraint[] = [];
  const versions: SourceVersionAtom[] = [];
  let ambiguous = false;
  const versionSpans: Array<Readonly<{ end: number; start: number }>> = [];
  const matchedVersionCues: Array<Readonly<{ end: number; start: number }>> = [];
  for (const match of text.matchAll(sourceVersion)) {
    const cueStart = match.index ?? 0;
    matchedVersionCues.push(Object.freeze({ end: cueStart + match[0].length, start: cueStart }));
    const raw = match[1]!;
    const start = cueStart + match[0].lastIndexOf(raw);
    const end = start + raw.length;
    const normalized = normalizeScientificObservationValue(raw);
    const numeric = normalized.normalizedValue === null ? Number.NaN : Number(normalized.normalizedValue);
    if (normalized.ambiguityReasons.length > 0 || normalized.kind !== "number" ||
      !Number.isSafeInteger(numeric) || numeric < 1) {
      ambiguous = true;
    } else {
      versions.push(Object.freeze({ end, start, value: numeric }));
    }
    versionSpans.push(Object.freeze({ end, start }));
  }
  if ([...text.matchAll(sourceVersionCue)].some((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return !matchedVersionCues.some((span) => start >= span.start && end <= span.end);
  })) ambiguous = true;
  const rangeSpans: Array<Readonly<{ end: number; start: number }>> = [];
  for (const match of text.matchAll(verbalRange)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const lower = normalizeScientificObservationValue(match[1]!);
    const upper = normalizeScientificObservationValue(match[2]!);
    if (lower.kind !== "number" || upper.kind !== "number" ||
      lower.ambiguityReasons.length > 0 || upper.ambiguityReasons.length > 0 ||
      !lower.normalizedValue || !upper.normalizedValue) {
      ambiguous = true;
    } else {
      atoms.push(Object.freeze({
        end,
        kind: "scalar",
        normalizedValue: `${lower.normalizedValue}..${upper.normalizedValue}`,
        start,
        unit: attachedUnitAt(text, end)
      }));
    }
    rangeSpans.push(Object.freeze({ end, start }));
  }
  if ([...text.matchAll(verbalRangeCue)].some((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return !rangeSpans.some((span) => start >= span.start && end <= span.end);
  })) ambiguous = true;
  const periodSpans: Array<Readonly<{ end: number; start: number }>> = [];
  for (const match of text.matchAll(quarterPeriod)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    periods.push(periodConstraint(Number(match[2] ?? match[3]), Number(match[1] ?? match[4])));
    periodSpans.push(Object.freeze({ end, start }));
  }
  for (const match of text.matchAll(yearPeriod)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (periodSpans.some((span) => start < span.end && end > span.start)) continue;
    periods.push(periodConstraint(Number(match[1] ?? match[2])));
    periodSpans.push(Object.freeze({ end, start }));
  }
  for (const match of text.matchAll(claimAtom)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if ([...versionSpans, ...rangeSpans, ...periodSpans]
      .some((span) => start < span.end && end > span.start)) continue;
    const raw = match[0].trim();
    const normalized = normalizeScientificObservationValue(raw);
    if (normalized.ambiguityReasons.length > 0 || !normalized.normalizedValue ||
      normalized.kind === "text") {
      ambiguous = true;
      continue;
    }
    if (normalized.kind !== "date" && hasNumericComparator(text, start, end)) {
      ambiguous = true;
      continue;
    }
    atoms.push(Object.freeze({
      end,
      kind: normalized.kind === "date" ? "date" : "scalar",
      normalizedValue: normalized.normalizedValue,
      start,
      unit: normalized.kind === "date" ? null : attachedUnitAt(text, end)
    }));
  }
  return Object.freeze({
    ambiguous,
    atoms: Object.freeze(atoms),
    periods: Object.freeze(periods),
    text,
    versions: Object.freeze(versions)
  });
}

function phraseOccurrences(text: string, labels: readonly string[]): readonly PhraseOccurrence[] {
  const occurrences: PhraseOccurrence[] = [];
  for (const label of labels) {
    let cursor = 0;
    while (cursor <= text.length - label.length) {
      const start = text.indexOf(label, cursor);
      if (start < 0) break;
      const end = start + label.length;
      const before = start === 0 ? "" : text[start - 1]!;
      const after = end === text.length ? "" : text[end]!;
      if ((!before || !/[\p{L}\p{N}_]/u.test(before)) &&
        (!after || !/[\p{L}\p{N}_]/u.test(after))) {
        occurrences.push(Object.freeze({ end, label, start }));
      }
      cursor = start + Math.max(1, label.length);
    }
  }
  return Object.freeze(occurrences);
}

function roleOccurrences(text: string): readonly RoleOccurrence[] {
  const occurrences = rolePatterns.flatMap(({ pattern, role, strong }) =>
    [...text.matchAll(pattern)].map((match) => Object.freeze({
      end: (match.index ?? 0) + match[0].length,
      role,
      start: match.index ?? 0,
      strong
    })));
  return Object.freeze(occurrences.filter((candidate) => candidate.strong || !occurrences.some((other) =>
    other.strong && other.role !== candidate.role &&
    Math.abs(other.start - candidate.start) <= 32)));
}

function distance(start: number, end: number, occurrence: Readonly<{ start: number; end: number }>): number {
  const center = (start + end) / 2;
  return Math.abs(center - (occurrence.start + occurrence.end) / 2);
}

function roleForAtom(
  atom: ClaimAtom,
  atoms: readonly ClaimAtom[],
  occurrences: readonly RoleOccurrence[]
): KnowledgeObservationRole | "ambiguous" | null {
  const roles = [...new Set(occurrences.map((occurrence) => occurrence.role))];
  if (roles.length === 0) return null;
  if (atoms.length === 1 && roles.length > 1) return "ambiguous";
  const ordered = [...occurrences].sort((left, right) =>
    distance(atom.start, atom.end, left) - distance(atom.start, atom.end, right));
  const nearest = ordered[0]!;
  const tied = ordered.filter((occurrence) =>
    distance(atom.start, atom.end, occurrence) === distance(atom.start, atom.end, nearest));
  return tied.some((occurrence) => occurrence.role !== nearest.role) ? "ambiguous" : nearest.role;
}

function cueTokens(text: string, cues: ReadonlySet<string>): readonly string[] {
  const words = [...text.matchAll(word)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
    value: match[0]
  }));
  const collected = new Set<string>();
  for (let position = 0; position < words.length; position += 1) {
    const entry = words[position]!;
    if (!cues.has(entry.value)) continue;
    const before: string[] = [];
    for (let index = position - 1; index >= 0 && before.length < 3; index -= 1) {
      const candidate = words[index]!;
      if (entry.start - candidate.end > 16 || /^\d/u.test(candidate.value) ||
        roleCueWords.has(candidate.value)) break;
      if (cueIgnoredWords.has(candidate.value) || cues.has(candidate.value)) continue;
      before.unshift(candidate.value);
    }
    const after: string[] = [];
    for (let index = position + 1; index < words.length && after.length < 3; index += 1) {
      const candidate = words[index]!;
      if (candidate.start - entry.end > 16 || /^\d/u.test(candidate.value) ||
        roleCueWords.has(candidate.value)) break;
      if (cueIgnoredWords.has(candidate.value) || cues.has(candidate.value)) continue;
      after.push(candidate.value);
    }
    for (const token of before.length > 0 ? before : after) collected.add(stem(token));
  }
  return Object.freeze([...collected]);
}

function oneMentionedLabel(
  text: string,
  labels: readonly string[]
): string | "ambiguous" | null {
  const mentioned = [...new Set(phraseOccurrences(text, labels).map((occurrence) => occurrence.label))]
    .filter((label, _index, all) => !all.some((other) => other !== label && other.includes(label)));
  return mentioned.length > 1 ? "ambiguous" : mentioned[0] ?? null;
}

function explicitNamedLabelTokens(
  text: string,
  atoms: readonly ClaimAtom[],
  vocabulary: KnowledgeObservationGroundingVocabularyV1
): readonly string[] {
  if (atoms.length < 1) return Object.freeze([]);
  const boundary = Math.min(...atoms.map((atom) => atom.start));
  const prefix = text.slice(0, boundary)
    .replace(sourceVersion, " ")
    .replace(quarterPeriod, " ")
    .replace(yearPeriod, " ")
    .replace(/(?:^|\s)(?:(?:in|on|at|as\s+of|source|version|v)|(?:в|на|по|от|верси\p{L}*))\s*$/u, " ");
  const ignored = new Set([
    ...cueIgnoredWords,
    ...roleCueWords,
    ...metricCueWords,
    ...subjectCueWords,
    "source",
    "version",
    "according",
    "data",
    "document",
    "evidence",
    "report",
    "says",
    "selected",
    "shows",
    "states",
    "верси",
    "версия",
    "версии",
    ...vocabulary.units.flatMap(labelTokens)
  ].map((token) => stem(canonical(token))));
  return Object.freeze([...new Set(labelTokens(prefix).filter((token) =>
    token.length > 1 && !ignored.has(token) && !/^v\d+$/u.test(token)))]);
}

function dateConstraint(text: string, atom: ClaimAtom): DateConstraint {
  const prefix = text.slice(Math.max(0, atom.start - 48), atom.start);
  const field = /(?:\b(?:effective|valid)\s+from|(?:^|\s)(?:действует\s+с|с\s+даты))\s*$/u.test(prefix)
    ? "effective_from"
    : /(?:\b(?:effective|valid)\s+(?:to|until)|(?:^|\s)(?:действует\s+до|по\s+дату))\s*$/u.test(prefix)
      ? "effective_to"
      : /(?:\b(?:date|dated|on)|(?:^|\s)(?:дата|от))\s*$/u.test(prefix)
        ? "date"
        : "any";
  return Object.freeze({ field, value: atom.normalizedValue });
}

function observationMatchesDate(
  observation: KnowledgeDocumentObservationV1,
  constraint: DateConstraint
): boolean {
  if (constraint.field === "period") {
    return observation.effectiveFrom === constraint.effectiveFrom &&
      observation.effectiveTo === constraint.effectiveTo;
  }
  if (constraint.field === "date") return observation.date === constraint.value;
  if (constraint.field === "effective_from") return observation.effectiveFrom === constraint.value;
  if (constraint.field === "effective_to") return observation.effectiveTo === constraint.value;
  return observation.date === constraint.value || observation.effectiveFrom === constraint.value ||
    observation.effectiveTo === constraint.value ||
    observation.valueKind === "date" && observation.normalizedValue === constraint.value;
}

function observationMatchesLabels(input: Readonly<{
  explicitNamedTokens: readonly string[];
  explicitMetricTokens: readonly string[];
  explicitSubjectTokens: readonly string[];
  metric: string | null;
  observation: KnowledgeDocumentObservationV1;
  subject: string | null;
  unit: string | null;
}>): boolean {
  if (input.metric && canonical(input.observation.metric ?? "") !== input.metric) return false;
  if (input.subject && canonical(input.observation.subject ?? "") !== input.subject) return false;
  if (input.unit && canonical(input.observation.unit ?? "") !== input.unit) return false;
  const metricTokens = new Set(labelTokens(input.observation.metric ?? ""));
  const subjectTokens = new Set(labelTokens(input.observation.subject ?? ""));
  const namedTokens = new Set([...metricTokens, ...subjectTokens]);
  if (!input.explicitNamedTokens.every((token) => namedTokens.has(stem(canonical(token))))) return false;
  return input.explicitMetricTokens.every((token) => metricTokens.has(stem(canonical(token)))) &&
    input.explicitSubjectTokens.every((token) => subjectTokens.has(stem(canonical(token))));
}

export function assessKnowledgeObservationGroundingV1(input: Readonly<{
  claim: string;
  context: KnowledgeDocumentContextV1;
  requiredMetricTokens?: readonly string[];
  sourceVersionNumber?: number | null;
  vocabulary?: KnowledgeObservationGroundingVocabularyV1;
}>): KnowledgeObservationGroundingResultV1 {
  const context = decodeKnowledgeDocumentContext(input.context);
  if (!context) return result(false, ["invalid_context"]);
  if (context.ambiguityReasons.length > 0 || context.locator.kind === "field_ambiguous") {
    return result(false, ["ambiguous_context"]);
  }
  const parsed = parseClaimAtoms(input.claim);
  if (parsed.ambiguous) return result(false, ["ambiguous_claim"]);
  if (parsed.versions.some((version) => version.value !== input.sourceVersionNumber)) {
    return result(false, ["observation_context_mismatch"]);
  }
  if (parsed.atoms.length === 0 && parsed.versions.length > 0) return result(true, []);
  if (parsed.atoms.length === 0) return result(false, ["missing_claim_observation"]);

  const vocabulary = input.vocabulary ?? createKnowledgeObservationGroundingVocabularyV1([context]);
  const metric = oneMentionedLabel(parsed.text, vocabulary.metrics);
  const subject = oneMentionedLabel(parsed.text, vocabulary.subjects);
  const unit = oneMentionedLabel(parsed.text, vocabulary.units);
  if (metric === "ambiguous" || subject === "ambiguous" || unit === "ambiguous") {
    return result(false, ["ambiguous_claim"]);
  }
  const explicitNamedTokens = explicitNamedLabelTokens(parsed.text, parsed.atoms, vocabulary);
  const explicitMetricTokens = Object.freeze([...new Set([
    ...(metric ? [] : cueTokens(parsed.text, metricCueWords)),
    ...(input.requiredMetricTokens ?? []).map((token) => stem(canonical(token)))
  ].filter(Boolean))]);
  const explicitSubjectTokens = subject
    ? []
    : cueTokens(parsed.text, subjectCueWords);

  const observations = context.observations.map((observation, index) => ({ index, observation }))
    .filter(({ observation }) => observation.ambiguityReasons.length === 0);
  const scalars = parsed.atoms.filter((atom) => atom.kind === "scalar");
  const dates = parsed.atoms.filter((atom) => atom.kind === "date")
    .map((atom) => dateConstraint(parsed.text, atom)).concat(parsed.periods);
  const roles = roleOccurrences(parsed.text);
  const matched: number[] = [];
  for (const scalar of scalars) {
    const requiredRole = roleForAtom(scalar, scalars, roles);
    if (requiredRole === "ambiguous") return result(false, ["ambiguous_claim"]);
    const candidates = observations.filter(({ observation }) =>
      (observation.valueKind === "number" || observation.valueKind === "number_range") &&
      observation.normalizedValue === scalar.normalizedValue &&
      observation.role !== "header" && observation.role !== "metadata" &&
      (!requiredRole || observation.role === requiredRole) &&
      observationMatchesLabels({
        explicitNamedTokens,
        explicitMetricTokens,
        explicitSubjectTokens,
        metric,
        observation,
        subject,
        unit: scalar.unit ?? unit
      }) && dates.every((constraint) => observationMatchesDate(observation, constraint)));
    if (candidates.length === 0) return result(false, ["observation_context_mismatch"]);
    if (candidates.length > 1) return result(false, ["observation_not_unique"]);
    matched.push(candidates[0]!.index);
  }

  if (scalars.length === 0) {
    const requiredRole = roleForAtom(parsed.atoms[0]!, parsed.atoms, roles);
    if (requiredRole === "ambiguous") return result(false, ["ambiguous_claim"]);
    let candidates = observations.filter(({ observation }) =>
      (!requiredRole || observation.role === requiredRole) &&
      observationMatchesLabels({
        explicitNamedTokens,
        explicitMetricTokens,
        explicitSubjectTokens,
        metric,
        observation,
        subject,
        unit: parsed.atoms[0]?.unit ?? unit
      }) && dates.every((constraint) => observationMatchesDate(observation, constraint)));
    const directDates = candidates.filter(({ observation }) => observation.valueKind === "date" &&
      dates.some((constraint) => constraint.field !== "period" &&
        observation.normalizedValue === constraint.value));
    if (!requiredRole && directDates.length > 0) candidates = directDates;
    if (candidates.length === 0) return result(false, ["observation_context_mismatch"]);
    if (candidates.length > 1) return result(false, ["observation_not_unique"]);
    matched.push(candidates[0]!.index);
  }
  return result(true, [], matched);
}
