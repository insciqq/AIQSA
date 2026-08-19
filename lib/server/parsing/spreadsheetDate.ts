import { SSF } from "xlsx";

type SpreadsheetDateParts = Readonly<{
  H: number;
  M: number;
  S: number;
  d: number;
  m: number;
  u: number;
  y: number;
}>;

type SpreadsheetFormatter = Readonly<{
  is_date(format: string): boolean;
  parse_date_code(
    serial: number,
    options: Readonly<{ date1904: boolean }>
  ): SpreadsheetDateParts | null;
}>;

const spreadsheetFormatter = SSF as unknown as SpreadsheetFormatter;
const DATE_VALUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?)?$/u;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year === 1900 && month === 2 && day === 29) return true;
  if (year < 1 || year > 9_999 || month < 1 || month > 12 || day < 1) return false;
  const maximum = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maximum;
}

export function isSpreadsheetDateValue(value: string): boolean {
  const match = DATE_VALUE_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!validCalendarDate(year, month, day)) return false;
  if (hourText === undefined) return true;
  return Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59;
}

export function spreadsheetDateFromSerial(
  serial: number,
  dateSystem: "1900" | "1904"
): string | null {
  let parts: SpreadsheetDateParts | null;
  try {
    parts = spreadsheetFormatter.parse_date_code(serial, { date1904: dateSystem === "1904" });
  } catch {
    return null;
  }
  if (!parts || !validCalendarDate(parts.y, parts.m, parts.d)) return null;
  const date = `${pad(parts.y, 4)}-${pad(parts.m)}-${pad(parts.d)}`;
  const milliseconds = Math.max(0, Math.min(999, Math.round(parts.u * 1_000)));
  if (parts.H === 0 && parts.M === 0 && parts.S === 0 && milliseconds === 0) return date;
  return `${date}T${pad(parts.H)}:${pad(parts.M)}:${pad(parts.S)}` +
    (milliseconds === 0 ? "" : `.${pad(milliseconds, 3)}`);
}

export function spreadsheetFormatIsDate(format: string): boolean {
  try {
    return spreadsheetFormatter.is_date(format);
  } catch {
    return false;
  }
}
