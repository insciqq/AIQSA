import {
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  SCHEDULED_TASK_WEEKDAYS,
  decodeScheduledTaskSchedule,
  isScheduledTaskTimeZoneShape,
  scheduledTaskDaysInMonth,
  type ScheduledTaskSchedule,
  type ScheduledTaskWeekday
} from "../contracts/scheduledTasks";

/**
 * Wall-clock schedule arithmetic for scheduled tasks. Client-safe: zone offsets
 * come only from `Intl.DateTimeFormat`. A local time skipped by a forward
 * transition runs at the same wall time shifted forward by the gap; a repeated
 * local time runs at its earlier instant, so each local wall time runs at most
 * once. Daily, weekly and monthly schedules yield at most one occurrence per
 * local day, so no day is skipped or run twice. Hourly slots are spaced in
 * nominal wall-clock time: slots that land on the same instant run once, and a
 * slot that a transition shifts outside its window (or its day) is skipped.
 */

export type ScheduledTaskLocalDate = Readonly<{ year: number; month: number; day: number }>;

export type ScheduledTaskScheduleValidation =
  | { ok: true; schedule: ScheduledTaskSchedule; timeZone: string }
  | { ok: false; code: "scheduled_task_schedule_invalid" | "scheduled_task_time_zone_invalid" };

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const LAST_MINUTE_OF_DAY = 1439;
/** More than a year: monthly needs at most 63 local days, weekly 8. */
const MAX_SCAN_DAYS = 400;
const ALL_DAYS_MASK = 0b1111111;
const WORKDAYS_MASK = 0b0011111;
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS: Record<ScheduledTaskWeekday, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun"
};
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The zone as written when the runtime resolves it. Spelling is kept because
 * ICU canonicalization would rename current zones (Europe/Kyiv to Europe/Kiev);
 * offset zones such as "+03:00" fail the IANA shape.
 */
export function validScheduledTaskTimeZone(value: unknown): string | null {
  if (!isScheduledTaskTimeZoneShape(value)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

export function validateScheduledTaskSchedule(schedule: unknown, timeZone: unknown): ScheduledTaskScheduleValidation {
  const decoded = decodeScheduledTaskSchedule(schedule);
  if (!decoded) return { ok: false, code: "scheduled_task_schedule_invalid" };
  const zone = validScheduledTaskTimeZone(timeZone);
  return zone ? { ok: true, schedule: decoded, timeZone: zone } : { ok: false, code: "scheduled_task_time_zone_invalid" };
}

/** "HH:MM" to the minute of the day. */
export function scheduledTaskTimeToMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}
export function scheduledTaskMinutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
/** ISO weekdays: Monday = bit 0 .. Sunday = bit 6. */
export function scheduledTaskWeekdayMask(days: readonly ScheduledTaskWeekday[]): number {
  return days.reduce((mask, day) => mask | (1 << SCHEDULED_TASK_WEEKDAYS.indexOf(day)), 0);
}
export function scheduledTaskWeekdaysFromMask(mask: number): ScheduledTaskWeekday[] {
  return SCHEDULED_TASK_WEEKDAYS.filter((_day, index) => (mask & (1 << index)) !== 0);
}

export function sameScheduledTaskSchedule(left: ScheduledTaskSchedule, right: ScheduledTaskSchedule): boolean {
  if (left.kind !== right.kind || left.time !== right.time) return false;
  switch (left.kind) {
    case "once": return right.kind === "once" && left.date === right.date;
    case "weekly": return right.kind === "weekly" &&
      scheduledTaskWeekdayMask(left.days) === scheduledTaskWeekdayMask(right.days);
    case "monthly": return right.kind === "monthly" && left.dayOfMonth === right.dayOfMonth;
    case "hourly": return right.kind === "hourly" && left.everyHours === right.everyHours && left.until === right.until &&
      scheduledTaskWeekdayMask(left.days) === scheduledTaskWeekdayMask(right.days);
    default: return true;
  }
}

function utcMilliseconds(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  // setUTCFullYear keeps years 0..99 literal, unlike Date.UTC.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
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

/** The zone's wall clock at a whole-second instant, written as UTC milliseconds. */
function wallClock(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return utcMilliseconds(parts.year!, parts.month!, parts.day!, parts.hour === 24 ? 0 : parts.hour!, parts.minute!, parts.second!);
}

function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClock(whole, timeZone) - whole;
}

function fromUtcDate(milliseconds: number): ScheduledTaskLocalDate {
  const date = new Date(milliseconds);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(date: ScheduledTaskLocalDate, days: number): ScheduledTaskLocalDate {
  return fromUtcDate(utcMilliseconds(date.year, date.month, date.day + days));
}

function parseLocalDate(value: string): ScheduledTaskLocalDate {
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
}

/** The local calendar date of an instant in a zone. */
export function scheduledTaskLocalDate(instant: Date, timeZone: string): ScheduledTaskLocalDate {
  return fromUtcDate(wallClock(Math.floor(instant.getTime() / 1000) * 1000, timeZone));
}

/**
 * The instant of a local date and minute of the day. A skipped wall time keeps
 * the offset before the transition (the same wall time shifted forward by the
 * gap); a repeated wall time resolves to its earlier instant.
 */
export function scheduledTaskZonedInstant(date: ScheduledTaskLocalDate, minuteOfDay: number, timeZone: string): Date {
  const wall = utcMilliseconds(date.year, date.month, date.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  // Real zones change offset at most once within a day either side of a wall time.
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const matching = [wall - before, wall - after].filter((candidate) => candidate + offsetAt(candidate, timeZone) === wall);
  return new Date(matching.length > 0 ? Math.min(...matching) : wall - before);
}

/** The instant of a once schedule, regardless of whether it has passed. */
export function scheduledTaskOnceInstant(schedule: Extract<ScheduledTaskSchedule, { kind: "once" }>, timeZone: string): Date {
  return scheduledTaskZonedInstant(parseLocalDate(schedule.date), scheduledTaskTimeToMinutes(schedule.time), timeZone);
}

function weekdayOf(date: ScheduledTaskLocalDate): ScheduledTaskWeekday {
  return SCHEDULED_TASK_WEEKDAYS[(new Date(utcMilliseconds(date.year, date.month, date.day)).getUTCDay() + 6) % 7]!;
}

function runsOn(schedule: Exclude<ScheduledTaskSchedule, { kind: "once" | "hourly" }>, date: ScheduledTaskLocalDate): boolean {
  switch (schedule.kind) {
    case "daily": return true;
    case "weekly": return schedule.days.includes(weekdayOf(date));
    case "monthly": return date.day === Math.min(schedule.dayOfMonth, scheduledTaskDaysInMonth(date.year, date.month));
  }
}

/**
 * The instants of an hourly schedule on one local date, ascending and unique.
 * Nominal slots run every `everyHours` from the window start through its end
 * inclusive. A slot a forward transition shifts outside the window, or into
 * another date, is skipped; slots that convert to the same instant run once.
 */
function hourlyInstants(
  schedule: Extract<ScheduledTaskSchedule, { kind: "hourly" }>,
  date: ScheduledTaskLocalDate,
  timeZone: string
): number[] {
  if (!schedule.days.includes(weekdayOf(date))) return [];
  const start = scheduledTaskTimeToMinutes(schedule.time);
  const end = schedule.until === null ? LAST_MINUTE_OF_DAY : scheduledTaskTimeToMinutes(schedule.until);
  const midnight = utcMilliseconds(date.year, date.month, date.day);
  const instants: number[] = [];
  for (let minute = start; minute <= end; minute += schedule.everyHours * 60) {
    const instant = scheduledTaskZonedInstant(date, minute, timeZone).getTime();
    const wallSinceMidnight = wallClock(instant, timeZone) - midnight;
    if (wallSinceMidnight < start * MINUTE_MS || wallSinceMidnight > end * MINUTE_MS) continue;
    if (!instants.includes(instant)) instants.push(instant);
  }
  return instants.sort((left, right) => left - right);
}

/**
 * The first occurrence strictly after `after`; for a once schedule its instant
 * when that is after `after`, else null. Expects a decoded schedule and a
 * resolvable zone (an unknown zone throws a RangeError).
 */
export function nextOccurrenceAfter(schedule: ScheduledTaskSchedule, timeZone: string, after: Date): Date | null {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) throw new RangeError("scheduled_task_instant_invalid");
  if (schedule.kind === "once") {
    const instant = scheduledTaskOnceInstant(schedule, timeZone);
    return instant.getTime() > afterMs ? instant : null;
  }
  // Start a day early: the previous day's time can be shifted past midnight by a gap.
  let date = addDays(scheduledTaskLocalDate(after, timeZone), -1);
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned += 1, date = addDays(date, 1)) {
    if (schedule.kind === "hourly") {
      const next = hourlyInstants(schedule, date, timeZone).find((instant) => instant > afterMs);
      if (next !== undefined) return new Date(next);
      continue;
    }
    if (!runsOn(schedule, date)) continue;
    const instant = scheduledTaskZonedInstant(date, scheduledTaskTimeToMinutes(schedule.time), timeZone);
    if (instant.getTime() > afterMs) return instant;
  }
  return null;
}

function dateLabel(date: ScheduledTaskLocalDate): string {
  return `${date.day} ${MONTH_LABELS[date.month - 1]} ${date.year}`;
}

/** Weekdays after an hourly summary: none for every day, else ", Mon–Fri" or ", Mon, Wed". */
function hourlyDaysLabel(days: readonly ScheduledTaskWeekday[]): string {
  const mask = scheduledTaskWeekdayMask(days);
  if (mask === ALL_DAYS_MASK) return "";
  if (mask === WORKDAYS_MASK) return ", Mon–Fri";
  return `, ${scheduledTaskWeekdaysFromMask(mask).map((day) => WEEKDAY_LABELS[day]).join(", ")}`;
}

/**
 * English summary, e.g. "Every weekday at 09:00", "Once on 12 Oct 2026 at 10:00"
 * or "Every 2 hours, 09:00–18:00, Mon–Fri".
 */
export function describeScheduledTaskSchedule(schedule: ScheduledTaskSchedule): string {
  const at = `at ${schedule.time}`;
  switch (schedule.kind) {
    case "once": return `Once on ${dateLabel(parseLocalDate(schedule.date))} ${at}`;
    case "hourly": {
      const every = schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`;
      const window = schedule.until !== null ? `, ${schedule.time}–${schedule.until}`
        : schedule.time !== "00:00" ? ` from ${schedule.time}` : "";
      return `${every}${window}${hourlyDaysLabel(schedule.days)}`;
    }
    case "daily": return `Every day ${at}`;
    case "weekly": {
      const mask = scheduledTaskWeekdayMask(schedule.days);
      if (mask === ALL_DAYS_MASK) return `Every day ${at}`;
      if (mask === WORKDAYS_MASK) return `Every weekday ${at}`;
      return `Every ${scheduledTaskWeekdaysFromMask(mask).map((day) => WEEKDAY_LABELS[day]).join(", ")} ${at}`;
    }
    case "monthly": return `Monthly on day ${schedule.dayOfMonth} ${at}`;
  }
}

/** "<task title><suffix>", shortening the task title to keep the chat title bound. */
function titleWithSuffix(title: string, suffix: string): string {
  const room = SCHEDULED_TASK_TITLE_MAX_LENGTH - Array.from(suffix).length;
  const characters = Array.from(title.trim());
  const shortened = characters.length > room ? `${characters.slice(0, room - 1).join("").trimEnd()}…` : characters.join("");
  return `${shortened}${suffix}`;
}

/**
 * The title of the chat a run starts in "new chat each run" mode: "<task title> ·
 * <local date of the run>", shortening the task title to keep the chat title bound.
 */
export function scheduledTaskRunChatTitle(title: string, instant: Date, timeZone: string): string {
  return titleWithSuffix(title, ` · ${dateLabel(scheduledTaskLocalDate(instant, timeZone))}`);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"
];

/** The calendar month of an instant in a zone, "YYYY-MM"; it orders as text. Throws RangeError for an unknown zone. */
export function scheduledTaskMonthKey(instant: Date, timeZone: string): string {
  const date = scheduledTaskLocalDate(instant, timeZone);
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}`;
}

/**
 * The title of the chat a same-chat task starts for a calendar month: "<task
 * title> · October 2026", shortening the task title to keep the chat title bound.
 */
export function scheduledTaskMonthChatTitle(title: string, instant: Date, timeZone: string): string {
  const date = scheduledTaskLocalDate(instant, timeZone);
  return titleWithSuffix(title, ` · ${MONTH_NAMES[date.month - 1]} ${date.year}`);
}
