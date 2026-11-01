import type { ResearchFinding } from "../../contracts/research";
import { normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchOpenedSource } from "./gates";
import { researchEvidenceKind, RESEARCH_SOURCE_LIMITS } from "./sources";

/**
 * The check with no model in it: each finding's verbatim quote must be in text
 * an agent of this run really opened. It catches invented quotes and unread
 * sources without anyone's opinion.
 *
 * Only `fetch_url` results and what a browser command printed are opened pages
 * (`researchEvidenceKind`): a quote `echo`ed into a file is no reading of a page.
 * A miss is only a failure when it could not have been read some other way:
 * - `found`: the quote is in an opened page. Where on the run it was read is the
 *   verifier's to judge against the cited link; a redirect or a page seen under
 *   another address must not read as invention here.
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
  | Readonly<{ status: "found" | "not_verbatim" }>
  | Readonly<{ reason: "browser_page" | "other_tool_output" | "partial_source" | "sources_over_limit" | "sources_unreadable"; status: "not_checked" }>
  | Readonly<{ reason: "not_in_opened_text" | "search_snippet_only"; status: "unsupported" }>;

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

function holds(text: string, parts: readonly string[]): boolean {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return parts.length > 0;
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

/** Reads the run's opened text once and answers per finding, in order. `opened` null: it could not be read at all. */
export function checkQuotes(findings: readonly Pick<ResearchFinding, "quote" | "url">[], opened: readonly ResearchOpenedSource[] | null): readonly QuoteCheck[] {
  if (!opened) return findings.map(() => ({ reason: "sources_unreadable", status: "not_checked" }));
  const pages: string[] = [];
  const others: string[] = [];
  const snippets: string[] = [];
  const fetched = new Set<string>();
  const partialLinks = new Set<string>();
  const browsed = new Set<string>();
  let unlinkedPartial = false;
  let characters = 0;
  for (const source of opened) {
    characters += source.text.length;
    const kind = researchEvidenceKind(source);
    if (kind === "agent_written") continue;
    const link = source.url ? normalizeFetchUrl(source.url) : null;
    if (source.partial) {
      if (link) partialLinks.add(link);
      // A result with no link may be a page from anywhere; a search result's text is no page.
      else if (kind !== "search") unlinkedPartial = true;
    } else if (link) fetched.add(link);
    for (const host of browserHosts(source.text)) browsed.add(host);
    (kind === "page" ? pages : kind === "search" ? snippets : others).push(normalizeQuotedText(source.text));
  }
  const overLimit = opened.length >= RESEARCH_SOURCE_LIMITS.results || characters >= RESEARCH_SOURCE_LIMITS.totalCharacters;
  return findings.map((finding): QuoteCheck => {
    const parts = quoteParts(finding.quote);
    if (pages.some((text) => holds(text, parts))) return { status: "found" };
    const link = normalizeFetchUrl(finding.url);
    if (link && partialLinks.has(link)) return { reason: "partial_source", status: "not_checked" };
    if (link && fetched.has(link)) return { status: "not_verbatim" };
    const host = hostOf(finding.url);
    if (host && browsed.has(host)) return { reason: "browser_page", status: "not_checked" };
    if (others.some((text) => holds(text, parts))) return { reason: "other_tool_output", status: "not_checked" };
    if (unlinkedPartial) return { reason: "partial_source", status: "not_checked" };
    if (overLimit) return { reason: "sources_over_limit", status: "not_checked" };
    return { reason: snippets.some((text) => holds(text, parts)) ? "search_snippet_only" : "not_in_opened_text", status: "unsupported" };
  });
}
