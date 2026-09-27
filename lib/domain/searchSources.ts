import { decodeThreadSearchSource, type ThreadSearchSource } from "../contracts/searchSources";
import { safeExternalHref } from "./links";
import { storableUtf16Text, takeUtf16SafePrefix } from "./utf16";

/** Sources of one provider search result; the durable event boundary uses the same bound. */
export const SEARCH_EVENT_SOURCE_LIMIT = 20;
const sourceUrlLimit = 2_048;
const sourceTitleLimit = 500;
/** Values queued per kept source; values past it are unread and reported. */
const traversalPerSource = 25;

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = storableUtf16Text(value).trim();
  return text && text.length <= maximum ? text : null;
}

function httpHref(value: unknown): string | null {
  const href = safeExternalHref(value);
  if (!href || href.length > sourceUrlLimit || storableUtf16Text(href) !== href) return null;
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

/**
 * Title for a source a provider sent without a usable one (OpenAI hosted
 * Search sends bare URLs). The host names the source; a long URL is never
 * reused as a title the source contract would reject.
 */
export function searchSourceFallbackTitle(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return host && host.length <= sourceTitleLimit
    ? host
    : takeUtf16SafePrefix(url, sourceTitleLimit);
}

/**
 * Projects only normalized, link-safe answer source facts from provider-owned
 * values. Every kept source satisfies the client source contract, so a valid
 * provider source can never fail the durable event boundary. `truncated`
 * reports another valid source past `maximum` or a walk stopped by its bound.
 */
export function collectThreadSearchSources(
  value: unknown,
  maximum: number
): Readonly<{ sources: ThreadSearchSource[]; truncated: boolean }> {
  const sources: ThreadSearchSource[] = [];
  const seenUrls = new Set<string>();
  const queue: unknown[] = [value];
  const traversalLimit = Math.max(1, maximum) * traversalPerSource;
  let unread = false;

  for (let next = 0; next < queue.length; next += 1) {
    const candidate = queue[next];
    if (typeof candidate !== "object" || candidate === null) continue;
    if (Array.isArray(candidate)) {
      const room = Math.max(0, traversalLimit - queue.length);
      if (candidate.length > room) unread = true;
      for (const item of candidate.slice(0, room)) queue.push(item);
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const url = httpHref(record.url) ?? httpHref(record.href);
    if (!url || seenUrls.has(url)) continue;
    const date = boundedString(record.date, 80) ?? boundedString(record.publishedAt, 80);
    const snippet = boundedString(record.snippet, 2_000) ??
      boundedString(record.description, 2_000);
    const source = decodeThreadSearchSource({
      ...(date ? { date } : {}),
      rank: sources.length + 1,
      ...(snippet ? { snippet } : {}),
      title: boundedString(record.title, sourceTitleLimit) ?? searchSourceFallbackTitle(url),
      url
    });
    if (!source) continue;
    if (sources.length >= maximum) return { sources, truncated: true };
    seenUrls.add(url);
    sources.push(source);
  }

  return { sources, truncated: unread };
}

/** One provider search result, bounded like its durable event. */
export function projectThreadSearchSources(value: unknown): ThreadSearchSource[] {
  return collectThreadSearchSources(value, SEARCH_EVENT_SOURCE_LIMIT).sources;
}
