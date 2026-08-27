export type MemoryCalendarUnit = "DAY" | "WEEK" | "MONTH" | "YEAR";

export type MemoryLocalDateTimeParts = Readonly<{
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}>;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function utcCalendarMilliseconds(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  const date = new Date(0);
  date.setUTCHours(hour, minute, second, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date.getTime();
}

export function canonicalMemoryTimeZone(value: string): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

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

export function memoryLocalDateTimeParts(
  date: Date,
  timeZone: string
): MemoryLocalDateTimeParts {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("memory_calendar_invalid");
  }
  const canonical = canonicalMemoryTimeZone(timeZone);
  if (!canonical) throw new Error("memory_calendar_invalid");
  const values = Object.fromEntries(
    formatter(canonical).formatToParts(date)
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
    throw new Error("memory_calendar_invalid");
  }
  return parts as MemoryLocalDateTimeParts;
}

export function memoryDaysInMonth(year: number, month: number): number {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999 ||
    !Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new Error("memory_calendar_invalid");
  }
  return new Date(utcCalendarMilliseconds(year, month, 0)).getUTCDate();
}

export function memoryIsoWeekday(year: number, month: number, day: number): number {
  if (day < 1 || day > memoryDaysInMonth(year, month)) {
    throw new Error("memory_calendar_invalid");
  }
  return new Date(utcCalendarMilliseconds(year, month - 1, day)).getUTCDay() || 7;
}

export function memoryZonedInstant(
  parts: MemoryLocalDateTimeParts,
  timeZone: string
): Date {
  const canonical = canonicalMemoryTimeZone(timeZone);
  if (!canonical || !Number.isSafeInteger(parts.year) || parts.year < 1 ||
    parts.year > 9999 || !Number.isSafeInteger(parts.month) || parts.month < 1 ||
    parts.month > 12 || !Number.isSafeInteger(parts.day) || parts.day < 1 ||
    parts.day > memoryDaysInMonth(parts.year, parts.month) ||
    !Number.isSafeInteger(parts.hour) || parts.hour < 0 || parts.hour > 23 ||
    !Number.isSafeInteger(parts.minute) || parts.minute < 0 || parts.minute > 59 ||
    !Number.isSafeInteger(parts.second) || parts.second < 0 || parts.second > 59) {
    throw new Error("memory_calendar_invalid");
  }
  const desired = utcCalendarMilliseconds(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  let guess = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = memoryLocalDateTimeParts(new Date(guess), canonical);
    const actualAsUtc = utcCalendarMilliseconds(
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
  const verified = memoryLocalDateTimeParts(result, canonical);
  if ((Object.keys(parts) as Array<keyof MemoryLocalDateTimeParts>).some((key) =>
    verified[key] !== parts[key])) {
    throw new Error("memory_calendar_invalid");
  }
  return result;
}

export function addMemoryCalendar(
  date: Date,
  amount: number,
  unit: MemoryCalendarUnit,
  timeZone: string
): Date {
  if (!Number.isSafeInteger(amount) || amount < -10_000 || amount > 10_000) {
    throw new Error("memory_calendar_invalid");
  }
  const current = memoryLocalDateTimeParts(date, timeZone);
  if (unit === "DAY" || unit === "WEEK") {
    const shifted = new Date(utcCalendarMilliseconds(
      current.year,
      current.month - 1,
      current.day + amount * (unit === "WEEK" ? 7 : 1),
      current.hour,
      current.minute,
      current.second
    ));
    return memoryZonedInstant({
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
  return memoryZonedInstant({
    ...current,
    day: Math.min(current.day, memoryDaysInMonth(year, month)),
    month,
    year
  }, timeZone);
}

export function memoryLocalDayStart(date: Date, timeZone: string): Date {
  const parts = memoryLocalDateTimeParts(date, timeZone);
  return memoryZonedInstant({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}
