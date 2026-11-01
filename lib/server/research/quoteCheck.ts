import type { ResearchFinding } from "../../contracts/research";
import { normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchOpenedSource } from "./gates";
import { researchEvidenceKind, RESEARCH_SOURCE_LIMITS } from "./sources";

/**
 * The check with no model in it: each finding's verbatim quote must be in text
 * an agent of this research really opened. It catches invented quotes and unread
 * sources without anyone's opinion. It runs when a record is written, over what
 * the writing agent itself read (`evidenceStore.ts`), so the agent hears at once
 * while it still has the page, and over a whole run's text at its end.
 *
 * Only `fetch_url` results and what a browser command printed are opened pages
 * (`researchEvidenceKind`): a quote `echo`ed into a file is no reading of a page.
 * A miss is only a failure when it could not have been read some other way:
 * - `found`: the quote is in an opened page, with the passage around it (`excerpt`), which
 *   is what the agents really saw and so what the verifier judges a claim against: a link
 *   only a browser reached cannot be fetched again, and `fetch_url` extracts a page differently.
 *   Where on the run it was read is the verifier's to judge against the cited link; a redirect
 *   or a page seen under another address must not read as invention here.
 * - `not_verbatim`: the cited page really was fetched and the quote is not on it word
 *   for word. PDF hyphenation and extractors reorder text, so that is weak evidence: the
 *   verifier reads the page and the note counts these apart.
 * - `not_checked`: the text that could hold it is not here: the page was read
 *   through the browser and not stored, a stored copy could not be read, it is only in
 *   another tool's output, the run's opened text is over what one check reads, or
 *   nothing could be read at all.
 * - `unsupported`: the page was never opened and the quote is nowhere
 *   (`not_in_opened_text`), or only in search results, and a snippet is no evidence
 *   (`search_snippet_only`).
 */
export type QuoteCheck =
  /** `opened`: which of the sources the check read holds it. */
  | Readonly<{ excerpt: QuoteExcerpt; opened: number; status: "found" }>
  | Readonly<{ status: "not_verbatim" }>
  | Readonly<{ reason: "browser_page" | "other_tool_output" | "partial_source" | "sources_over_limit" | "sources_unreadable"; status: "not_checked" }>
  | Readonly<{ reason: "not_in_opened_text" | "search_snippet_only"; status: "unsupported" }>;

/**
 * Whose words a passage is: the cited page's, another page's, or a browser page with no recorded address. A quote found
 * on another page is real, but that page's terms must never read as the cited one's.
 */
export type QuoteSource = Readonly<{ kind: "cited" | "unknown" }> | Readonly<{ kind: "other"; url: string }>;

/** One continuous passage of opened text, normalized as below, with the quoted words in `quoted`: a long quote's rest is in `after`. */
export type QuoteExcerpt = Readonly<{ after: string; before: string; quoted: string; source: QuoteSource }>;

export const QUOTE_EXCERPT_LIMITS = Object.freeze({ quotedCharacters: 400, sideCharacters: 600 });

/** A stored result may be stringified more than once: a tool's JSON saved inside a result's JSON. */
const UNESCAPE_PASSES = 3;
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/gu;
const ESCAPED_CHARACTERS: Readonly<Record<string, string>> = { "\"": "\"", "/": "/", "\\": "\\", b: " ", f: " ", n: "\n", r: "\n", t: " " };

function unescaped(text: string): string {
  let current = text;
  for (let pass = 0; pass < UNESCAPE_PASSES && current.includes("\\"); pass += 1) {
    const next = current.replace(JSON_ESCAPE, (_match, code: string | undefined, character: string | undefined) =>
      code ? String.fromCharCode(Number.parseInt(code, 16)) : ESCAPED_CHARACTERS[character!]!);
    if (next === current) break;
    current = next;
  }
  return current;
}

const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu;
const LIGATURES: Readonly<Record<string, string>> = { "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st" };
const LIGATURE = /[\uFB00-\uFB06]/gu;
const DOUBLE_QUOTES = /[\u00AB\u00BB\u201C-\u201F\u2033\u2036\u301D-\u301F]/gu;
const SINGLE_QUOTES = /[\u00B4\u2018-\u201B\u2032\u2035\u2039\u203A]/gu;
const DASHES = /[\u2010-\u2015\u2043\u2212\uFE58\uFE63\uFF0D]/gu;
const MARKDOWN_LINK_TARGET = /\]\([^)\s]*\)/gu;
const MARKUP = /[*_`[\]]/gu;

/**
 * What "verbatim" tolerates, applied alike to a quote and to opened text, so what a saved result's form or a model's
 * copying changed is no invention, while different words still miss:
 * - JSON escapes, a few levels deep, since a saved result is often JSON-stringified (`\n`, `\"`, `\u00e9`).
 * - NFC, typographic ligatures and the one-character ellipsis, and invisible characters (soft hyphens, zero-width ones),
 *   which pages hold and models drop.
 * - Typographic quotes fold to `"` or `'`, keeping those two apart, and dashes to the hyphen.
 * - Markdown emphasis and link targets, which a Markdown page has and a model copying its words leaves out.
 * - Runs of whitespace, no-break spaces included.
 *
 * Case and symbols stay, since they carry meaning: 1 mW is not 1 MW, 5' is not 5", m² is not m2, so this is no NFKC.
 * A quote that differs only so on a fetched page is `not_verbatim`, and the verifier reads it.
 */
export function normalizeQuotedText(text: string): string {
  return unescaped(text).normalize("NFC").replace(LIGATURE, (ligature) => LIGATURES[ligature]!).replaceAll("\u2026", "...").replace(INVISIBLE, "")
    .replace(DOUBLE_QUOTES, "\"").replace(SINGLE_QUOTES, "'").replace(DASHES, "-")
    .replace(MARKDOWN_LINK_TARGET, "").replace(MARKUP, "").replace(/\s+/gu, " ").trim();
}

/**
 * A quote's parts: a model marks what it left out with an ellipsis, so each part must be there, in order. Quotation
 * marks around it and punctuation closing it are the model's. No letter or digit means it quotes nothing.
 */
function quoteParts(quote: string): readonly string[] {
  const closing = (part: string) => part.replace(/[\s,.;:!?]+$/u, "");
  return normalizeQuotedText(quote).split(/\.{3,}/u).map((part) => {
    const bare = closing(part.trim());
    // Only a pair is the model's: a lone mark may be part of the words, as in 5".
    const wrapped = /^(["'])[\s\S]*\1$/u.test(bare) && bare.length > 1;
    return closing(wrapped ? bare.slice(1, -1).trim() : bare);
  }).filter((part) => /[\p{L}\p{N}]/u.test(part));
}

/** Where the parts stand in the text, first to last, or null. */
function spanOf(text: string, parts: readonly string[]): Readonly<{ end: number; start: number }> | null {
  if (parts.length === 0) return null;
  let start = -1;
  let end = 0;
  for (const part of parts) {
    const at = text.indexOf(part, end);
    if (at < 0) return null;
    if (start < 0) start = at;
    end = at + part.length;
  }
  return { end, start };
}

const holds = (text: string, parts: readonly string[]) => spanOf(text, parts) !== null;

/** Whether this text holds the quote, read as the check reads it. */
export function quoteIsIn(quote: string, text: string): boolean {
  return holds(normalizeQuotedText(text), quoteParts(quote));
}

function excerptOf(text: string, span: Readonly<{ end: number; start: number }>, source: QuoteSource): QuoteExcerpt {
  const limits = QUOTE_EXCERPT_LIMITS;
  const quotedEnd = Math.min(span.end, span.start + limits.quotedCharacters);
  return { after: text.slice(quotedEnd, quotedEnd + limits.sideCharacters), before: text.slice(Math.max(0, span.start - limits.sideCharacters), span.start),
    quoted: text.slice(span.start, quotedEnd), source };
}

type OpenedPage = Readonly<{ hosts: readonly string[]; index: number; link: string | null; text: string }>;

/** A fetched page knows its address. A browser page only shows hosts in its step lines, if it has any, and one on another host is another page. */
function sourceOf(page: OpenedPage, link: string | null, host: string | null): QuoteSource {
  if (page.link) return page.link === link ? { kind: "cited" } : { kind: "other", url: page.link };
  return page.hosts.length > 0 && (host === null || !page.hosts.includes(host)) ? { kind: "other", url: page.hosts[0]! } : { kind: "unknown" };
}

const SOURCE_ORDER: Readonly<Record<QuoteSource["kind"], number>> = { cited: 0, other: 2, unknown: 1 };

/** Whether a stored whole copy of this very page was read: what lets another page's passage be left aside. */
export function citedPageRead(opened: readonly ResearchOpenedSource[], url: string): boolean {
  const link = normalizeFetchUrl(url);
  return link !== null && opened.some((source) => !source.partial && source.url !== null && normalizeFetchUrl(source.url) === link);
}

function hostOf(link: string): string | null {
  const normalized = normalizeFetchUrl(link);
  return normalized ? new URL(normalized).hostname.replace(/^www\./u, "") : null;
}

/**
 * The hosts a stored result shows the browser on, from its step lines (`ops/workspace-guest/python/aiqsa/browser/_format.py`):
 * `[browser #3] click: button "Add" @ shop.example/cart`. Only an action prints one at a line's start, or as the first
 * thing in a stringified result. A page faking one earns at most `not_checked`, and the verifier still reads that claim.
 */
const BROWSER_STEP = /(?:^|")\[browser #\d+[^\]\n]*\][^\n]* @ ([^\s/"]+)/gmu;

function browserHosts(text: string): readonly string[] {
  if (!text.includes("[browser #")) return [];
  return [...unescaped(text).matchAll(BROWSER_STEP)].map((match) => match[1]!.replace(/:\d+$/u, "").replace(/^www\./u, "").toLowerCase());
}

/**
 * Reads the opened text once and answers per finding, in order. `opened` null: it could not be read at all. `moreUnread`: the caller
 * stopped at a bound, so a quote it did not find may be in what it left out.
 */
export function checkQuotes(findings: readonly Pick<ResearchFinding, "quote" | "url">[], opened: readonly ResearchOpenedSource[] | null,
  options: Readonly<{ moreUnread?: boolean }> = {}): readonly QuoteCheck[] {
  if (!opened) return findings.map(() => ({ reason: "sources_unreadable", status: "not_checked" }));
  const pages: OpenedPage[] = [];
  const others: string[] = [];
  const snippets: string[] = [];
  const fetched = new Set<string>();
  const partialLinks = new Set<string>();
  const browsed = new Set<string>();
  let unlinkedPartial = false;
  let characters = 0;
  for (const [index, source] of opened.entries()) {
    characters += source.text.length;
    const kind = researchEvidenceKind(source);
    if (kind === "agent_written") continue;
    const link = source.url ? normalizeFetchUrl(source.url) : null;
    if (source.partial) {
      if (link) partialLinks.add(link);
      // A result with no link may be a page from anywhere; a search result's text is no page.
      else if (kind !== "search") unlinkedPartial = true;
    } else if (link) fetched.add(link);
    const hosts = browserHosts(source.text);
    for (const host of hosts) browsed.add(host);
    const text = normalizeQuotedText(source.text);
    if (kind === "page") pages.push({ hosts, index, link, text });
    else (kind === "search" ? snippets : others).push(text);
  }
  const overLimit = options.moreUnread === true || opened.length >= RESEARCH_SOURCE_LIMITS.results || characters >= RESEARCH_SOURCE_LIMITS.totalCharacters;
  return findings.map((finding): QuoteCheck => {
    const parts = quoteParts(finding.quote);
    const link = normalizeFetchUrl(finding.url);
    const citedHost = hostOf(finding.url);
    // The cited page's own text first, then a page that may be it, and another page's last.
    const ranked = pages.map((page) => ({ page, source: sourceOf(page, link, citedHost) })).sort((a, b) => SOURCE_ORDER[a.source.kind] - SOURCE_ORDER[b.source.kind]);
    for (const { page, source } of ranked) {
      const span = spanOf(page.text, parts);
      if (span) return { excerpt: excerptOf(page.text, span, source), opened: page.index, status: "found" };
    }
    if (link && partialLinks.has(link)) return { reason: "partial_source", status: "not_checked" };
    if (link && fetched.has(link)) return { status: "not_verbatim" };
    if (citedHost && browsed.has(citedHost)) return { reason: "browser_page", status: "not_checked" };
    if (others.some((text) => holds(text, parts))) return { reason: "other_tool_output", status: "not_checked" };
    if (unlinkedPartial) return { reason: "partial_source", status: "not_checked" };
    if (overLimit) return { reason: "sources_over_limit", status: "not_checked" };
    return { reason: snippets.some((text) => holds(text, parts)) ? "search_snippet_only" : "not_in_opened_text", status: "unsupported" };
  });
}
