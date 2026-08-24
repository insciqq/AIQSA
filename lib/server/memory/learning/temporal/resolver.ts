export const MEMORY_TEMPORAL_RESOLVER_VERSION =
  "memory-temporal-resolution-v2";

export type MemoryTemporalProposal = Readonly<{
  expectedAt: string | null;
  expiresAt: string | null;
  occurredAt: string | null;
  rawExpression: string | null;
  validFrom: string | null;
  validTo: string | null;
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

export class MemoryTemporalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryTemporalError";
  }
}

type DateParts = Readonly<{
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}>;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const explicitExpiry = /(?:\bremember(?:\s+[\p{L}\p{N}_-]+){0,8}\s+(?:until|for)\b|\bexpire(?:s)?\s+(?:on|at|in)\b|\bforget(?:\s+[\p{L}\p{N}_-]+){0,8}\s+(?:on|at|in)\b|(?:^|[^\p{L}])запомни(?:ть)?(?:\s+[\p{L}\p{N}_-]+){0,8}\s+(?:до|на)(?:$|[^\p{L}])|(?:^|[^\p{L}])удали(?:ть)?\s+из\s+памяти\s+(?:в|до)(?:$|[^\p{L}]))/iu;

function invalid(code = "memory_fact_temporal_invalid"): never {
  throw new MemoryTemporalError(code);
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric"
    });
  } catch {
    invalid();
  }
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
  if (Object.values(parts).some((value) => !Number.isInteger(value))) invalid();
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
  if (Object.keys(parts).some((key) =>
    verified[key as keyof DateParts] !== parts[key as keyof DateParts])) invalid();
  return result;
}

function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const parts = localParts(date, timeZone);
  const shifted = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + days,
    parts.hour,
    parts.minute,
    parts.second
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

function localDayStart(date: Date, dayOffset: number, timeZone: string): Date {
  const parts = localParts(date, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return zonedInstant({
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    month: shifted.getUTCMonth() + 1,
    second: 0,
    year: shifted.getUTCFullYear()
  }, timeZone);
}

function parseInstant(value: string | null, observedAt: Date): Date | null {
  if (value === null) return null;
  if (!isoInstant.test(value)) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) ||
    Math.abs(parsed.getTime() - observedAt.getTime()) > 100 * 366 * 86_400_000) {
    invalid();
  }
  return parsed;
}

function exactExpression(sourceText: string, raw: string | null): string | null {
  if (raw === null) return null;
  if (!raw || raw.length > 512 || raw.trim() !== raw ||
    !sourceText.includes(raw) || raw.includes("\u0000")) invalid();
  return raw;
}

function explicitDateExpiry(
  sourceText: string,
  observedAt: Date,
  timeZone: string
): Date | null {
  if (!explicitExpiry.test(sourceText)) return null;
  const dateMatch = sourceText.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/u);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const start = zonedInstant({ day, hour: 0, minute: 0, month, second: 0, year }, timeZone);
    // Date-only "until" is inclusive in the user's local calendar.
    return localDayStart(start, 1, timeZone);
  }
  const daysMatch = sourceText.match(
    /(?:\bfor\s+(\d{1,3})\s+days?\b|(?:^|[^\p{L}])на\s+(\d{1,3})\s+д(?:ень|ня|ней)(?:$|[^\p{L}]))/iu
  );
  if (daysMatch) return addLocalDays(observedAt, Number(daysMatch[1] ?? daysMatch[2]), timeZone);
  const weekdayNames: Readonly<Record<string, number>> = Object.freeze({
    friday: 5,
    monday: 1,
    saturday: 6,
    sunday: 0,
    thursday: 4,
    tuesday: 2,
    wednesday: 3,
    воскресенья: 0,
    вторника: 2,
    пятницы: 5,
    понедельника: 1,
    среды: 3,
    субботы: 6,
    четверга: 4
  });
  const lowered = sourceText.toLocaleLowerCase("und");
  const weekday = Object.entries(weekdayNames).find(([name]) =>
    new RegExp(`(?:^|[^\\p{L}])${name}(?:$|[^\\p{L}])`, "u").test(lowered));
  if (!weekday) return null;
  const current = localParts(observedAt, timeZone);
  const currentWeekday = new Date(Date.UTC(
    current.year,
    current.month - 1,
    current.day
  )).getUTCDay();
  const delta = (weekday[1] - currentWeekday + 7) % 7 || 7;
  return localDayStart(observedAt, delta + 1, timeZone);
}

function deterministicRelative(
  raw: string | null,
  observedAt: Date,
  timeZone: string
): Readonly<{ expectedAt: Date | null; occurredAt: Date | null }> {
  if (!raw) return { expectedAt: null, occurredAt: null };
  const value = raw.toLocaleLowerCase("und");
  if (/(?:\byesterday\b|(?:^|[^\p{L}])вчера(?:$|[^\p{L}]))/u.test(value)) {
    return { expectedAt: null, occurredAt: localDayStart(observedAt, -1, timeZone) };
  }
  if (/(?:\btomorrow\b|(?:^|[^\p{L}])завтра(?:$|[^\p{L}]))/u.test(value)) {
    return { expectedAt: localDayStart(observedAt, 1, timeZone), occurredAt: null };
  }
  if (/(?:\btoday\b|(?:^|[^\p{L}])сегодня(?:$|[^\p{L}]))/u.test(value)) {
    return { expectedAt: null, occurredAt: localDayStart(observedAt, 0, timeZone) };
  }
  const ago = value.match(/(?:\b(\d{1,3})\s+days?\s+ago\b|(?:^|[^\p{L}])(\d{1,3})\s+д(?:ень|ня|ней)\s+назад(?:$|[^\p{L}]))/u);
  if (ago) {
    return {
      expectedAt: null,
      occurredAt: addLocalDays(observedAt, -Number(ago[1] ?? ago[2]), timeZone)
    };
  }
  const future = value.match(/(?:\bin\s+(\d{1,3})\s+days?\b|(?:^|[^\p{L}])через\s+(\d{1,3})\s+д(?:ень|ня|ней)(?:$|[^\p{L}]))/u);
  if (future) {
    return {
      expectedAt: addLocalDays(observedAt, Number(future[1] ?? future[2]), timeZone),
      occurredAt: null
    };
  }
  return { expectedAt: null, occurredAt: null };
}

export function resolveMemoryTemporal(input: Readonly<{
  observedAt: Date;
  proposal: MemoryTemporalProposal;
  sourceText: string;
  timeZone: string;
}>): ResolvedMemoryTemporal {
  if (!Number.isFinite(input.observedAt.getTime())) invalid();
  formatter(input.timeZone);
  const rawExpression = exactExpression(input.sourceText, input.proposal.rawExpression);
  let occurredAt = parseInstant(input.proposal.occurredAt, input.observedAt);
  let expectedAt = parseInstant(input.proposal.expectedAt, input.observedAt);
  const validFrom = parseInstant(input.proposal.validFrom, input.observedAt);
  const validTo = parseInstant(input.proposal.validTo, input.observedAt);
  let expiresAt = parseInstant(input.proposal.expiresAt, input.observedAt);
  const hasTemporalProposal = [occurredAt, expectedAt, validFrom, validTo, expiresAt]
    .some((value) => value !== null);
  if (hasTemporalProposal && rawExpression === null) invalid();

  const relative = deterministicRelative(rawExpression, input.observedAt, input.timeZone);
  if (occurredAt !== null && relative.occurredAt !== null &&
    Math.abs(occurredAt.getTime() - relative.occurredAt.getTime()) > 1_000) {
    invalid("memory_fact_temporal_conflict");
  }
  if (expectedAt !== null && relative.expectedAt !== null &&
    Math.abs(expectedAt.getTime() - relative.expectedAt.getTime()) > 1_000) {
    invalid("memory_fact_temporal_conflict");
  }
  occurredAt ??= relative.occurredAt;
  expectedAt ??= relative.expectedAt;

  const deterministicExpiry = explicitDateExpiry(
    input.sourceText,
    input.observedAt,
    input.timeZone
  );
  if (deterministicExpiry !== null && rawExpression === null) {
    invalid("memory_fact_expiration_expression_missing");
  }
  if (expiresAt !== null && !explicitExpiry.test(input.sourceText)) {
    invalid("memory_fact_expiration_not_explicit");
  }
  if (expiresAt !== null && deterministicExpiry !== null &&
    Math.abs(expiresAt.getTime() - deterministicExpiry.getTime()) > 1_000) {
    invalid("memory_fact_expiration_conflict");
  }
  expiresAt ??= deterministicExpiry;
  if (expiresAt !== null && expiresAt <= input.observedAt) {
    invalid("memory_fact_expired_at_observation");
  }
  if (validFrom !== null && validTo !== null && validTo <= validFrom) invalid();
  if (occurredAt !== null && expectedAt !== null) invalid();

  const resolved = [occurredAt, expectedAt, validFrom, validTo, expiresAt]
    .some((value) => value !== null);
  return {
    expectedAt: expectedAt?.toISOString() ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
    occurredAt: occurredAt?.toISOString() ?? null,
    rawExpression,
    resolutionEvidence: resolved
      ? {
          expiryExplicit: expiresAt !== null,
          resolverVersion: MEMORY_TEMPORAL_RESOLVER_VERSION,
          timeZone: input.timeZone
        }
      : null,
    validFrom: validFrom?.toISOString() ?? null,
    validTo: validTo?.toISOString() ?? null
  };
}
