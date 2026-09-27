import { safeExternalHref } from "../../domain/links";
import { searchSourceFallbackTitle } from "../../domain/searchSources";
import { storableUtf16Text, takeUtf16SafePrefix } from "../../domain/utf16";

export type SearchSource = Readonly<{
  /** The engine's own number for a source its findings cite: the provider's
   * citation number when the provider numbers citations in its text
   * (Perplexity `[n]`), otherwise the source's position among the engine's
   * cited sources. Absent on a source the engine only browsed. */
  citation?: number;
  date?: string;
  rank: number;
  snippet?: string;
  title: string;
  url: string;
}>;

// One engine's findings: the agreed 1 MiB of UTF-8 (a UTF-16 length never
// exceeds it). Larger findings are refused as invalid, never cut, and the
// engine keeps its reported usage. Delivery is bounded separately: a retained
// v1 observation keeps all three engines (SEARCH_OBSERVATION_MAX_BYTES) behind
// a bounded projection and a reader; Off and an unretained call keep only
// what fits the persisted tool result (`fitDurableSearchToolResult`).
export const MAX_SEARCH_FINDINGS_CHARACTERS = 1_024 * 1_024;
export const MAX_SEARCH_FINDINGS_BYTES = 1_024 * 1_024;
/** Sources one engine result keeps: the adapter ceiling and the durable bound. */
export const MAX_SEARCH_ENGINE_SOURCES = 20;
const MAX_SEARCH_CITATION_NUMBER = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cut at a code point and re-trimmed, so a stored value never ends in half a pair or a space. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = storableUtf16Text(value).trim();
  return trimmed ? takeUtf16SafePrefix(trimmed, max).trimEnd() : undefined;
}

function citationNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 &&
    value <= MAX_SEARCH_CITATION_NUMBER ? value : undefined;
}

function safeHttpHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.trim();
  if (!href || href.length > 2_048) return undefined;
  const safe = safeExternalHref(href);
  if (!safe || storableUtf16Text(safe) !== safe) return undefined;
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

export function normalizeSearchFindings(value: unknown): string {
  if (typeof value !== "string") throw new Error("search_findings_invalid");
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_SEARCH_FINDINGS_CHARACTERS ||
    Buffer.byteLength(normalized, "utf8") > MAX_SEARCH_FINDINGS_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("search_findings_invalid");
  }
  return normalized;
}

/** Normalize only an explicit flat list of adapter-selected source candidates.
 * This deliberately does not crawl arbitrary provider payloads or previews. */
export function normalizeSearchSources(
  value: unknown,
  maximum = MAX_SEARCH_ENGINE_SOURCES
): SearchSource[] {
  const sources: SearchSource[] = [];
  const seenUrls = new Set<string>();
  if (!Array.isArray(value)) return sources;
  for (const candidate of value) {
    if (sources.length >= maximum) break;
    if (!isRecord(candidate)) continue;
    const row = candidate;
    const safe = safeHttpHref(row.url) ?? safeHttpHref(row.href);
    if (safe && !seenUrls.has(safe)) {
      seenUrls.add(safe);
      const citation = citationNumber(row.citation);
      sources.push({
        ...(citation === undefined ? {} : { citation }),
        ...(text(row.date, 80) ?? text(row.publishedAt, 80)
          ? { date: text(row.date, 80) ?? text(row.publishedAt, 80) }
          : {}),
        rank: sources.length + 1,
        ...(text(row.snippet, 2_000) ?? text(row.description, 2_000)
          ? { snippet: text(row.snippet, 2_000) ?? text(row.description, 2_000) }
          : {}),
        title: text(row.title, 500) ?? searchSourceFallbackTitle(safe),
        url: safe
      });
    }
  }
  return sources;
}

/** The sources one engine result keeps: every cited source first, within the
 * adapter ceiling, then at most `maxBrowsed` sources the engine only browsed.
 * A reference in the findings must resolve to a kept source, so `maxResults`
 * never bounds cited sources. Ranks stay positional. */
export function boundedEngineSearchSources(value: unknown, maxBrowsed: number): SearchSource[] {
  const sources = normalizeSearchSources(value, Number.MAX_SAFE_INTEGER);
  return normalizeSearchSources([
    ...sources.filter((source) => source.citation !== undefined),
    ...sources.filter((source) => source.citation === undefined).slice(0, Math.max(0, maxBrowsed))
  ]);
}

/** Adapter-selected cited sources numbered by their position, for a provider
 * that cites sources without numbering them in its text. */
export function citedSearchSources(value: unknown, maximum = MAX_SEARCH_ENGINE_SOURCES): SearchSource[] {
  return normalizeSearchSources(value, maximum).map((source) => ({ ...source, citation: source.rank }));
}

/** Citation artifacts are already provider-adapter allowlist projections.
 * Each source keeps the provider's citation number (`index`) when its
 * artifact carries one, otherwise its position among the cited sources. */
export function searchSourcesFromCitationArtifacts(
  artifacts: readonly import("../../domain/modelRunEvents").ModelRunSseEvent[],
  maximum = MAX_SEARCH_ENGINE_SOURCES
): SearchSource[] {
  return normalizeSearchSources(artifacts.flatMap((event) =>
    event.type === "artifact" && event.data.artifactType === "citation" &&
      isRecord(event.data.payload)
      ? [{ ...event.data.payload, citation: event.data.payload.index }]
      : []
  ), maximum).map((source) => source.citation === undefined
    ? { ...source, citation: source.rank }
    : source);
}
