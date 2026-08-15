import type { ThreadSearchSource } from "../contracts/searchSources";
import { safeExternalHref } from "./links";

const sourceLimit = 20;
const sourceTraversalLimit = 500;

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : null;
}

function httpHref(value: unknown): string | null {
  const href = safeExternalHref(value);
  if (!href) return null;
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

/** Projects only normalized, link-safe answer source facts from provider-owned values. */
export function projectThreadSearchSources(value: unknown): ThreadSearchSource[] {
  const sources: ThreadSearchSource[] = [];
  const seenUrls = new Set<string>();
  const pending: unknown[] = [value];
  let visited = 0;

  while (pending.length > 0 && sources.length < sourceLimit && visited < sourceTraversalLimit) {
    const candidate = pending.shift();
    visited += 1;
    if (typeof candidate !== "object" || candidate === null) continue;
    if (Array.isArray(candidate)) {
      const remaining = Math.max(0, sourceTraversalLimit - visited - pending.length);
      pending.push(...candidate.slice(0, remaining));
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const url = httpHref(record.url) ?? httpHref(record.href);
    if (!url || seenUrls.has(url)) continue;
    const date = boundedString(record.date, 80) ?? boundedString(record.publishedAt, 80);
    const snippet = boundedString(record.snippet, 2_000) ??
      boundedString(record.description, 2_000);
    seenUrls.add(url);
    sources.push({
      ...(date ? { date } : {}),
      rank: sources.length + 1,
      ...(snippet ? { snippet } : {}),
      title: boundedString(record.title, 500) ?? url,
      url
    });
  }

  return sources;
}
