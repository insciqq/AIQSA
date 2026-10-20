/**
 * The blank personal chat greets the viewer by their local time of day. The
 * browser keeps its IANA time zone in a cookie so the server renders the same
 * greeting on the next load; without one the server shows the static question
 * and the browser swaps in the greeting after hydration.
 */
export const AIQSA_TIME_ZONE_COOKIE_NAME = "aiqsa.tz";

export const FALLBACK_GREETING = "What are we working on?";

export type GreetingPeriod = "afternoon" | "evening" | "morning";

const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/u;

/** "Good night" is a farewell in English, so late hours stay "evening". */
export function greetingPeriodAt(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

export function isGreetingTimeZone(value: unknown): value is string {
  return typeof value === "string" && TIME_ZONE_PATTERN.test(value);
}

/** The period at `date` in a cookie-supplied zone, or null for a missing or unknown zone. */
export function greetingPeriodInTimeZone(timeZone: unknown, date: Date): GreetingPeriod | null {
  if (!isGreetingTimeZone(timeZone)) return null;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(date));
    return Number.isInteger(hour) ? greetingPeriodAt(hour) : null;
  } catch {
    return null;
  }
}

/** The first word of the display name; none for an empty name or an email address. */
export function greetingFirstName(displayName: string): string | null {
  const first = displayName.trim().split(/\s+/u)[0] ?? "";
  return first && !first.includes("@") ? first : null;
}

export function greetingText(period: GreetingPeriod | null, displayName: string): string {
  const name = greetingFirstName(displayName);
  return period && name ? `Good ${period}, ${name}` : FALLBACK_GREETING;
}
