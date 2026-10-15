/** Lower-cased, space-separated words of a search query; none for a blank query. */
export function searchTokens(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word occurs somewhere in the text, ignoring case. */
export function textMatchesTokens(text: string, tokens: readonly string[]): boolean {
  const haystack = text.toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
