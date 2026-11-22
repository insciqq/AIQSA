import { validateIanaTimeZone } from "../../../domain/promptTemplates";
import { scheduledTaskZonedInstant } from "../../../domain/scheduledTaskSchedule";

/**
 * Days and times of past-chat search in the turn's time zone: the model reads
 * dates in the zone its turn context states, so `after` and `before` name
 * days there and results carry their times with that zone's offset.
 */

/** The zone, or UTC when it is not one the runtime resolves. */
export function pastChatTimeZone(value: string | null | undefined): string {
  return validateIanaTimeZone(value) ?? "UTC";
}

/** The first instant of a `YYYY-MM-DD` day in the zone. */
export function pastChatDayStart(day: string, timeZone: string): Date {
  return scheduledTaskZonedInstant({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) },
    0, pastChatTimeZone(timeZone));
}

export type PastChatTurnRange = Readonly<{ from: Date | null; until: Date | null }>;

/** `after` keeps turns on or after its day, `before` those before its day. */
export function pastChatTurnRange(input: Readonly<{ after?: string | null; before?: string | null }>, timeZone: string): PastChatTurnRange {
  return {
    from: input.after ? pastChatDayStart(input.after, timeZone) : null,
    until: input.before ? pastChatDayStart(input.before, timeZone) : null
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

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

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** The instant as an ISO timestamp in the zone, to the second: `2026-11-20T14:05:09+03:00`, or `…Z` in UTC. */
export function pastChatTimestamp(instant: Date, timeZone: string): string {
  const zone = pastChatTimeZone(timeZone);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  const utc = new Date(whole).toISOString().slice(0, 19) + "Z";
  if (zone === "UTC") return utc;
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(whole)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour === 24 ? 0 : parts.hour!, parts.minute!, parts.second!);
  const offsetMinutes = (wall - whole) / 60_000;
  // An offset with seconds (old local mean times) has no ISO form here.
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) >= 24 * 60) return utc;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${pad(parts.year!, 4)}-${pad(parts.month!)}-${pad(parts.day!)}T${pad(parts.hour === 24 ? 0 : parts.hour!)}:` +
    `${pad(parts.minute!)}:${pad(parts.second!)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
