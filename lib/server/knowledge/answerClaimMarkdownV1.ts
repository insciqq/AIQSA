type DelimiterRunV1 = Readonly<{
  canClose: boolean;
  canOpen: boolean;
  length: number;
}>;

const unicodeWhitespacePattern = /\p{White_Space}/u;
// CommonMark treats both Unicode punctuation (P) and symbols (S) as
// punctuation when deciding whether an emphasis delimiter is flanking.
const unicodePunctuationPattern = /[\p{P}\p{S}]/u;

function isWhitespace(value: string | undefined): boolean {
  return value === undefined || unicodeWhitespacePattern.test(value);
}

function isPunctuation(value: string | undefined): boolean {
  return value !== undefined && unicodePunctuationPattern.test(value);
}

function delimiterRunV1(input: Readonly<{
  after: string | undefined;
  before: string | undefined;
  length: number;
  marker: "*" | "_";
}>): DelimiterRunV1 {
  const beforeWhitespace = isWhitespace(input.before);
  const afterWhitespace = isWhitespace(input.after);
  const beforePunctuation = isPunctuation(input.before);
  const afterPunctuation = isPunctuation(input.after);
  const leftFlanking = !afterWhitespace &&
    (!afterPunctuation || beforeWhitespace || beforePunctuation);
  const rightFlanking = !beforeWhitespace &&
    (!beforePunctuation || afterWhitespace || afterPunctuation);
  return Object.freeze({
    canClose: input.marker === "*"
      ? rightFlanking
      : rightFlanking && (!leftFlanking || afterPunctuation),
    canOpen: input.marker === "*"
      ? leftFlanking
      : leftFlanking && (!rightFlanking || beforePunctuation),
    length: input.length
  });
}

function violatesMultipleOfThreeRule(
  opener: DelimiterRunV1,
  closer: DelimiterRunV1
): boolean {
  return (opener.canClose || closer.canOpen) &&
    (opener.length + closer.length) % 3 === 0 &&
    (opener.length % 3 !== 0 || closer.length % 3 !== 0);
}

function containsDelimiterPair(value: string, marker: "*" | "_"): boolean {
  const characters = Array.from(value);
  const openers: DelimiterRunV1[] = [];
  for (let index = 0; index < characters.length;) {
    if (characters[index] !== marker) {
      index += 1;
      continue;
    }
    const start = index;
    while (characters[index] === marker) index += 1;
    const run = delimiterRunV1({
      after: characters[index],
      before: characters[start - 1],
      length: index - start,
      marker
    });
    if (run.canClose && openers.some((opener) =>
      !violatesMultipleOfThreeRule(opener, run))) return true;
    if (run.canOpen) openers.push(run);
  }
  return false;
}

/** Detects actual CommonMark emphasis delimiter pairs rather than treating any
 * two underscores as markup. In particular, repeated mathematical subscripts
 * and identifier underscores remain literal because their runs cannot close.
 * Links, code, HTML, block markers, and GFM strike remain owned by the existing
 * strict claim validator. */
export function containsKnowledgeClaimMarkdownEmphasisV1(value: string): boolean {
  return containsDelimiterPair(value, "*") || containsDelimiterPair(value, "_");
}
