export type LocalPromptTemplateOptions = {
  locale?: string | string[];
  now?: Date;
  timeZone?: string;
};

/**
 * The code-owned platform baseline for ordinary no-Assistant runs. It is not a
 * database object: it cannot be listed, edited, shared, versioned, or deleted,
 * and the browser has no authority to replace it or to supply the rendered
 * date/time as arbitrary prompt text.
 */
export const STANDARD_CHAT_BASELINE_TEMPLATE =
  "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.";

export const STANDARD_CHAT_FALLBACK_TIME_ZONE = "UTC";

const MAX_TIME_ZONE_LENGTH = 64;
const TIME_ZONE_SHAPE = /^[A-Za-z0-9_+\-/]+$/u;

/**
 * Bounded IANA time-zone validation: shape and length first, then an actual
 * Intl lookup so only zones the runtime can resolve are accepted.
 */
export function validateIanaTimeZone(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_TIME_ZONE_LENGTH ||
    !TIME_ZONE_SHAPE.test(value)
  ) {
    return null;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

export type StandardChatBaseline = {
  renderedSystemPrompt: string;
  timeZone: string;
  timeZoneSource: "client" | "utc_fallback";
};

/**
 * Resolves the baseline from the server clock plus a validated client-supplied
 * IANA zone; missing or invalid context uses the explicit recorded UTC
 * fallback. The locale is pinned so rendered evidence is reproducible.
 */
export function resolveStandardChatBaseline(input: {
  now?: Date;
  timeZone?: unknown;
}): StandardChatBaseline {
  const validated = validateIanaTimeZone(input.timeZone);
  const timeZone = validated ?? STANDARD_CHAT_FALLBACK_TIME_ZONE;

  return {
    renderedSystemPrompt: renderLocalPromptTemplate(STANDARD_CHAT_BASELINE_TEMPLATE, {
      locale: "en-US",
      ...(input.now ? { now: input.now } : {}),
      timeZone
    }),
    timeZone,
    timeZoneSource: validated ? "client" : "utc_fallback"
  };
}

export function renderLocalPromptTemplate(value: string, options: LocalPromptTemplateOptions = {}): string {
  const now = options.now ?? new Date();
  const localDate = new Intl.DateTimeFormat(options.locale, {
    day: "numeric",
    month: "long",
    timeZone: options.timeZone,
    year: "numeric"
  }).format(now);
  const localTime = new Intl.DateTimeFormat(options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: options.timeZone,
    timeZoneName: "short"
  }).format(now);

  return value.replaceAll("{local_date}", localDate).replaceAll("{local_time}", localTime);
}
