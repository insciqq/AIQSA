import type { ThreadSearchSource } from "@/lib/contracts/chats";

export type PresentedSearchSourceV2 = Readonly<{
  domain: string | null;
  rank: number;
  snippet?: string;
  title: string;
  url: string;
}>;

export type PresentedSearchSourcesV2 = Readonly<{
  mergedDuplicateCount: number;
  sources: PresentedSearchSourceV2[];
}>;

function parsedHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function normalizedHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * A conservative comparison key for near-duplicate source URLs: scheme and
 * `www.` are ignored, the fragment is dropped, and trailing slashes collapse.
 * Query strings stay significant because they can select different content.
 */
export function normalizedSourceUrlKeyV2(value: string): string {
  const url = parsedHttpUrl(value);
  if (!url) return value.trim().toLowerCase();
  const path = url.pathname.replace(/\/+$/u, "");
  return `${normalizedHost(url)}${path}${url.search}`;
}

export function sourceDomainV2(value: string): string | null {
  const url = parsedHttpUrl(value);
  return url ? normalizedHost(url) : null;
}

/** Google Search grounding links through this redirect host; the source's
 * title then names the real site. */
const GOOGLE_GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

/** A title that is only a host name ("example.com", "www.Example.com"). */
function hostShapedTitle(title: string): string | null {
  const trimmed = title.trim().replace(/\.$/u, "").toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(trimmed)) return null;
  return trimmed.startsWith("www.") ? trimmed.slice(4) : trimmed;
}

function urlShapedTitle(title: string, url: string): boolean {
  const trimmed = title.trim();
  return trimmed.length === 0 ||
    trimmed === url.trim() ||
    /^https?:\/\//iu.test(trimmed);
}

/**
 * Presents safe answer sources: title plus domain
 * per source, with near-duplicate URLs merged by the normalized key. The first
 * occurrence (provider order) wins; provider-reported ranks are preserved.
 */
export function presentSearchSourcesV2(
  sources: readonly ThreadSearchSource[]
): PresentedSearchSourcesV2 {
  const seen = new Set<string>();
  const presented: PresentedSearchSourceV2[] = [];
  let mergedDuplicateCount = 0;

  for (const source of sources) {
    const key = normalizedSourceUrlKeyV2(source.url);
    if (seen.has(key)) {
      mergedDuplicateCount += 1;
      continue;
    }
    seen.add(key);
    const urlDomain = sourceDomainV2(source.url);
    const titleHost = hostShapedTitle(source.title);
    // A grounding redirect names its site only in the title; the redirect
    // host itself never labels a source.
    const domain = urlDomain === GOOGLE_GROUNDING_REDIRECT_HOST ? titleHost : urlDomain;
    const title = urlShapedTitle(source.title, source.url)
      ? domain ?? source.title
      // A title that only repeats the site renders as that site, once.
      : titleHost && titleHost === domain ? domain : source.title;
    presented.push({
      domain,
      rank: source.rank,
      ...(source.snippet ? { snippet: source.snippet } : {}),
      title,
      url: source.url
    });
  }

  return { mergedDuplicateCount, sources: presented };
}
