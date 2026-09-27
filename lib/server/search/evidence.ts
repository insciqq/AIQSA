import { safeExternalHref } from "../../domain/links";
import { searchSourceFallbackTitle } from "../../domain/searchSources";
import { storableUtf16Text, takeUtf16SafePrefix } from "../../domain/utf16";

export type SearchSource = Readonly<{
  date?: string;
  rank: number;
  snippet?: string;
  title: string;
  url: string;
}>;

// Allow larger Search replies while keeping an independent safety bound on
// UTF-8 evidence. The combined tool result also has its own persistence limit.
export const MAX_SEARCH_FINDINGS_CHARACTERS = 128 * 1_024;
export const MAX_SEARCH_FINDINGS_BYTES = 128 * 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cut at a code point and re-trimmed, so a stored value never ends in half a pair or a space. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = storableUtf16Text(value).trim();
  return trimmed ? takeUtf16SafePrefix(trimmed, max).trimEnd() : undefined;
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
export function normalizeSearchSources(value: unknown, maximum = 20): SearchSource[] {
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
      sources.push({
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

/** Citation artifacts are already provider-adapter allowlist projections. */
export function searchSourcesFromCitationArtifacts(
  artifacts: readonly import("../../domain/modelRunEvents").ModelRunSseEvent[],
  maximum = 20
): SearchSource[] {
  return normalizeSearchSources(artifacts.flatMap((event) =>
    event.type === "artifact" && event.data.artifactType === "citation" &&
      isRecord(event.data.payload)
      ? [event.data.payload]
      : []
  ), maximum);
}
