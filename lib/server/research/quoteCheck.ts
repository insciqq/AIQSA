import type { ResearchFinding } from "../../contracts/research";
import { HARNESS_SEARCH_TOOL } from "../engine/prompts/harness";
import { normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchOpenedSource } from "./gates";
import { RESEARCH_SOURCE_LIMITS } from "./sources";

/**
 * The check with no model in it: each finding's verbatim quote must be in text
 * an agent of this run really opened. It catches invented quotes and unread
 * sources without anyone's opinion.
 *
 * A miss is only a failure when it could not have been read some other way:
 * - `found`: the quote is in opened text. Where on the run it was read is the
 *   verifier's to judge against the cited link; a redirect or a page seen under
 *   another address must not read as invention here.
 * - `not_checked`: the text that could hold it is not here: the page was read
 *   through the browser and not stored, a stored copy could not be read, the run's
 *   opened text is over what one check reads, or nothing could be read at all.
 * - `unsupported`: every place it could be was read and it is not there
 *   (`not_in_opened_text`), or it is only in search results, so the page itself was
 *   never opened and a snippet is no evidence (`search_snippet_only`).
 */
export type QuoteCheck =
  | Readonly<{ status: "found" }>
  | Readonly<{ reason: "browser_page" | "partial_source" | "sources_over_limit" | "sources_unreadable"; status: "not_checked" }>
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

const INVISIBLE = /[­​-‍⁠﻿]/gu;
const QUOTE_MARKS = /['"`«´»‘-‟′-‷‹›〝-〟]/gu;
const DASHES = /[‐-―⁃−﹘﹣－]/gu;
const MARKDOWN_LINK_TARGET = /\]\([^)\s]*\)/gu;
const MARKUP = /[*_[\]]/gu;

/**
 * What "verbatim" tolerates, applied alike to a quote and to opened text, so what a saved result's form or a model's
 * copying changed is no invention, while different words still miss:
 * - JSON escapes, a few levels deep, since a saved result is often JSON-stringified (`\n`, `\"`, `é`).
 * - Compatibility forms (NFKC: no-break spaces, ligatures, the one-character ellipsis) and invisible characters
 *   (soft hyphens, zero-width ones), which pages hold and models drop.
 * - Typographic quotes of every kind fold to one mark, and dashes to the hyphen.
 * - Markdown emphasis and link targets, which a Markdown page has and a model copying its words leaves out.
 * - Runs of whitespace, and case: a quote that starts a sentence is capitalized.
 */
export function normalizeQuotedText(text: string): string {
  return unescaped(text).normalize("NFKC").replace(INVISIBLE, "").replace(QUOTE_MARKS, "\"").replace(DASHES, "-")
    .replace(MARKDOWN_LINK_TARGET, "").replace(MARKUP, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * A quote's parts: a model marks what it left out with an ellipsis, so each part must be there, in order. Quotation
 * marks around it and punctuation closing it are the model's. No letter or digit means it quotes nothing.
 */
function quoteParts(quote: string): readonly string[] {
  return normalizeQuotedText(quote).split(/\.{3,}/u).map((part) => part.replace(/^[\s"]+|[\s"',.;:!?]+$/gu, ""))
    .filter((part) => /[\p{L}\p{N}]/u.test(part));
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
  const snippets: string[] = [];
  const partialLinks = new Set<string>();
  const browsed = new Set<string>();
  let unlinkedPartial = false;
  let characters = 0;
  for (const source of opened) {
    characters += source.text.length;
    const link = source.url ? normalizeFetchUrl(source.url) : null;
    if (source.partial) {
      if (link) partialLinks.add(link);
      // A result with no link may be a page from anywhere; a search result's text is no page.
      else if (!HARNESS_SEARCH_TOOL.test(source.toolName)) unlinkedPartial = true;
    }
    for (const host of browserHosts(source.text)) browsed.add(host);
    (HARNESS_SEARCH_TOOL.test(source.toolName) ? snippets : pages).push(normalizeQuotedText(source.text));
  }
  const overLimit = opened.length >= RESEARCH_SOURCE_LIMITS.results || characters >= RESEARCH_SOURCE_LIMITS.totalCharacters;
  return findings.map((finding): QuoteCheck => {
    const parts = quoteParts(finding.quote);
    if (pages.some((text) => holds(text, parts))) return { status: "found" };
    const link = normalizeFetchUrl(finding.url);
    if (link && partialLinks.has(link) || unlinkedPartial) return { reason: "partial_source", status: "not_checked" };
    const host = hostOf(finding.url);
    if (host && browsed.has(host)) return { reason: "browser_page", status: "not_checked" };
    if (overLimit) return { reason: "sources_over_limit", status: "not_checked" };
    return { reason: snippets.some((text) => holds(text, parts)) ? "search_snippet_only" : "not_in_opened_text", status: "unsupported" };
  });
}
