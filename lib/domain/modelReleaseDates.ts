// Release dates of code-owned model templates: OpenRouter's `created` date of the
// same model, checked 2026-10-15 (https://openrouter.ai/api/v1/models). They only
// order the administrator's model list; nothing else reads them. Templates without
// a published date (embeddings, rerankers, Jev, image-only OpenAI models, fake)
// stay absent and sort by when the row was added.
const openai: Record<string, string> = {
  "gpt-6.1-sol": "2026-09-29",
  "gpt-6-sol": "2026-09-22",
  "gpt-6-luna": "2026-09-22",
  "gpt-6-astra": "2026-09-04",
  "gpt-5.6-sol": "2026-07-09",
  "gpt-5.6-terra": "2026-07-09",
  "gpt-5.6-luna": "2026-07-09",
  "gpt-5.5": "2026-04-24"
};
const anthropic: Record<string, string> = {
  "claude-haiku-5-5": "2026-10-07",
  "claude-sonnet-5-5": "2026-09-28",
  "claude-opus-5-5": "2026-09-22",
  "claude-fable-5-1": "2026-09-01",
  "claude-opus-5": "2026-07-24",
  "claude-sonnet-5": "2026-06-30",
  "claude-opus-4-8": "2026-05-27"
};
const gemini: Record<string, string> = {
  "gemini-4-argon": "2026-10-13",
  "gemini-3.8-flash": "2026-09-02",
  "gemini-3.6-flash": "2026-07-21",
  "gemini-3.5-flash-lite": "2026-07-21",
  "gemini-3.5-flash": "2026-05-19",
  "gemini-3.1-pro-preview": "2026-02-19",
  "gemini-3.1-flash-image": "2026-06-18",
  "gemini-3.1-flash-lite-image": "2026-06-30",
  "gemini-3-pro-image": "2026-06-18",
  "gemini-2.5-flash-image": "2025-10-07"
};
const deepseek: Record<string, string> = {
  // DeepSeek's API serves V4.1 Flash 1017 under this name since 2026-10-17.
  "deepseek-flash": "2026-10-17",
  "deepseek-v4-flash": "2026-04-24",
  "deepseek-v4-pro": "2026-04-24",
  "deepseek-v4-flash-vision-exp": "2026-08-21"
};
const openrouter: Record<string, string> = {
  "google/gemini-4-argon": "2026-10-13",
  "anthropic/claude-haiku-5.5": "2026-10-07",
  "openai/gpt-6.1-sol": "2026-09-29",
  "openai/gpt-6.1-sol-pro": "2026-09-29",
  "anthropic/claude-sonnet-5.5": "2026-09-28",
  "openai/gpt-6-sol": "2026-09-22",
  "openai/gpt-6-luna": "2026-09-22",
  "openai/gpt-6-sol-pro": "2026-09-22",
  "openai/gpt-6-luna-pro": "2026-09-22",
  "anthropic/claude-opus-5.5": "2026-09-22",
  "openai/gpt-6-astra": "2026-09-04",
  "anthropic/claude-fable-5.1": "2026-09-01",
  "anthropic/claude-opus-5": "2026-07-24",
  "anthropic/claude-opus-4.8": "2026-05-27",
  "google/gemini-3.8-flash": "2026-09-02",
  "google/gemini-3.5-flash": "2026-05-19",
  "~google/gemini-pro-latest": "2026-04-27",
  "deepseek/deepseek-v4.1-flash-1017": "2026-10-17",
  "deepseek/deepseek-v4.1-flash": "2026-09-10",
  "deepseek/deepseek-v4-pro-0813": "2026-08-12",
  "perplexity/sonar-pro-search": "2025-10-30",
  "google/gemini-3.1-flash-image": "2026-06-18",
  "google/gemini-3.1-flash-lite-image": "2026-06-30",
  "google/gemini-3-pro-image": "2026-06-18",
  "google/gemini-2.5-flash-image": "2025-10-07"
};

const releaseDates: ReadonlyMap<string, string> = new Map(
  Object.entries({ openai, anthropic, gemini, deepseek, openrouter }).flatMap(([provider, models]) =>
    Object.entries(models).map(([modelId, date]) => [`${provider}:${modelId}`, date] as const))
);

/** Every dated template key, `<family>:<upstream model>` like the template ids. */
export const modelReleaseDateKeys: readonly string[] = Object.freeze([...releaseDates.keys()]);

/** `YYYY-MM-DD` of a template; a codex-lb row resolves through the same OpenAI model. */
export function modelReleaseDate(templateKey: string | null): string | null {
  if (!templateKey) return null;
  const key = templateKey.startsWith("codex-lb:") ? `openai:${templateKey.slice("codex-lb:".length)}` : templateKey;
  return releaseDates.get(key) ?? null;
}
