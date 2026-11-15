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

/*
 * A link in the answer text: Markdown targets and bare URLs alike, since the
 * pattern stops at whitespace, brackets and quotes. One level of balanced
 * parentheses stays inside ("/wiki/Foo_(bar)"); sentence punctuation and
 * Markdown emphasis right after a URL do not belong to it.
 */
const ANSWER_TEXT_URL_PATTERN = /https?:\/\/(?:[^\s<>()[\]{}"'`|]|\([^\s<>()[\]{}"'`|]*\))+/giu;
const URL_TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/u;

/** The http(s) links of an answer's text, in order of appearance. */
export function answerTextUrlsV2(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(ANSWER_TEXT_URL_PATTERN)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION, "");
    if (url.length > "https://".length) urls.push(url);
  }
  return urls;
}

/**
 * What the answer cites, in order: the provider's citations by their index
 * (they carry no position in the text), then the links of the text in the
 * order they appear.
 */
export function answerCitedUrlsV2(
  citations: readonly Readonly<{ index: number; url: string }>[],
  text: string
): string[] {
  return [
    ...[...citations].sort((left, right) => left.index - right.index).map((citation) => citation.url),
    ...answerTextUrlsV2(text)
  ];
}

export type AnswerSourceSplitV2 = Readonly<{
  /** Listed sources the answer cites, in order of first mention. */
  cited: PresentedSearchSourceV2[];
  /** Every other listed source, in list order. */
  uncited: PresentedSearchSourceV2[];
}>;

/**
 * Splits the listed sources into the ones the answer cites and the rest. A
 * cited URL counts only when it matches a listed source by
 * `normalizedSourceUrlKeyV2`, so a link the run never searched adds nothing.
 */
export function splitCitedSourcesV2(
  sources: readonly PresentedSearchSourceV2[],
  citedUrls: readonly string[]
): AnswerSourceSplitV2 {
  const indexByKey = new Map<string, number>();
  sources.forEach((source, index) => {
    const key = normalizedSourceUrlKeyV2(source.url);
    if (!indexByKey.has(key)) indexByKey.set(key, index);
  });
  const citedIndexes: number[] = [];
  const taken = new Set<number>();
  for (const url of citedUrls) {
    const index = indexByKey.get(normalizedSourceUrlKeyV2(url));
    if (index === undefined || taken.has(index)) continue;
    taken.add(index);
    citedIndexes.push(index);
  }
  return {
    cited: citedIndexes.map((index) => sources[index]!),
    uncited: taken.size === 0 ? [...sources] : sources.filter((_, index) => !taken.has(index))
  };
}

export type SourceSiteGroupV2 = Readonly<{
  /** Host without `www.`; empty for sources without a readable site. */
  site: string;
  sources: PresentedSearchSourceV2[];
}>;

/**
 * Sources grouped by site, the largest group first and ties by name; the
 * group of sources without a site goes last. Each group keeps list order.
 */
export function groupSourcesBySiteV2(sources: readonly PresentedSearchSourceV2[]): SourceSiteGroupV2[] {
  const groups = new Map<string, PresentedSearchSourceV2[]>();
  for (const source of sources) {
    const site = source.domain ?? "";
    const group = groups.get(site);
    if (group) group.push(source);
    else groups.set(site, [source]);
  }
  return [...groups].map(([site, members]) => ({ site, sources: members })).sort((left, right) =>
    Number(left.site === "") - Number(right.site === "") ||
    right.sources.length - left.sources.length ||
    left.site.localeCompare(right.site)
  );
}

/** Sources whose title, site or URL contains the query, ignoring case; all of them for a blank query. */
export function filterSourcesV2(
  sources: readonly PresentedSearchSourceV2[],
  query: string
): PresentedSearchSourceV2[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sources];
  return sources.filter((source) =>
    source.title.toLowerCase().includes(needle) ||
    (source.domain?.includes(needle) ?? false) ||
    source.url.toLowerCase().includes(needle)
  );
}
