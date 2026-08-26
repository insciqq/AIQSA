import type {
  MemorySemanticTemporalPerspective,
  MemoryTemporalNormalization,
  MemoryTemporalPointNormalization
} from "../extraction/contract";
import { parseMemoryLocalDate, parseMemoryLocalTime } from "./format";

export const MEMORY_TEMPORAL_RESOLVER_VERSION =
  "memory-temporal-resolution-v3";

export type MemoryTemporalProposal = Readonly<{
  expirationIntent: "EXPLICIT" | "NONE" | "UNKNOWN";
  normalization: MemoryTemporalNormalization;
  perspective: MemorySemanticTemporalPerspective;
  rawExpression: string | null;
}>;

export type ResolvedMemoryTemporal = Readonly<{
  expectedAt: string | null;
  expiresAt: string | null;
  occurredAt: string | null;
  rawExpression: string | null;
  resolutionEvidence: Readonly<Record<string, unknown>> | null;
  validFrom: string | null;
  validTo: string | null;
}>;

type DateParts = Readonly<{
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}>;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  });
  formatterCache.set(timeZone, created);
  return created;
}

function localParts(date: Date, timeZone: string): DateParts {
  const values = Object.fromEntries(
    formatter(timeZone).formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)])
  );
  const parts = {
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    month: values.month,
    second: values.second,
    year: values.year
  };
  if (Object.values(parts).some((value) => !Number.isInteger(value))) {
    throw new Error("memory_fact_temporal_invalid");
  }
  return parts as DateParts;
}

function zonedInstant(parts: DateParts, timeZone: string): Date {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  let guess = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = localParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const next = guess + (desired - actualAsUtc);
    if (next === guess) break;
    guess = next;
  }
  const result = new Date(guess);
  const verified = localParts(result, timeZone);
  if ((Object.keys(parts) as Array<keyof DateParts>).some((key) =>
    verified[key] !== parts[key])) {
    throw new Error("memory_fact_temporal_invalid");
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addCalendar(
  date: Date,
  amount: number,
  unit: "DAY" | "WEEK" | "MONTH" | "YEAR",
  timeZone: string
): Date {
  const current = localParts(date, timeZone);
  if (unit === "DAY" || unit === "WEEK") {
    const shifted = new Date(Date.UTC(
      current.year,
      current.month - 1,
      current.day + amount * (unit === "WEEK" ? 7 : 1),
      current.hour,
      current.minute,
      current.second
    ));
    return zonedInstant({
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      month: shifted.getUTCMonth() + 1,
      second: shifted.getUTCSeconds(),
      year: shifted.getUTCFullYear()
    }, timeZone);
  }
  const absoluteMonth = current.year * 12 + current.month - 1 +
    (unit === "MONTH" ? amount : amount * 12);
  const year = Math.floor(absoluteMonth / 12);
  const month = ((absoluteMonth % 12) + 12) % 12 + 1;
  return zonedInstant({
    ...current,
    day: Math.min(current.day, daysInMonth(year, month)),
    month,
    year
  }, timeZone);
}

function pointInstant(
  normalization: MemoryTemporalPointNormalization,
  observedAt: Date,
  sourceTimeZone: string
): Date | null {
  if (normalization.kind === "NONE") return null;
  if (normalization.kind === "ABSOLUTE") {
    const date = parseMemoryLocalDate(normalization.localDate);
    const time = parseMemoryLocalTime(normalization.localTime);
    const zone = normalization.zone ?? sourceTimeZone;
    if (!date || !time) throw new Error("memory_fact_temporal_invalid");
    formatter(zone);
    return zonedInstant({ ...date, ...time }, zone);
  }
  if (normalization.kind === "CALENDAR_OFFSET") {
    if (!Number.isSafeInteger(normalization.amount) ||
      normalization.amount < -10_000 || normalization.amount > 10_000) {
      throw new Error("memory_fact_temporal_invalid");
    }
    return addCalendar(
      observedAt,
      normalization.amount,
      normalization.unit,
      sourceTimeZone
    );
  }
  if (!Number.isSafeInteger(normalization.weekday) ||
    normalization.weekday < 1 || normalization.weekday > 7) {
    throw new Error("memory_fact_temporal_invalid");
  }
  const current = localParts(observedAt, sourceTimeZone);
  const currentWeekday = new Date(Date.UTC(
    current.year,
    current.month - 1,
    current.day
  )).getUTCDay() || 7;
  const delta = normalization.direction === "CURRENT"
    ? normalization.weekday - currentWeekday
    : normalization.direction === "NEXT"
      ? (normalization.weekday - currentWeekday + 7) % 7 || 7
      : -((currentWeekday - normalization.weekday + 7) % 7 || 7);
  const start = zonedInstant({ ...current, hour: 0, minute: 0, second: 0 }, sourceTimeZone);
  return addCalendar(start, delta, "DAY", sourceTimeZone);
}

function unresolved(
  proposal: MemoryTemporalProposal,
  resolution: "NONE" | "INVALID"
): ResolvedMemoryTemporal {
  return {
    expectedAt: null,
    expiresAt: null,
    occurredAt: null,
    rawExpression: proposal.rawExpression,
    resolutionEvidence: proposal.normalization.kind === "NONE" &&
      proposal.expirationIntent === "NONE"
      ? null
      : {
          resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
          resolution
        },
    validFrom: null,
    validTo: null
  };
}

/** Resolves only language-independent calendar operations. Invalid optional
 * temporal metadata degrades to null; callers reject when a safe TTL is a
 * prerequisite for candidate eligibility. */
export function resolveMemoryTemporal(input: Readonly<{
  observedAt: Date;
  proposal: MemoryTemporalProposal;
  timeZone: string;
}>): ResolvedMemoryTemporal {
  if (!Number.isFinite(input.observedAt.getTime())) {
    return unresolved(input.proposal, "INVALID");
  }
  try {
    formatter(input.timeZone);
    if (input.proposal.normalization.kind === "NONE") {
      return unresolved(input.proposal, "NONE");
    }
    let occurredAt: Date | null = null;
    let expectedAt: Date | null = null;
    let expiresAt: Date | null = null;
    let validFrom: Date | null = null;
    let validTo: Date | null = null;

    if (input.proposal.normalization.kind === "INTERVAL") {
      validFrom = pointInstant(
        input.proposal.normalization.start,
        input.observedAt,
        input.timeZone
      );
      validTo = pointInstant(
        input.proposal.normalization.end,
        input.observedAt,
        input.timeZone
      );
      if (!validFrom || !validTo || validTo <= validFrom) {
        throw new Error("memory_fact_temporal_invalid");
      }
      if (input.proposal.expirationIntent === "EXPLICIT") expiresAt = validTo;
    } else {
      const point = pointInstant(
        input.proposal.normalization,
        input.observedAt,
        input.timeZone
      );
      if (!point) throw new Error("memory_fact_temporal_invalid");
      if (input.proposal.expirationIntent === "EXPLICIT") {
        expiresAt = point;
      } else if (input.proposal.perspective === "FUTURE") {
        expectedAt = point;
      } else if (input.proposal.perspective === "FORMER" ||
        input.proposal.perspective === "EVENT") {
        occurredAt = point;
      } else {
        validFrom = point;
      }
    }
    if (expiresAt !== null && expiresAt <= input.observedAt) {
      throw new Error("memory_fact_temporal_invalid");
    }
    return {
      expectedAt: expectedAt?.toISOString() ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      occurredAt: occurredAt?.toISOString() ?? null,
      rawExpression: input.proposal.rawExpression,
      resolutionEvidence: {
        expirationIntent: input.proposal.expirationIntent,
        normalizationKind: input.proposal.normalization.kind,
        perspective: input.proposal.perspective,
        resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
        timeZone: input.timeZone
      },
      validFrom: validFrom?.toISOString() ?? null,
      validTo: validTo?.toISOString() ?? null
    };
  } catch {
    return unresolved(input.proposal, "INVALID");
  }
}
