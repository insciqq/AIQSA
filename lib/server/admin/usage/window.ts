import {
  MAX_USAGE_TIME_ZONE_LENGTH,
  type AdminUsageBucket,
  type AdminUsagePeriod
} from "@/lib/contracts/adminUsageAnalytics";
import { validScheduledTaskTimeZone } from "@/lib/domain/scheduledTaskSchedule";

/**
 * Calendar math for usage analytics. Pure: zone offsets come only from
 * `Intl.DateTimeFormat`. Bucket starts are local midnights (or local month
 * starts) resolved in the zone, never computed by adding 24 hours, so a DST
 * change yields 23- or 25-hour days. A local midnight skipped by a forward
 * transition resolves to the first instant of that local day.
 */

export type UsageLocalDate = Readonly<{ year: number; month: number; day: number }>;

/** `key` is the local calendar label the SQL emits: `YYYY-MM-DD` (day) or `YYYY-MM` (month). */
export type UsageBucketStart = Readonly<{ key: string; start: Date }>;

export type UsageTimeRange = Readonly<{ from: Date; to: Date }>;

export type UsageWindowPlan = Readonly<{
  bucket: AdminUsageBucket;
  buckets: readonly UsageBucketStart[];
  /** Inclusive; `null` only for `all` without any usage. */
  from: Date | null;
  period: AdminUsagePeriod;
  previous: UsageTimeRange | null;
  timeZone: string;
  /** Exclusive. */
  to: Date;
}>;

const DAY_MS = 86_400_000;
/** The contract's series bound. */
export const MAX_USAGE_BUCKETS = 1_000;
const ROLLING_DAYS: Partial<Record<AdminUsagePeriod, number>> = { "7d": 7, "30d": 30, "90d": 90 };
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The zone as sent when the runtime resolves it (the scheduled-task rule).
 * Offset spellings ("+03:00", "GMT+3") fail its IANA shape: PostgreSQL would
 * read them with POSIX sign inversion.
 */
export function validUsageTimeZone(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_USAGE_TIME_ZONE_LENGTH ? validScheduledTaskTimeZone(value) : null;
}

function utcMilliseconds(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      calendar: "gregory", day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit",
      numberingSystem: "latn", second: "2-digit", timeZone, year: "numeric"
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** The zone's wall clock at an instant, written as UTC milliseconds. */
function wallClock(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(whole)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return utcMilliseconds(parts.year!, parts.month!, parts.day!, parts.hour === 24 ? 0 : parts.hour!, parts.minute!,
    parts.second!, instant - whole);
}

function offsetAt(instant: number, timeZone: string): number {
  return wallClock(instant, timeZone) - instant;
}

/**
 * The instant of a wall time written as UTC milliseconds. A skipped wall time
 * keeps the offset before the transition (shifted forward by the gap); a
 * repeated wall time resolves to its earlier instant.
 */
function zonedInstant(wall: number, timeZone: string): Date {
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const matching = [wall - before, wall - after].filter((candidate) => wallClock(candidate, timeZone) === wall);
  return new Date(matching.length > 0 ? Math.min(...matching) : wall - before);
}

function localDate(wall: number): UsageLocalDate {
  const date = new Date(wall);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcMilliseconds(year, month + 1, 0)).getUTCDate();
}

function shiftMonths(date: UsageLocalDate, months: number): UsageLocalDate {
  const absolute = date.year * 12 + date.month - 1 + months;
  const year = Math.floor(absolute / 12);
  const month = absolute - year * 12 + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

function localMidnight(date: UsageLocalDate, timeZone: string): Date {
  return zonedInstant(utcMilliseconds(date.year, date.month, date.day), timeZone);
}

function monthStart(date: UsageLocalDate, timeZone: string): Date {
  return localMidnight({ ...date, day: 1 }, timeZone);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function usageDayKey(date: UsageLocalDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

export function usageMonthKey(date: Pick<UsageLocalDate, "month" | "year">): string {
  return `${pad(date.year, 4)}-${pad(date.month)}`;
}

/** The local calendar date of an instant. */
export function usageLocalDate(instant: Date, timeZone: string): UsageLocalDate {
  return localDate(wallClock(instant.getTime(), timeZone));
}

/**
 * The same local date and wall time `days` days (or `months` months, day
 * clamped to the month's length) before `instant`, never after `limit`.
 */
function sameWallClockBefore(instant: Date, timeZone: string, shift: Readonly<{ days?: number; months?: number }>, limit: Date): Date {
  const wall = wallClock(instant.getTime(), timeZone);
  const date = localDate(wall);
  const timeOfDay = wall - utcMilliseconds(date.year, date.month, date.day);
  const target = shift.months
    ? shiftMonths(date, -shift.months)
    : localDate(utcMilliseconds(date.year, date.month, date.day - (shift.days ?? 0)));
  const clampedPastMonthEnd = shift.months !== undefined && date.day > daysInMonth(target.year, target.month);
  if (clampedPastMonthEnd) return limit;
  const resolved = zonedInstant(utcMilliseconds(target.year, target.month, target.day) + timeOfDay, timeZone);
  return resolved.getTime() > limit.getTime() ? limit : resolved;
}

function bucketStarts(bucket: AdminUsageBucket, from: Date, to: Date, timeZone: string): UsageBucketStart[] {
  if (to.getTime() <= from.getTime()) return [];
  const first = usageLocalDate(from, timeZone);
  const last = usageLocalDate(new Date(to.getTime() - 1), timeZone);
  const buckets: UsageBucketStart[] = [];
  if (bucket === "day") {
    for (let cursor = first; ; cursor = localDate(utcMilliseconds(cursor.year, cursor.month, cursor.day + 1))) {
      buckets.push({ key: usageDayKey(cursor), start: localMidnight(cursor, timeZone) });
      if (buckets.length > MAX_USAGE_BUCKETS) throw new Error("usage_window_too_long");
      if (cursor.year === last.year && cursor.month === last.month && cursor.day === last.day) return buckets;
    }
  }
  for (let cursor = { ...first, day: 1 }; ; cursor = shiftMonths(cursor, 1)) {
    buckets.push({ key: usageMonthKey(cursor), start: monthStart(cursor, timeZone) });
    if (buckets.length > MAX_USAGE_BUCKETS) throw new Error("usage_window_too_long");
    if (cursor.year === last.year && cursor.month === last.month) return buckets;
  }
}

/**
 * The window, its buckets and the preceding comparable window of a period.
 * `earliestUsageAt` matters only for `all`.
 */
export function planUsageWindow(input: Readonly<{
  earliestUsageAt: Date | null;
  now: Date;
  period: AdminUsagePeriod;
  timeZone: string;
}>): UsageWindowPlan {
  const { now, period, timeZone } = input;
  const today = usageLocalDate(now, timeZone);
  const plan = (bucket: AdminUsageBucket, from: Date | null, to: Date, previous: UsageTimeRange | null): UsageWindowPlan => ({
    bucket, buckets: from ? bucketStarts(bucket, from, to, timeZone) : [], from, period, previous, timeZone, to
  });
  const rolling = ROLLING_DAYS[period];
  if (rolling !== undefined) {
    const day = (offset: number) => localMidnight(localDate(utcMilliseconds(today.year, today.month, today.day - offset)), timeZone);
    const from = day(rolling - 1);
    return plan("day", from, now, { from: day(2 * rolling - 1), to: sameWallClockBefore(now, timeZone, { days: rolling }, from) });
  }
  switch (period) {
    case "this_month": {
      const from = monthStart(today, timeZone);
      return plan("day", from, now, {
        from: monthStart(shiftMonths(today, -1), timeZone),
        to: sameWallClockBefore(now, timeZone, { months: 1 }, from)
      });
    }
    case "last_month": {
      const to = monthStart(today, timeZone);
      const from = monthStart(shiftMonths(today, -1), timeZone);
      return plan("day", from, to, { from: monthStart(shiftMonths(today, -2), timeZone), to: from });
    }
    case "12m": {
      const from = monthStart(shiftMonths(today, -11), timeZone);
      return plan("month", from, now, {
        from: monthStart(shiftMonths(today, -23), timeZone),
        to: sameWallClockBefore(now, timeZone, { months: 12 }, from)
      });
    }
    default: {
      const earliest = input.earliestUsageAt;
      if (!earliest || earliest.getTime() >= now.getTime()) return plan("month", null, now, null);
      return plan("month", monthStart(usageLocalDate(earliest, timeZone), timeZone), now, null);
    }
  }
}
