/** MemoryAgentBench's MIT-licensed normalized substring metric, pinned in upstream.json.
 * It intentionally allows negated and contradictory answers; use the separate semantic
 * diagnostic to expose those false positives without changing the upstream score.
 */
export function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu, "")
    .replace(/(?<![\p{L}\p{N}_])(a|an|the)(?![\p{L}\p{N}_])/gu, " ")
    .replace(/[\t\n\v\f\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, " ")
    .replace(/^ | $/gu, "");
}

export function substringExactMatch(prediction: string, answers: readonly string[]): boolean {
  if (!answers.length || answers.some((answer) => !normalizeAnswer(answer))) {
    throw new Error("factconsolidation_answers_invalid");
  }
  const normalized = normalizeAnswer(prediction);
  return answers.some((answer) => normalized.includes(normalizeAnswer(answer)));
}

export function selectQuestionIndices(ids: readonly string[], count: number,
  seed: string, digest: (text: string) => string): number[] {
  if (new Set(ids).size !== ids.length || !Number.isInteger(count) || count < 1 || count > ids.length) {
    throw new Error("factconsolidation_selection_invalid");
  }
  return ids.map((id, index) => ({ index, hash: digest(`${seed}\0${id}`) }))
    .sort((a, b) => a.hash.localeCompare(b.hash) || a.index - b.index)
    .slice(0, count).map(({ index }) => index).sort((a, b) => a - b);
}
