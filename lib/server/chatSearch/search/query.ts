/**
 * How a past-chat query becomes exact-word search units over the passages'
 * `simple` text-search column (`ChatSearchPassage.searchVectorSimple`).
 *
 * Production queries are keyword lists the model writes about earlier work:
 * ticket and campaign numbers, file names, names and topics. So word search
 * is an OR over the query's terms in which rare and long terms outweigh common
 * ones, and an identifier the query names exactly wins over text that only
 * means something similar. Everything stays language-neutral: terms come from
 * PostgreSQL's own `simple` parser (the same one that built the passages'
 * column, so both sides split punctuation, Cyrillic, mixed scripts and
 * identifiers alike) and from the query's whitespace-separated chunks; no
 * vocabulary, stemming or language rule decides anything.
 *
 * Three kinds of unit, each an independent `tsquery`:
 * - `exact`: one lexeme of `to_tsvector('simple', query)`. `ABC-1234` gives
 *   `abc-1234`, `abc` and `1234`, so a passage with the whole identifier
 *   matches all three and one with only a part matches less.
 * - `prefix`: a letters-only lexeme of at least four letters as a prefix
 *   (`template:*` finds "templates", `договор:*` finds "договора"), at half
 *   weight and never added to its exact match: words of the same stem are
 *   likely, not certain, matches.
 * - `phrase`: a chunk that holds punctuation between letters or digits
 *   (`campaign_42`, `report_2026-11-12.xlsx`) or is identifier-like
 *   (`1234`), through `phraseto_tsquery`, which keeps its parts adjacent and in order.
 *
 * A unit's weight is its BM25 inverse document frequency over the owner's
 * passages times a length factor (longer terms say more) and an identifier
 * factor (terms with digits or joining punctuation). A passage's score sums,
 * per term, the best unit it matched. An identifier-like phrase matched by few
 * of the owner's passages pins them: they come before every other result
 * (`rank.ts`), because the model named exactly that thing. A common unit
 * (`COMMON_SHARE`) never brings a passage in on its own.
 */

export const PAST_CHAT_QUERY_LIMITS = Object.freeze({
  /** Lexemes of the query the statistics read, longest first. */
  lexemes: 32,
  /** Phrase units, longest chunks first. */
  phrases: 12
});

/** Prefix units are this long at least, in code points. */
const PREFIX_MIN_LENGTH = 4;
const PREFIX_FACTOR = 0.5;
const IDENTIFIER_FACTOR = 1.5;
/** Length in code points at which a term gets its full length factor. */
const FULL_LENGTH = 12;
/** An identifier pins passages when at most this many of the owner's passages hold it, or this share of them. */
const PIN_MAX_PASSAGES = 5;
const PIN_MAX_SHARE = 0.02;
/**
 * A unit held by more than this share of the owner's passages is common: the
 * `simple` configuration keeps function words ("the", "for", "и", "после"),
 * which sit in most conversational passages, while a content word, even a
 * user's main project name, rarely reaches a quarter of them. BM25 then gives
 * it at most ln 4 ≈ 1.4, and alone it says nothing about relevance. Below
 * `COMMON_MIN_PASSAGES` a share moves by several points per passage, so no
 * unit is common there.
 */
const COMMON_SHARE = 0.25;
const COMMON_MIN_PASSAGES = 50;

const LETTERS_ONLY = /^[\p{L}\p{M}]+$/u;
const DIGIT = /\p{N}/u;
/** Punctuation that joins the parts of an identifier, a file name or a path. A hyphen alone joins words too, so it needs a digit. */
const JOINER = /[\p{L}\p{N}][_./:#@\\+][\p{L}\p{N}]/u;
const INNER_PUNCTUATION = /[\p{L}\p{N}][^\p{L}\p{M}\p{N}\s]+[\p{L}\p{N}]/u;
const EDGE = /^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu;

function codePoints(value: string): number {
  return [...value].length;
}

/** What the model wrote between spaces, without the punctuation around it, each once. */
export function pastChatQueryChunks(query: string): string[] {
  const seen = new Set<string>();
  const chunks: string[] = [];
  for (const raw of query.split(/\s+/u)) {
    const chunk = raw.replace(EDGE, "");
    const key = chunk.toLowerCase();
    if (!chunk || seen.has(key)) continue;
    seen.add(key);
    chunks.push(chunk);
  }
  return chunks;
}

/** A term that names one thing: at least three characters with a digit or with punctuation joining its parts. */
export function identifierLike(term: string): boolean {
  return codePoints(term) >= 3 && (DIGIT.test(term) || JOINER.test(term));
}

/** The chunks whose phrase units the statistics read: identifiers and chunks with inner punctuation, longest first. */
export function pastChatPhraseChunks(chunks: readonly string[]): string[] {
  return chunks.filter((chunk) => identifierLike(chunk) || INNER_PUNCTUATION.test(chunk))
    .sort((left, right) => codePoints(right) - codePoints(left) || (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, PAST_CHAT_QUERY_LIMITS.phrases);
}

/** One unit as the statistics query returns it: its `tsquery` text and how many of the owner's passages it matches. */
export type PastChatUnitStatistics = Readonly<{
  kind: "exact" | "prefix" | "phrase";
  /** The lexeme (exact, prefix) or the chunk (phrase). */
  key: string;
  /** The unit's `tsquery` as PostgreSQL writes it (`q::text`), cast back by the scoring query. */
  query: string;
  documentFrequency: number;
  /** The owner's passages. */
  passages: number;
}>;

/** A weighted unit of the scoring query. Units of one `term` count once per passage, by their best weight. */
export type PastChatWordUnit = Readonly<{
  term: string;
  query: string;
  weight: number;
  pin: boolean;
  /**
   * Whether a match of this unit alone brings a passage into the word lane.
   * A common unit only adds weight to a passage another unit brought.
   */
  admits: boolean;
  /** Text to look for in a passage that matched it, for its excerpt. */
  needle: string;
}>;

/** BM25's inverse document frequency, positive for every frequency. */
export function inverseDocumentFrequency(documentFrequency: number, passages: number): number {
  const total = Math.max(passages, documentFrequency);
  return Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function lengthFactor(term: string): number {
  return 0.5 + 0.5 * Math.min(codePoints(term), FULL_LENGTH) / FULL_LENGTH;
}

function pinLimit(passages: number): number {
  return Math.max(PIN_MAX_PASSAGES, Math.ceil(passages * PIN_MAX_SHARE));
}

function commonUnit(row: PastChatUnitStatistics): boolean {
  return row.passages >= COMMON_MIN_PASSAGES && row.documentFrequency > COMMON_SHARE * row.passages;
}

/**
 * The units weighed, merged where two kinds give the same `tsquery`. With
 * `absent`, a unit no passage holds is weighed as if one did: the most it
 * could have added, for the query's whole weight.
 */
function weighUnits(statistics: readonly PastChatUnitStatistics[], absent: boolean): PastChatWordUnit[] {
  const exactFrequency = new Map(statistics.filter((row) => row.kind === "exact").map((row) => [row.key, row.documentFrequency]));
  const byQuery = new Map<string, PastChatWordUnit>();
  for (const row of statistics) {
    if (!row.query || (row.documentFrequency < 1 && !absent)) continue;
    const frequency = Math.max(1, row.documentFrequency);
    const idf = inverseDocumentFrequency(frequency, row.passages);
    const admits = !commonUnit(row);
    let unit: PastChatWordUnit;
    if (row.kind === "exact") {
      unit = { admits, needle: row.key, pin: false, query: row.query, term: `w:${row.key}`,
        weight: idf * lengthFactor(row.key) * (identifierLike(row.key) ? IDENTIFIER_FACTOR : 1) };
    } else if (row.kind === "prefix") {
      // A prefix that matches only what the exact lexeme matches adds nothing.
      if (codePoints(row.key) < PREFIX_MIN_LENGTH || !LETTERS_ONLY.test(row.key) ||
        row.documentFrequency <= (exactFrequency.get(row.key) ?? 0)) continue;
      unit = { admits, needle: row.key, pin: false, query: row.query, term: `w:${row.key}`,
        weight: idf * lengthFactor(row.key) * PREFIX_FACTOR };
    } else {
      const identifier = identifierLike(row.key);
      unit = { admits, needle: row.key, pin: identifier && row.documentFrequency >= 1 && row.documentFrequency <= pinLimit(row.passages),
        query: row.query, term: `p:${row.key.toLowerCase()}`, weight: idf * lengthFactor(row.key) * (identifier ? IDENTIFIER_FACTOR : 1) };
    }
    const same = byQuery.get(unit.query);
    // A phrase of one lexeme is that lexeme's exact unit: one term, the higher weight, pinned if either pins.
    byQuery.set(unit.query, same
      ? { ...same, admits: same.admits || unit.admits, pin: same.pin || unit.pin, weight: Math.max(same.weight, unit.weight),
        term: same.term.startsWith("w:") ? same.term : unit.term }
      : unit);
  }
  return [...byQuery.values()].sort((left, right) => right.weight - left.weight || (left.query < right.query ? -1 : 1));
}

/**
 * The scoring query's units from the statistics: weighted, merged where two
 * kinds give the same `tsquery`, and without units that match nothing. When
 * every unit is common, each admits, so a query of common words still finds
 * the passages that hold them.
 */
export function pastChatWordUnits(statistics: readonly PastChatUnitStatistics[]): PastChatWordUnit[] {
  const units = weighUnits(statistics, false);
  return units.some((unit) => unit.admits) ? units : units.map((unit) => ({ ...unit, admits: true }));
}

/**
 * The query's whole weight: per term, the most a passage scores for it (its
 * best unit that some passage holds), and for a term no passage holds, what
 * it would weigh if one did (`rank.ts` fuses a word match by the share of
 * this it covers). Words of the query the owner never wrote count, so a
 * passage that shares only "for" and "the" with a query in another language
 * covers little of it.
 */
export function pastChatQueryWeight(statistics: readonly PastChatUnitStatistics[]): number {
  const held = new Map<string, number>();
  for (const unit of weighUnits(statistics, false)) held.set(unit.term, Math.max(held.get(unit.term) ?? 0, unit.weight));
  const missing = new Map<string, number>();
  for (const unit of weighUnits(statistics, true)) {
    if (!held.has(unit.term)) missing.set(unit.term, Math.max(missing.get(unit.term) ?? 0, unit.weight));
  }
  return [...held.values(), ...missing.values()].reduce((sum, weight) => sum + weight, 0);
}
