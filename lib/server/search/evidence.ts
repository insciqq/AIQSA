import { safeExternalHref } from "../../domain/links";

export type SearchSource = Readonly<{
  date?: string;
  rank: number;
  snippet?: string;
  title: string;
  url: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
}

function safeHttpHref(value: unknown): string | undefined {
  const href = text(value, 2_048);
  const safe = href ? safeExternalHref(href) : null;
  if (!safe) return undefined;
  try {
    const url = new URL(safe);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? safe
      : undefined;
  } catch {
    return undefined;
  }
}

/** Extract only the reviewed common source fields. Raw provider payloads stay
 * out of SearchRun evidence and tool results. */
export function normalizeSearchSources(value: unknown, maximum = 20): SearchSource[] {
  const sources: SearchSource[] = [];
  const seenObjects = new WeakSet<object>();
  const seenUrls = new Set<string>();

  function visit(candidate: unknown): void {
    if (sources.length >= maximum || typeof candidate !== "object" || candidate === null) return;
    if (seenObjects.has(candidate)) return;
    seenObjects.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    const row = candidate as Record<string, unknown>;
    const safe = safeHttpHref(row.url) ?? safeHttpHref(row.href);
    if (safe && !seenUrls.has(safe)) {
      seenUrls.add(safe);
      sources.push({
        ...(text(row.date, 80) ?? text(row.publishedAt, 80)
          ? { date: text(row.date, 80) ?? text(row.publishedAt, 80) }
          : {}),
        rank: sources.length + 1,
        ...(text(row.snippet, 2_000) ?? text(row.description, 2_000)
          ? { snippet: text(row.snippet, 2_000) ?? text(row.description, 2_000) }
          : {}),
        title: text(row.title, 500) ?? safe,
        url: safe
      });
    }
    for (const entry of Object.values(row)) visit(entry);
  }

  visit(value);
  return sources;
}
