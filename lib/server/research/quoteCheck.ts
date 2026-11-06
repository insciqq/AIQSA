import type { ResearchFinding, ResearchRating } from "../../contracts/research";
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

export function browserHosts(text: string): readonly string[] {
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

/**
 * A figure a claim gives: a number with its unit, as the claim writes it (`3 см`, `59 732 ₽`, `160×200 см`, `7 зон`). On a real run the
 * verifier found most claims only partly supported because their figures were in no quote, so `record_evidence` names each one its quote
 * lacks while the agent still has the page, with no model. `parts` are a dimension's or a range's numbers, each with every value its writing
 * may mean; `scale` lets another unit of its dimension match (`1,5 м` is `150 см`).
 */
export type ClaimFigure = Readonly<{ parts: readonly (readonly number[])[]; scale: UnitScale | null; text: string }>;

type UnitScale = Readonly<{ dimension: string; factor: number }>;

/** A thousands group is split by a space of any width (normalized to one by then) or an apostrophe; a point or a comma may split it too. */
const NUMBER_SOURCE = "\\d+(?:[.,]\\d+|[ '\\u2019]\\d{3}(?!\\d))*";
const NUMBER = new RegExp(NUMBER_SOURCE, "gu");
/**
 * A number, a dimension or a range in a claim: `160×200`, `160 x 200`, `160 х 200` (Cyrillic), `3-5`. A number glued to a letter on its
 * left is a name (`S24`, `COVID-19`), and one after `/` or `:` is part of a ratio or a time.
 */
const CLAIM_NUMBERS = new RegExp(`(?<![\\p{L}\\p{N}.,/:])(?<!\\p{L}[-/])${NUMBER_SOURCE}(?:\\s?[x×хX-]\\s?${NUMBER_SOURCE})*`, "gu");
const JOINER = /\s?[x×хX-]\s?(?=\d)/u;
const CURRENCY_BEFORE = /[$€£¥₽] ?$/u;
/** What may follow a number as its unit, glued, after a space or a hyphen (`7-зонный`). */
const UNIT_AT = /(?:\s|-)?(%|‰|°\s?[CFС]?|[$€£¥₽]|[\p{L}µ°]+[²³]?(?:\/\p{L}+[²³]?)?\.?)/uy;

/** Words after a number that are no unit of it: `4,8 из 5`, `3 of 11`, `2 de 5`. */
const NOT_UNITS: ReadonlySet<string> = new Set([
  "а", "без", "в", "во", "для", "до", "же", "за", "и", "из", "или", "к", "ко", "как", "между", "на", "над", "не", "ни", "но", "о", "об", "около", "от", "перед", "по",
  "под", "после", "при", "против", "с", "со", "то", "у", "чем", "что", "это",
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "if", "in", "is", "of", "on", "or", "out", "per", "than", "that", "the", "to", "vs", "was",
  "were", "which", "with",
  "al", "con", "de", "del", "e", "el", "en", "es", "la", "las", "lo", "los", "más", "menos", "o", "para", "por", "que", "se", "sin", "son", "u", "un", "una", "y"
]);

/** Units written with a capital, which an ordinary word after a number (`15 Pro`) is not. */
const CAPITAL_UNITS: ReadonlySet<string> = new Set(["A", "Ah", "ARS", "CLP", "COP", "EUR", "GB", "Gb", "Gbps", "GHz", "GBP", "Hz", "K", "KB", "MB", "Mb", "Mbps", "MHz",
  "MP", "MPa", "MW", "MXN", "N", "Pa", "RUB", "TB", "USD", "V", "W", "Wh", "В", "Вт", "Гб", "ГБ", "Гц", "ГГц", "Мб", "МБ", "МГц", "МП", "Мп", "МПа", "Н", "Па", "ТБ"]);

/**
 * Units and counted things in the research languages that count after a name too: `Flex 20 стоит` gives no figure `20 стоит`, while
 * `Flex 20 имеет 7 зон` gives `7 зон`. After any other word, any word that is no function word counts something.
 */
const KNOWN_UNIT = new RegExp("^(?:" + [
  "мм", "см", "дм", "м", "км", "мг", "г", "гр", "кг", "т", "мл", "л", "шт", "штук\\p{L}*", "руб\\p{L}*", "р", "коп\\p{L}*", "долл\\p{L}*", "евро", "тыс\\p{L}*", "млн",
  "млрд", "вт", "квт\\p{L}*", "ватт\\p{L}*", "ч", "час\\p{L}*", "мин", "минут\\p{L}*", "сек", "секунд\\p{L}*", "дн\\p{L}*", "день", "сут\\p{L}*", "недел\\p{L}*", "мес",
  "месяц\\p{L}*", "год\\p{L}*", "лет", "раз", "раза", "зон\\p{L}*", "сло[йяеёю]\\p{L}*", "пружин\\p{L}*", "отзыв\\p{L}*", "оцен\\p{L}*", "звезд\\p{L}*", "звёзд\\p{L}*",
  "балл\\p{L}*", "процент\\p{L}*", "человек", "градус\\p{L}*", "литр\\p{L}*", "метр\\p{L}*", "сантиметр\\p{L}*", "миллиметр\\p{L}*", "километр\\p{L}*", "грамм\\p{L}*",
  "килограмм\\p{L}*", "тонн\\p{L}*", "миллион\\p{L}*", "миллиард\\p{L}*", "кв", "куб",
  "mm", "cm", "m", "km", "mg", "g", "kg", "t", "ml", "l", "lb", "lbs", "oz", "ft", "pcs", "kw", "kwh", "w", "h", "hrs?", "min", "mins", "s", "sec", "k", "bn",
  "dollars?", "euros?", "pounds?", "cents?", "rubles?", "thousands?", "millions?", "billions?", "percent", "zones?", "layers?", "years?", "months?", "weeks?", "days?",
  "hours?", "minutes?", "seconds?", "times", "pieces?", "reviews?", "ratings?", "stars?", "points?", "springs?", "coils?", "people", "persons?", "degrees?",
  "meters?", "metres?", "inch(?:es)?", "feet", "foot", "grams?", "kilograms?", "kilos?", "tons?", "tonnes?", "liters?", "litres?", "watts?", "volts?",
  "zonas?", "capas?", "años?", "meses", "mes", "semanas?", "días?", "horas?", "minutos?", "segundos?", "veces", "piezas?", "unidades", "reseñas?", "opiniones",
  "estrellas?", "puntos?", "muelles?", "resortes?", "personas?", "grados?", "metros?", "centímetros?", "milímetros?", "kilómetros?", "gramos?", "kilogramos?",
  "toneladas?", "litros?", "pesos?", "dólares?", "mil", "millones", "millón"
].join("|") + ")$", "u");

/** Units a figure may be written in another of: a claim's `1,5 м` is a page's `150 см`, and `1,2 млн` its `1 200 000`. */
const SCALES: readonly Readonly<{ dimension: string; factor: number; unit: RegExp }>[] = [
  { dimension: "length", factor: 0.001, unit: /^(?:мм|mm|миллиметр\p{L}*|millimet\p{L}*|milímetros?)$/u },
  { dimension: "length", factor: 0.01, unit: /^(?:см|cm|сантиметр\p{L}*|centimet\p{L}*|centímetros?)$/u },
  { dimension: "length", factor: 1, unit: /^(?:м|m|метр|метра|метров|метрах|meters?|metres?|metros?)$/u },
  { dimension: "length", factor: 1000, unit: /^(?:км|km|километр\p{L}*|kilomet\p{L}*|kilómetros?)$/u },
  { dimension: "mass", factor: 0.000001, unit: /^(?:мг|mg)$/u },
  { dimension: "mass", factor: 0.001, unit: /^(?:г|гр|g|грамм\p{L}*|grams?|gramos?)$/u },
  { dimension: "mass", factor: 1, unit: /^(?:кг|kg|килограмм\p{L}*|kilograms?|kilogramos?|kilos?)$/u },
  { dimension: "mass", factor: 1000, unit: /^(?:т|t|тонн\p{L}*|tons?|tonnes?|toneladas?)$/u },
  { dimension: "volume", factor: 0.001, unit: /^(?:мл|ml|миллилитр\p{L}*|millilit\p{L}*|mililitros?)$/u },
  { dimension: "volume", factor: 1, unit: /^(?:л|l|литр\p{L}*|liters?|litres?|litros?)$/u },
  { dimension: "number", factor: 1000, unit: /^(?:тыс\p{L}*|k|thousands?|mil)$/iu },
  { dimension: "number", factor: 1_000_000, unit: /^(?:млн|миллион\p{L}*|millions?|millón|millones|mln)$/iu },
  { dimension: "number", factor: 1_000_000_000, unit: /^(?:млрд|миллиард\p{L}*|billions?|bn)$/iu }
];

/** Small numbers a page may spell out, so `7 зон` is on a page that says `семь зон` or `семизонный`. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  один: 1, одна: 1, одно: 1, одного: 1, одной: 1, два: 2, две: 2, двух: 2, три: 3, трёх: 3, трех: 3, четыре: 4, четырёх: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6,
  шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10
};
const NUMBER_PREFIXES: readonly (readonly [string, number])[] = [["одно", 1], ["двух", 2], ["дву", 2], ["трёх", 3], ["трех", 3], ["четырёх", 4], ["четырех", 4],
  ["пяти", 5], ["шести", 6], ["семи", 7], ["восьми", 8], ["девяти", 9], ["десяти", 10]];

const canonical = (value: number) => Number(value.toPrecision(12));

/** Whether these groups are thousands: one to three digits, then threes. */
const thousands = (groups: readonly string[]) => groups.length > 1 && groups[0]!.length <= 3 && groups.slice(1).every((group) => group.length === 3);

/**
 * What a written number may mean. A space or an apostrophe only groups thousands; a lone point or comma before three digits may be
 * either (`1.500` is 1500 in Spanish and 1.5 in English), so both count; a last separator unlike the others is the decimal one
 * (`59 732,50`, `1,234.56`). Nothing for a writing no number has, such as a date.
 */
function valuesOf(token: string): readonly number[] {
  const groups = token.split(/\D/u);
  const separators = (token.match(/\D/gu) ?? []).map((separator) => /[.,]/u.test(separator) ? separator : " ");
  if (separators.length === 0) return [Number(token)];
  const values: number[] = [];
  const last = separators.at(-1)!;
  const before = separators.slice(0, -1);
  if (last !== " " && !before.includes(last) && new Set(before).size <= 1 && (before.length === 0 || thousands(groups.slice(0, -1)))) {
    values.push(Number(`${groups.slice(0, -1).join("")}.${groups.at(-1)!}`));
  }
  if (new Set(separators).size === 1 && thousands(groups)) values.push(Number(groups.join("")));
  return values.map(canonical);
}

function scaleOf(unit: string): UnitScale | null {
  const bare = unit.replace(/\.$/u, "");
  const found = SCALES.find(({ unit: pattern }) => pattern.test(bare));
  return found ? { dimension: found.dimension, factor: found.factor } : null;
}

/**
 * The unit right after a number at `at`, with where it ends, if what follows is one: a symbol, a unit, or a word that counts something
 * (`зон`, `layers`, `capas`). `named`: the number follows a name, after which only a known unit counts.
 */
function unitAt(text: string, at: number, named: boolean): Readonly<{ end: number; unit: string }> | null {
  UNIT_AT.lastIndex = at;
  const match = UNIT_AT.exec(text);
  if (!match) return null;
  const unit = match[1]!;
  const found = { end: at + match[0].length, unit };
  if (!/^[\p{L}µ]/u.test(unit)) return found;
  const bare = unit.replace(/\.$/u, "");
  if (NOT_UNITS.has(bare)) return null;
  if (CAPITAL_UNITS.has(bare) || KNOWN_UNIT.test(bare.toLowerCase())) return found;
  return !named && /^\p{Ll}/u.test(bare) ? found : null;
}

/** A capitalized word or one with a digit just before a number names a thing: `Flex 20`, `iPhone 15`, `Galaxy S24 5`. */
const NAME_BEFORE = /(?:^|\s)(?:\p{Lu}|\S*\d)\S*\s$/u;

/** At most this many figures of one claim: a claim is a sentence, and the result stays short. */
const CLAIM_FIGURE_LIMIT = 16;

/**
 * The figures a claim gives. Only a number with a unit or a currency is one, so a model's name, a rating's `из 5` and a number
 * no number reads as (`12.05.2024`) are left out: the check stays quiet rather than ask for what is no figure.
 */
export function claimFigures(claim: string): readonly ClaimFigure[] {
  const text = normalizeQuotedText(claim);
  const figures: ClaimFigure[] = [];
  for (const match of text.matchAll(CLAIM_NUMBERS)) {
    const start = match.index;
    const leading = text.slice(Math.max(0, start - 2), start);
    const currency = CURRENCY_BEFORE.exec(leading);
    const from = currency ? start - currency[0].length : start;
    const unit = unitAt(text, start + match[0].length, NAME_BEFORE.test(text.slice(Math.max(0, from - 40), from)));
    if (!unit && !currency) continue;
    const parts = match[0].split(JOINER).map(valuesOf);
    if (parts.some((values) => values.length === 0)) continue;
    const shown = text.slice(from, unit?.end ?? start + match[0].length).replace(/\.$/u, "");
    if (figures.some((figure) => figure.text === shown)) continue;
    figures.push({ parts, scale: unit ? scaleOf(unit.unit) : null, text: shown });
    if (figures.length >= CLAIM_FIGURE_LIMIT) break;
  }
  return figures;
}

/** A price a claim gives: one number in one currency, as the claim writes it (`59 732 ₽`, `$1,299`, `25 тыс. руб.`). */
export type ClaimPrice = Readonly<{ currency: string; text: string; value: number }>;

/**
 * Currencies as claims write them. A sign several currencies share keeps a code of its own (`$` is the dollar and many pesos, `¥` the yen and the yuan), so
 * only prices written alike compare; `₽`, `р.` and `руб.` are all the ruble.
 */
const CURRENCIES: readonly Readonly<{ code: string; unit: RegExp }>[] = [
  { code: "RUB", unit: /^(?:₽|руб\p{L}*|р|rub|rubles?|roubles?)$/iu },
  { code: "EUR", unit: /^(?:€|eur|euros?|евро)$/iu },
  { code: "GBP", unit: /^(?:£|gbp)$/iu },
  { code: "USD", unit: /^(?:usd|dollars?|долл\p{L}*)$/iu },
  { code: "$", unit: /^\$$/u },
  { code: "¥", unit: /^¥$/u },
  { code: "MXN", unit: /^mxn$/iu },
  { code: "ARS", unit: /^ars$/iu },
  { code: "CLP", unit: /^clp$/iu },
  { code: "COP", unit: /^cop$/iu },
  { code: "peso", unit: /^pesos?$/iu }
];

const currencyOf = (unit: string) => CURRENCIES.find(({ unit: pattern }) => pattern.test(unit.trim().replace(/\.$/u, "")))?.code ?? null;

/** Words that make a price a range's upper end, which is no price: `от 25 000 до 32 000 ₽` gives none, `от 25 000 ₽ до 32 000 ₽` its lower end. */
const UPPER_BOUND_BEFORE = /(?:^|[\s(])(?:до|to|under|below|hasta|fins a)\s$/iu;
/** A size before a price, as in `160×200 — 25 000 ₽`: a spaced dash after a dimension is no range, and the price is what follows it. */
const SIZE_THEN_PRICE = /^.*\d ?[x×хX] ?\d[^-]* - (\d[^x×хX-]*)$/u;

/** Not a letter on either side, which `\b` cannot say of Cyrillic. */
const word = (words: string) => `(?<!\\p{L})(?:${words})(?!\\p{L})`;

/**
 * What makes a claim's amounts no full price today: an instalment, a credit or a periodic payment (`2 500 ₽/мес`, `× 24`), and an earlier or crossed-out price
 * (`было 49 990 ₽`). On review a claim of an instalment read as the cheapest offer of its option. Months alone are no sign, since a warranty gives them too.
 */
const NOT_A_PRICE_NOW = new RegExp([
  "рассрочк", "кредит", "платеж", "платёж", "ежемесячн", `в ${word("мес|мес\\.|месяц")}`, "/ ?мес", "instal{1,2}ment", "financ", "monthly", "per month", word("a month"),
  "/ ?mo(?!\\p{L})", "/ ?month", "cuota", "a plazos", word("al mes"), "/ ?mes(?!\\p{L})", "mensual", "[$€£¥₽] ?[x×хX] ?\\d", "руб\\.? ?[x×хX] ?\\d",
  "(?:[$€£¥₽]|руб\\.?) ?(?:на|за) \\d+ ?мес",
  word("было"), "стар(?:ая|ой) цен", "зач[её]ркн", word("вместо"), "без скидки", "до скидки", "old price", "regular price", "before discount", word("was"),
  "precio anterior", word("antes")
].join("|"), "iu");

/**
 * The prices a claim gives, found as `claimFigures` finds figures, with a currency sign before the number or a currency after it, a count such as `тыс.` or `k`
 * in between taken in. A range or a dimension is no one price, nor is a range's upper end. A lone point or comma before three digits groups thousands, since no
 * price has three decimals. A claim of an instalment or of an earlier price gives none at all (`NOT_A_PRICE_NOW`): which of its amounts is the full price now is
 * not something its words show reliably, so it stays the model's word.
 */
export function claimPrices(claim: string): readonly ClaimPrice[] {
  const text = normalizeQuotedText(claim);
  if (NOT_A_PRICE_NOW.test(text)) return [];
  const prices: ClaimPrice[] = [];
  for (const match of text.matchAll(CLAIM_NUMBERS)) {
    const token = SIZE_THEN_PRICE.exec(match[0])?.[1] ?? match[0];
    const start = match.index + match[0].length - token.length;
    const sign = CURRENCY_BEFORE.exec(text.slice(Math.max(0, start - 2), start));
    const from = sign ? start - sign[0].length : start;
    const unit = unitAt(text, start + token.length, NAME_BEFORE.test(text.slice(Math.max(0, from - 40), from)));
    const count = unit ? scaleOf(unit.unit) : null;
    const factor = count?.dimension === "number" ? count.factor : 1;
    const after = unit && factor !== 1 ? unitAt(text, unit.end, false) : unit;
    const currency = sign ? currencyOf(sign[0]) : after ? currencyOf(after.unit) : null;
    const parts = token.split(JOINER).map(valuesOf);
    if (currency === null || parts.length !== 1 || parts[0]!.length === 0 || UPPER_BOUND_BEFORE.test(text.slice(Math.max(0, from - 12), from))) continue;
    const end = (sign ? factor !== 1 ? unit : null : after)?.end ?? start + token.length;
    const shown = text.slice(from, end).replace(/\.$/u, "");
    if (prices.some((price) => price.text === shown)) continue;
    prices.push({ currency, text: shown, value: canonical(Math.max(...parts[0]!) * factor) });
    if (prices.length >= CLAIM_FIGURE_LIMIT) break;
  }
  return prices;
}

/**
 * Every value a text writes a number for, read leniently, so that a figure there is rarely called missing: each meaning of an
 * ambiguous number, each group of a spaced one as well as the whole, small numbers in words, and a scaled unit's value in its
 * dimension. No unit is required beside a number, since a table puts it in the header.
 */
function textValues(text: string): ReadonlySet<string> {
  const normalized = normalizeQuotedText(text);
  const keys = new Set<string>();
  for (const match of normalized.matchAll(NUMBER)) {
    const token = match[0];
    const read = valuesOf(token);
    const values = /[ '’]/u.test(token) || read.length === 0 ? [...read, ...token.split(/\D/u).map((group) => canonical(Number(group)))] : read;
    const unit = unitAt(normalized, match.index + token.length, false);
    const scale = unit ? scaleOf(unit.unit) : null;
    for (const value of values) {
      keys.add(`number:${value}`);
      if (scale) keys.add(`${scale.dimension}:${canonical(value * scale.factor)}`);
    }
  }
  for (const [word] of normalized.toLowerCase().matchAll(/\p{L}+/gu)) {
    const value = NUMBER_WORDS[word] ?? NUMBER_PREFIXES.find(([prefix]) => word.startsWith(prefix) && word.length > prefix.length + 2)?.[1];
    if (value !== undefined) keys.add(`number:${value}`);
  }
  return keys;
}

function figureIn(figure: ClaimFigure, keys: ReadonlySet<string>): boolean {
  const { scale } = figure;
  return figure.parts.every((values) => values.some((value) => keys.has(`number:${value}`) || (scale !== null && keys.has(`${scale.dimension}:${canonical(value * scale.factor)}`))));
}

/** The figures this text does not write, in their order: a quote's, or a stored page's. */
export function figuresNotIn(figures: readonly ClaimFigure[], text: string): readonly ClaimFigure[] {
  if (figures.length === 0) return [];
  const keys = textValues(text);
  return figures.filter((figure) => !figureIn(figure, keys));
}

/**
 * A number as a rating's text writes it: digits, thousands groups split by a space of any width or an apostrophe before exactly three digits, then points or commas.
 * A line break never groups, nor does a space after a decimal part, so `4.7\n318` and `4,7 318` are two numbers; a symbol or a letter between two numbers parts them, and
 * a number glued to a letter on its left is a name's (`S24`).
 */
const RATING_NUMBER = /(?<![\p{L}\p{N}])(?:\d{1,3}(?:[ \u00A0\u2009\u202F'\u2019]\d{3}(?!\d))+|\d+)(?:[.,]\d+)*/gu;

/** What shortens a count right after its number: the count is the number it scales to (`12K` is 12 000), never the bare mantissa. */
const RATING_COUNT_SCALE = /[ \u00A0\u2009\u202F]?(K|k|M|[Тт]ыс\p{L}*|млн|миллион\p{L}*|thousands?|millions?|mil)(?!\p{L})/uy;
const MILLIONS = /^(?:M|млн|миллион|million)/u;

/**
 * The scores and the counts a rating's text writes. A score is any number not shortened, its decimal mark a point or a comma; a count is a whole number, a grouped one
 * read whole (`12 345`, `12,345`, and `12.345`, which may be either), or a shortened one scaled. Unlike `textValues`, which reads a page's figures leniently, no group
 * or mantissa stands for a number of its own, so a wrong count is not found in a right one.
 */
function ratingNumbers(text: string): Readonly<{ counts: ReadonlySet<number>; scores: ReadonlySet<number> }> {
  const written = unescaped(text).normalize("NFC").replace(INVISIBLE, "");
  const counts = new Set<number>();
  const scores = new Set<number>();
  for (const match of written.matchAll(RATING_NUMBER)) {
    const values = valuesOf(match[0]);
    RATING_COUNT_SCALE.lastIndex = match.index + match[0].length;
    const scale = RATING_COUNT_SCALE.exec(written);
    if (scale) {
      const factor = MILLIONS.test(scale[1]!) ? 1_000_000 : 1000;
      for (const value of values) counts.add(canonical(value * factor));
      continue;
    }
    for (const value of values) {
      scores.add(value);
      if (Number.isInteger(value)) counts.add(value);
    }
  }
  return { counts, scores };
}

/**
 * Which of a rating's numbers a text does not write: its score (`4,7` is 4.7, and `4.6/5`, `4,9 из 5` or `4.7 of 5` hold theirs) and its number of ratings as the page
 * writes it (`12 345`, `2,310`, `12,3 тыс.` is 12 300, `12K` is 12 000). The top of the scale is not asked for, since a card often shows its stars and no "of 5".
 */
export function ratingNumbersNotIn(rating: Pick<ResearchRating, "count" | "score">, text: string): readonly ("count" | "score")[] {
  const { counts, scores } = ratingNumbers(text);
  return [...scores.has(canonical(rating.score)) ? [] : ["score" as const], ...counts.has(rating.count) ? [] : ["count" as const]];
}
