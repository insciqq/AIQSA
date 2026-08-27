export const MEMORY_LEXICAL_QUERY_MAX_TERMS = 64;
export const MEMORY_TRIGRAM_QUERY_MAX_TERMS = 24;
export const MEMORY_TRIGRAM_MIN_TERM_CHARACTERS = 3;

export type MemoryLexicalQueryAnalysis = Readonly<{
  englishTerms: readonly string[];
  hasCyrillic: boolean;
  hasLatin: boolean;
  normalized: string;
  russianTerms: readonly string[];
  simpleTerms: readonly string[];
  trigramTerms: readonly string[];
}>;

const cyrillic = /\p{Script=Cyrillic}/u;
const latin = /\p{Script=Latin}/u;

export function normalizeMemoryLexicalProjection(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е")
    .trim()
    .replace(/\s+/gu, " ");
}

function uniqueTerms(value: string): string[] {
  const seen = new Set<string>();
  return (value.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((term) => {
    if (seen.has(term) || seen.size >= MEMORY_LEXICAL_QUERY_MAX_TERMS) return [];
    seen.add(term);
    return [term];
  });
}

/** Deterministic script routing only. It never infers a language from meaning,
 * translates text, or removes neutral identifiers/numbers from the simple lane. */
export function analyzeMemoryLexicalQuery(value: string): MemoryLexicalQueryAnalysis {
  const normalized = normalizeMemoryLexicalProjection(value);
  const simpleTerms = uniqueTerms(normalized);
  const englishTerms = simpleTerms.filter((term) => latin.test(term));
  const russianTerms = simpleTerms.filter((term) => cyrillic.test(term));
  const trigramTerms = simpleTerms
    .map((term, index) => ({ index, length: Array.from(term).length, term }))
    .filter(({ length }) => length >= MEMORY_TRIGRAM_MIN_TERM_CHARACTERS)
    .sort((left, right) => right.length - left.length || left.index - right.index)
    .slice(0, MEMORY_TRIGRAM_QUERY_MAX_TERMS)
    .map(({ term }) => term);
  return Object.freeze({
    englishTerms: Object.freeze(englishTerms),
    hasCyrillic: russianTerms.length > 0,
    hasLatin: englishTerms.length > 0,
    normalized,
    russianTerms: Object.freeze(russianTerms),
    simpleTerms: Object.freeze(simpleTerms),
    trigramTerms: Object.freeze(trigramTerms)
  });
}
