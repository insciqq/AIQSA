import {
  addMemoryCalendar,
  canonicalMemoryTimeZone,
  memoryDaysInMonth,
  memoryIsoWeekday,
  memoryLocalDateTimeParts,
  memoryLocalDayStart,
  memoryZonedInstant,
  type MemoryCalendarUnit
} from "../temporal/calendar";

export const MEMORY_TEMPORAL_QUERY_PARSER_VERSION =
  "memory-temporal-query-parser-v1";
export const MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS = 8;

export const MEMORY_TEMPORAL_QUERY_EXPRESSION_TYPES = [
  "AFTER",
  "AGO",
  "BEFORE",
  "EXPLICIT_DATE",
  "NAMED_DAY",
  "NAMED_MONTH",
  "RANGE",
  "RELATIVE_DAY",
  "RELATIVE_PERIOD",
  "SINCE"
] as const;

export type MemoryTemporalQueryExpressionType =
  (typeof MEMORY_TEMPORAL_QUERY_EXPRESSION_TYPES)[number];
export type MemoryTemporalQueryConfidence = "HIGH" | "MEDIUM";
export type MemoryTemporalQueryParserState =
  | "AMBIGUOUS"
  | "INVALID"
  | "MATCHED"
  | "NO_MATCH";

export type MemoryTemporalQueryInterval = Readonly<{
  from: Date | null;
  /** Exclusive upper bound. */
  to: Date | null;
}>;

export type MemoryTemporalQueryParseResult = Readonly<{
  confidence: MemoryTemporalQueryConfidence | null;
  expressionType: MemoryTemporalQueryExpressionType | null;
  interval: MemoryTemporalQueryInterval | null;
  matchedExpressionCount: number;
  parserVersion: string;
  state: MemoryTemporalQueryParserState;
}>;

type Candidate = Readonly<{
  confidence: MemoryTemporalQueryConfidence;
  end: number;
  expressionType: MemoryTemporalQueryExpressionType;
  interval: MemoryTemporalQueryInterval;
  start: number;
}>;

const englishMonths = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
] as const;

const russianMonthForms: readonly (readonly string[])[] = [
  ["январь", "января", "январе"],
  ["февраль", "февраля", "феврале"],
  ["март", "марта", "марте"],
  ["апрель", "апреля", "апреле"],
  ["май", "мая", "мае"],
  ["июнь", "июня", "июне"],
  ["июль", "июля", "июле"],
  ["август", "августа", "августе"],
  ["сентябрь", "сентября", "сентябре"],
  ["октябрь", "октября", "октябре"],
  ["ноябрь", "ноября", "ноябре"],
  ["декабрь", "декабря", "декабре"]
];

const monthByName = new Map<string, number>([
  ...englishMonths.map((name, index) => [name, index + 1] as const),
  ...russianMonthForms.flatMap((forms, index) =>
    forms.map((name) => [name, index + 1] as const))
]);

const monthNamesPattern = [...monthByName.keys()]
  .sort((left, right) => right.length - left.length)
  .join("|");

const temporalHintPattern = new RegExp(
  `(?:today|yesterday|tomorrow|week|month|year|ago|before|after|since|between|` +
  `сегодня|вчера|завтра|недел|месяц|г(?:од|ода)|лет|назад|до|после|между|` +
  `${monthNamesPattern}|\\d{1,4}[./-]\\d{1,2})`,
  "iu"
);

function empty(
  state: Exclude<MemoryTemporalQueryParserState, "MATCHED">,
  matchedExpressionCount = 0
): MemoryTemporalQueryParseResult {
  return Object.freeze({
    confidence: null,
    expressionType: null,
    interval: null,
    matchedExpressionCount: Math.min(
      matchedExpressionCount,
      MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS
    ),
    parserVersion: MEMORY_TEMPORAL_QUERY_PARSER_VERSION,
    state
  });
}

function matched(candidate: Candidate, matchedExpressionCount = 1): MemoryTemporalQueryParseResult {
  return Object.freeze({
    confidence: candidate.confidence,
    expressionType: candidate.expressionType,
    interval: Object.freeze({
      from: candidate.interval.from,
      to: candidate.interval.to
    }),
    matchedExpressionCount: Math.min(
      matchedExpressionCount,
      MEMORY_TEMPORAL_QUERY_MAX_MATCHED_EXPRESSIONS
    ),
    parserVersion: MEMORY_TEMPORAL_QUERY_PARSER_VERSION,
    state: "MATCHED" as const
  });
}

function localDateInterval(
  year: number,
  month: number,
  day: number,
  timeZone: string
): MemoryTemporalQueryInterval {
  const from = memoryZonedInstant({
    day,
    hour: 0,
    minute: 0,
    month,
    second: 0,
    year
  }, timeZone);
  return { from, to: addMemoryCalendar(from, 1, "DAY", timeZone) };
}

function monthInterval(
  year: number,
  month: number,
  timeZone: string
): MemoryTemporalQueryInterval {
  const from = memoryZonedInstant({
    day: 1,
    hour: 0,
    minute: 0,
    month,
    second: 0,
    year
  }, timeZone);
  return { from, to: addMemoryCalendar(from, 1, "MONTH", timeZone) };
}

function yearInterval(year: number, timeZone: string): MemoryTemporalQueryInterval {
  const from = memoryZonedInstant({
    day: 1,
    hour: 0,
    minute: 0,
    month: 1,
    second: 0,
    year
  }, timeZone);
  return { from, to: addMemoryCalendar(from, 1, "YEAR", timeZone) };
}

function periodInterval(
  now: Date,
  direction: -1 | 0 | 1,
  unit: Exclude<MemoryCalendarUnit, "DAY">,
  timeZone: string
): MemoryTemporalQueryInterval {
  const local = memoryLocalDateTimeParts(now, timeZone);
  if (unit === "WEEK") {
    const dayStart = memoryLocalDayStart(now, timeZone);
    const weekday = memoryIsoWeekday(local.year, local.month, local.day);
    const thisWeek = addMemoryCalendar(dayStart, 1 - weekday, "DAY", timeZone);
    const from = addMemoryCalendar(thisWeek, direction, "WEEK", timeZone);
    return { from, to: addMemoryCalendar(from, 1, "WEEK", timeZone) };
  }
  if (unit === "MONTH") {
    const current = monthInterval(local.year, local.month, timeZone).from!;
    const from = addMemoryCalendar(current, direction, "MONTH", timeZone);
    return { from, to: addMemoryCalendar(from, 1, "MONTH", timeZone) };
  }
  const current = yearInterval(local.year, timeZone).from!;
  const from = addMemoryCalendar(current, direction, "YEAR", timeZone);
  return { from, to: addMemoryCalendar(from, 1, "YEAR", timeZone) };
}

function agoInterval(
  now: Date,
  amount: number,
  unit: MemoryCalendarUnit,
  timeZone: string
): MemoryTemporalQueryInterval {
  if (unit === "DAY") {
    const today = memoryLocalDayStart(now, timeZone);
    const from = addMemoryCalendar(today, -amount, "DAY", timeZone);
    return { from, to: addMemoryCalendar(from, 1, "DAY", timeZone) };
  }
  const current = periodInterval(now, 0, unit, timeZone).from!;
  const from = addMemoryCalendar(current, -amount, unit, timeZone);
  return { from, to: addMemoryCalendar(from, 1, unit, timeZone) };
}

function pushMatches(
  candidates: Candidate[],
  query: string,
  pattern: RegExp,
  create: (match: RegExpExecArray) => Omit<Candidate, "end" | "start"> | null
): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    const leading = match[1] ?? "";
    const value = create(match);
    if (value) {
      const start = match.index + leading.length;
      candidates.push({ ...value, end: match.index + match[0].length, start });
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
}

function unitFor(value: string): MemoryCalendarUnit | null {
  if (/^(?:day|days|день|дня|дней)$/iu.test(value)) return "DAY";
  if (/^(?:week|weeks|неделю|недели|недель)$/iu.test(value)) return "WEEK";
  if (/^(?:month|months|месяц|месяца|месяцев)$/iu.test(value)) return "MONTH";
  if (/^(?:year|years|год|года|лет)$/iu.test(value)) return "YEAR";
  return null;
}

function basicCandidates(query: string, now: Date, timeZone: string): Candidate[] {
  const candidates: Candidate[] = [];
  const boundaryStart = "(^|[^\\p{L}\\p{N}_])";
  const boundaryEnd = "(?=$|[^\\p{L}\\p{N}_])";

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(today|yesterday|tomorrow|сегодня|вчера|завтра)${boundaryEnd}`,
    "giu"
  ), (match) => {
    const day = match[2]!.toLocaleLowerCase("und");
    const offset = day === "yesterday" || day === "вчера"
      ? -1
      : day === "tomorrow" || day === "завтра" ? 1 : 0;
    const from = addMemoryCalendar(memoryLocalDayStart(now, timeZone), offset, "DAY", timeZone);
    return {
      confidence: "HIGH",
      expressionType: "RELATIVE_DAY",
      interval: { from, to: addMemoryCalendar(from, 1, "DAY", timeZone) }
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(this|last|next)\\s+(week|month|year)${boundaryEnd}`,
    "giu"
  ), (match) => {
    const direction = match[2]!.toLocaleLowerCase("und") === "last"
      ? -1
      : match[2]!.toLocaleLowerCase("und") === "next" ? 1 : 0;
    return {
      confidence: "HIGH",
      expressionType: "RELATIVE_PERIOD",
      interval: periodInterval(now, direction, match[3]!.toUpperCase() as
        Exclude<MemoryCalendarUnit, "DAY">, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(?:в\\s+|на\\s+)?` +
    `(эт(?:а|ой|у|от)|текущ(?:ая|ей|ую|ий|ем)|прошл(?:ая|ой|ую|ый|ом)|` +
    `следующ(?:ая|ей|ую|ий|ем))\\s+` +
    `(недел(?:я|е|ю)|месяц(?:е)?|год(?:у)?)${boundaryEnd}`,
    "giu"
  ), (match) => {
    const directionWord = match[2]!.toLocaleLowerCase("und");
    const direction = directionWord.startsWith("прошл")
      ? -1
      : directionWord.startsWith("следующ") ? 1 : 0;
    const unitWord = match[3]!.toLocaleLowerCase("und");
    const unit = unitWord.startsWith("недел") ? "WEEK"
      : unitWord.startsWith("месяц") ? "MONTH" : "YEAR";
    return {
      confidence: "HIGH",
      expressionType: "RELATIVE_PERIOD",
      interval: periodInterval(now, direction, unit, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(\\d{1,4})\\s+` +
    `(days?|weeks?|months?|years?|день|дня|дней|неделю|недели|недель|` +
    `месяц|месяца|месяцев|год|года|лет)\\s+(?:ago|назад)${boundaryEnd}`,
    "giu"
  ), (match) => {
    const amount = Number(match[2]);
    const unit = unitFor(match[3]!);
    if (!unit || !Number.isSafeInteger(amount) || amount < 0 || amount > 10_000) return null;
    return {
      confidence: "HIGH",
      expressionType: "AGO",
      interval: agoInterval(now, amount, unit, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(?:in\\s+|в\\s+)?(${monthNamesPattern})\\s+(\\d{4})${boundaryEnd}`,
    "giu"
  ), (match) => {
    const month = monthByName.get(match[2]!.toLocaleLowerCase("und"));
    const year = Number(match[3]);
    if (!month || year < 1 || year > 9999) return null;
    return {
      confidence: "HIGH",
      expressionType: "NAMED_MONTH",
      interval: monthInterval(year, month, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(?:on\\s+)?(${monthNamesPattern})\\s+(\\d{1,2})` +
    `(?:,\\s*|\\s+)(\\d{4})${boundaryEnd}`,
    "giu"
  ), (match) => {
    const month = monthByName.get(match[2]!.toLocaleLowerCase("und"));
    const day = Number(match[3]);
    const year = Number(match[4]);
    if (!month || year < 1 || year > 9999 || day < 1 ||
      day > memoryDaysInMonth(year, month)) return null;
    return {
      confidence: "HIGH",
      expressionType: "EXPLICIT_DATE",
      interval: localDateInterval(year, month, day, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(\\d{1,2})\\s+(${monthNamesPattern})\\s+(\\d{4})${boundaryEnd}`,
    "giu"
  ), (match) => {
    const day = Number(match[2]);
    const month = monthByName.get(match[3]!.toLocaleLowerCase("und"));
    const year = Number(match[4]);
    if (!month || year < 1 || year > 9999 || day < 1 ||
      day > memoryDaysInMonth(year, month)) return null;
    return {
      confidence: "HIGH",
      expressionType: "EXPLICIT_DATE",
      interval: localDateInterval(year, month, day, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(?:on\\s+)?(${monthNamesPattern})\\s+(\\d{1,2})` +
    `(?!\\s*(?:,\\s*)?\\d)${boundaryEnd}`,
    "giu"
  ), (match) => {
    const month = monthByName.get(match[2]!.toLocaleLowerCase("und"));
    const day = Number(match[3]);
    const year = memoryLocalDateTimeParts(now, timeZone).year;
    if (!month || day < 1 || day > memoryDaysInMonth(year, month)) return null;
    return {
      confidence: "MEDIUM",
      expressionType: "NAMED_DAY",
      interval: localDateInterval(year, month, day, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(\\d{1,2})\\s+(${monthNamesPattern})` +
    `(?!\\s*(?:,\\s*)?\\d)${boundaryEnd}`,
    "giu"
  ), (match) => {
    const day = Number(match[2]);
    const month = monthByName.get(match[3]!.toLocaleLowerCase("und"));
    const year = memoryLocalDateTimeParts(now, timeZone).year;
    if (!month || day < 1 || day > memoryDaysInMonth(year, month)) return null;
    return {
      confidence: "MEDIUM",
      expressionType: "NAMED_DAY",
      interval: localDateInterval(year, month, day, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(\\d{4})-(\\d{2})-(\\d{2})${boundaryEnd}`,
    "gu"
  ), (match) => {
    const year = Number(match[2]);
    const month = Number(match[3]);
    const day = Number(match[4]);
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 ||
      day > memoryDaysInMonth(year, month)) return null;
    return {
      confidence: "HIGH",
      expressionType: "EXPLICIT_DATE",
      interval: localDateInterval(year, month, day, timeZone)
    };
  });

  pushMatches(candidates, query, new RegExp(
    `${boundaryStart}(\\d{1,2})([./-])(\\d{1,2})\\3(\\d{4})${boundaryEnd}`,
    "gu"
  ), (match) => {
    const first = Number(match[2]);
    const second = Number(match[4]);
    const year = Number(match[5]);
    if (first <= 12 && second <= 12) return null;
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    if (month < 1 || month > 12 || day < 1 || day > memoryDaysInMonth(year, month)) return null;
    return {
      confidence: "HIGH",
      expressionType: "EXPLICIT_DATE",
      interval: localDateInterval(year, month, day, timeZone)
    };
  });

  return candidates;
}

function intervalKey(interval: MemoryTemporalQueryInterval): string {
  return `${interval.from?.getTime() ?? "open"}:${interval.to?.getTime() ?? "open"}`;
}

function nonOverlappingCandidates(candidates: readonly Candidate[]): readonly Candidate[] {
  const selected: Candidate[] = [];
  for (const candidate of [...candidates].sort((left, right) =>
    left.start - right.start || (right.end - right.start) - (left.end - left.start))) {
    if (selected.some((other) => candidate.start < other.end && candidate.end > other.start)) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

function candidateAtStart(fragment: string, now: Date, timeZone: string): Candidate | null {
  const leading = fragment.length - fragment.trimStart().length;
  const candidates = basicCandidates(fragment, now, timeZone)
    .filter((candidate) => candidate.start === leading)
    .sort((left, right) => right.end - left.end);
  return candidates[0] ?? null;
}

function rangeCandidate(query: string, now: Date, timeZone: string): Candidate | null {
  const patterns = [
    /(?:^|[^\p{L}\p{N}_])(between|между)\s+(.+?)\s+(?:and|и)\s+(.+)/iu,
    /(?:^|[^\p{L}\p{N}_])(с)\s+(.+?)\s+по\s+(.+)/iu
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(query);
    if (!match || match.index === undefined) continue;
    const left = candidateAtStart(match[2]!, now, timeZone);
    const right = candidateAtStart(match[3]!, now, timeZone);
    if (!left || !right || !left.interval.from || !right.interval.to) continue;
    if (right.interval.to <= left.interval.from) {
      return {
        confidence: "HIGH",
        end: match.index + match[0].length,
        expressionType: "RANGE",
        interval: { from: left.interval.from, to: right.interval.to },
        start: match.index
      };
    }
    return {
      confidence: left.confidence === "HIGH" && right.confidence === "HIGH"
        ? "HIGH" : "MEDIUM",
      end: match.index + match[0].length,
      expressionType: "RANGE",
      interval: { from: left.interval.from, to: right.interval.to },
      start: match.index
    };
  }
  return null;
}

function boundaryCandidate(query: string, now: Date, timeZone: string): Candidate | null {
  const pattern = /(?:^|[^\p{L}\p{N}_])(before|after|since|до|после|с)\s+(.+)/iu;
  const match = pattern.exec(query);
  if (!match || match.index === undefined) return null;
  const endpoint = candidateAtStart(match[2]!, now, timeZone);
  if (!endpoint) return null;
  const operator = match[1]!.toLocaleLowerCase("und");
  const expressionType = operator === "before" || operator === "до"
    ? "BEFORE" as const
    : operator === "since" || operator === "с" ? "SINCE" as const : "AFTER" as const;
  const interval = expressionType === "BEFORE"
    ? { from: null, to: endpoint.interval.from }
    : expressionType === "SINCE"
      ? { from: endpoint.interval.from, to: null }
      : { from: endpoint.interval.to, to: null };
  if (interval.from === null && interval.to === null) return null;
  return {
    confidence: endpoint.confidence,
    end: match.index + match[0].length,
    expressionType,
    interval,
    start: match.index
  };
}

function numericLocalDateFailureState(query: string): "AMBIGUOUS" | "INVALID" | null {
  const pattern = /(?:^|[^\d])(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?=$|[^\d])/gu;
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    const first = Number(match[1]);
    const second = Number(match[3]);
    const year = Number(match[4]);
    if (first < 1 || second < 1 || year < 1 || year > 9999) return "INVALID";
    if (first <= 12 && second <= 12) return "AMBIGUOUS";
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    if (month < 1 || month > 12 || day > memoryDaysInMonth(year, month)) {
      return "INVALID";
    }
  }
  return null;
}

/**
 * Parses a deliberately bounded EN/RU calendar subset. It never emits query
 * text or infers an interval from an ambiguous local numeric date.
 */
export function parseMemoryTemporalQuery(input: Readonly<{
  now: Date;
  query: string;
  timeZone: string;
}>): MemoryTemporalQueryParseResult {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
    typeof input.query !== "string" || input.query.length > 2_000) {
    return empty("INVALID");
  }
  const query = input.query.normalize("NFKC");
  const timeZone = canonicalMemoryTimeZone(input.timeZone);
  if (!timeZone) return empty("INVALID");
  try {
    const range = rangeCandidate(query, input.now, timeZone);
    if (range) {
      if (range.interval.from && range.interval.to && range.interval.from >= range.interval.to) {
        return empty("INVALID", 2);
      }
      return matched(range, 2);
    }
    const boundary = boundaryCandidate(query, input.now, timeZone);
    if (boundary) return matched(boundary);
    const candidates = nonOverlappingCandidates(basicCandidates(query, input.now, timeZone));
    if (candidates.length === 0) {
      const numericFailure = numericLocalDateFailureState(query);
      return empty(numericFailure ??
        (temporalHintPattern.test(query) ? "INVALID" : "NO_MATCH"),
      numericFailure ? 1 : 0);
    }
    const distinctIntervals = new Set(candidates.map(({ interval }) => intervalKey(interval)));
    if (distinctIntervals.size > 1) return empty("AMBIGUOUS", candidates.length);
    return matched(candidates[0]!, candidates.length);
  } catch {
    return empty("INVALID");
  }
}
