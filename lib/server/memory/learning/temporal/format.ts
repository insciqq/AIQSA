/** Mechanical machine-format validators. This owner does not infer meaning
 * from natural-language text and is deliberately allowlisted by the semantic
 * boundary architecture test. */
const localDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const localTimePattern = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u;

export type MemoryLocalDate = Readonly<{
  day: number;
  month: number;
  year: number;
}>;

export type MemoryLocalTime = Readonly<{
  hour: number;
  minute: number;
  second: number;
}>;

export function parseMemoryLocalDate(value: string): MemoryLocalDate | null {
  const match = localDatePattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const verified = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 && year <= 9999 &&
    verified.getUTCFullYear() === year &&
    verified.getUTCMonth() + 1 === month &&
    verified.getUTCDate() === day
    ? { day, month, year }
    : null;
}

export function parseMemoryLocalTime(value: string | null): MemoryLocalTime | null {
  if (value === null) return { hour: 0, minute: 0, second: 0 };
  const match = localTimePattern.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  return hour <= 23 && minute <= 59 && second <= 59
    ? { hour, minute, second }
    : null;
}
