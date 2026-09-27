import { THREAD_CITATION_MAX_ITEMS, type ThreadCitation } from "../contracts/chats";
import { safeExternalHref } from "./links";
import { storableUtf16Text, takeUtf16SafePrefix } from "./utf16";

const citationTitleLimit = 500;
const citationSnippetLimit = 2_000;
const citationSourceLimit = 200;
const citationUrlLimit = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed, storable and cut at a code point; projecting the result again is a no-op. */
function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = storableUtf16Text(value).trim();
  return text ? takeUtf16SafePrefix(text, maximum).trimEnd() : null;
}

function citationUrl(value: unknown): string | null {
  const candidate = typeof value === "string" && value.trim().length <= citationUrlLimit
    ? value.trim()
    : null;
  const href = candidate ? safeExternalHref(candidate) : null;
  return href && storableUtf16Text(href) === href ? href : null;
}

/**
 * The one citation projection for durable writes, reloads and the live
 * stream, so a citation shown live is the one a reload shows. Provider call
 * identifiers and wrapper fields never survive it.
 */
export function projectAnswerCitation(value: unknown): ThreadCitation | null {
  if (typeof value === "string") {
    const url = citationUrl(value);
    return url ? { index: 1, title: "Source 1", url } : null;
  }
  if (!isRecord(value)) return null;
  const url = citationUrl(value.url) ?? citationUrl(value.href);
  if (!url) return null;
  const index = typeof value.index === "number" && Number.isSafeInteger(value.index) &&
    value.index >= 0
    ? value.index
    : 1;
  const snippet = boundedText(value.snippet, citationSnippetLimit);
  const source = boundedText(value.source, citationSourceLimit);
  return {
    index,
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    title: boundedText(value.title, citationTitleLimit) ?? `Source ${index}`,
    url
  };
}

/** Gemini grounding citations are numbered by their position in the display. */
export function answerCitationsFromGrounding(
  citations: readonly Readonly<{ title: string; url: string }>[]
): ThreadCitation[] {
  return citations.flatMap((citation, index) => {
    const projected = projectAnswerCitation({ index: index + 1, title: citation.title, url: citation.url });
    return projected ? [projected] : [];
  });
}

/**
 * Cited links accumulate across every provider response and tool round of an
 * answer. A repeated link adds nothing the reader can open, so the first
 * citation of each URL is kept, in order, up to the reader bound; anything
 * beyond it is marked rather than dropped silently.
 */
export function foldAnswerCitations(
  citations: readonly ThreadCitation[]
): Readonly<{ citations: ThreadCitation[]; truncated: boolean }> {
  const kept: ThreadCitation[] = [];
  const urls = new Set<string>();
  for (const citation of citations) {
    if (urls.has(citation.url)) continue;
    if (kept.length >= THREAD_CITATION_MAX_ITEMS) return { citations: kept, truncated: true };
    urls.add(citation.url);
    kept.push(citation);
  }
  return { citations: kept, truncated: false };
}
