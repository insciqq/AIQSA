export const MEMORY_LEXICAL_QUERY_MAX_TERMS = 64;
export const MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION =
  "memory-unicode-query-analysis-v1";
export const MEMORY_NGRAM_QUERY_MAX_TERMS = 24;
export const MEMORY_NGRAM_MIN_TERM_CHARACTERS = 2;

export type MemoryLexicalQueryAnalysis = Readonly<{
  analysisVersion: typeof MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION;
  logicalTerms: readonly string[];
  ngramTerms: readonly string[];
  normalized: string;
}>;

export function normalizeMemoryLexicalProjection(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .trim()
    .replace(/\s+/gu, " ");
}

function uniqueTerms(value: string): string[] {
  const seen = new Set<string>();
  return (value.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []).flatMap((term) => {
    if (seen.has(term) || seen.size >= MEMORY_LEXICAL_QUERY_MAX_TERMS) return [];
    seen.add(term);
    return [term];
  });
}

/** Language- and script-neutral query material. Providers may apply bounded
 * supplemental analysis, but this contract never selects a language analyzer. */
export function analyzeMemoryLexicalQuery(value: string): MemoryLexicalQueryAnalysis {
  const normalized = normalizeMemoryLexicalProjection(value);
  const logicalTerms = uniqueTerms(normalized);
  const ngramTerms = logicalTerms
    .map((term, index) => ({ index, length: Array.from(term).length, term }))
    .filter(({ length }) => length >= MEMORY_NGRAM_MIN_TERM_CHARACTERS)
    .sort((left, right) => right.length - left.length || left.index - right.index)
    .slice(0, MEMORY_NGRAM_QUERY_MAX_TERMS)
    .map(({ term }) => term);
  return Object.freeze({
    analysisVersion: MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION,
    logicalTerms: Object.freeze(logicalTerms),
    ngramTerms: Object.freeze(ngramTerms),
    normalized,
  });
}
