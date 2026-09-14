/** The server merges configured defaults. UI-synthesized transport and
 * reasoning-mode values are not part of the benchmark's reader profile.
 */
export function longMemEvalAnswerParams(defaults: Readonly<Record<string, unknown>>,
  maxOutputTokens: number, reasoningEffort: string): Record<string, unknown> {
  const params = { ...defaults };
  for (const key of ["maxOutputTokens", "maxTokens", "max_output_tokens", "max_tokens",
    "max_completion_tokens", "background", "stream", "reasoning"]) delete params[key];
  return { ...params, maxOutputTokens, reasoning: { effort: reasoningEffort } };
}
