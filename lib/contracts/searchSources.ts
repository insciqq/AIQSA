export type ThreadSearchSource = {
  date?: string;
  rank: number;
  snippet?: string;
  title: string;
  url: string;
};

const sourceUrlLimit = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeHttpHref(value: unknown): string | null {
  const href = boundedString(value, sourceUrlLimit);
  if (!href || href.startsWith("//") || /[\u0000-\u001F\u007F\s]/u.test(href)) return null;
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? href
      : null;
  } catch {
    return null;
  }
}

export function decodeThreadSearchSource(value: unknown): ThreadSearchSource | null {
  if (!isRecord(value)) return null;
  const date = value.date === undefined ? undefined : boundedString(value.date, 80);
  const rank = nonNegativeInteger(value.rank);
  const snippet = value.snippet === undefined ? undefined : boundedString(value.snippet, 2_000);
  const title = boundedString(value.title, 500);
  const url = safeHttpHref(value.url);
  if (
    (value.date !== undefined && !date) ||
    rank === null ||
    rank < 1 ||
    (value.snippet !== undefined && !snippet) ||
    !title ||
    !url
  ) {
    return null;
  }
  return {
    ...(date ? { date } : {}),
    rank,
    ...(snippet ? { snippet } : {}),
    title,
    url
  };
}
