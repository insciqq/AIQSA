import type { AdminProviderModelClass } from "../contracts/adminProviders";
import type { ModelTokenPricing } from "./usage";

// Base token tariffs checked 2026-09-30. Runtime never refreshes saved prices.
// https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
// https://ai.google.dev/gemini-api/docs/pricing
// https://api-docs.deepseek.com/quick_start/pricing/
// https://openrouter.ai/api/v1/models
type Tariff = readonly [input: number, read: number | null, write: number | null, output: number | null];
const openai: Record<string, Tariff> = {
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-6-sol": [2, 0.2, 2.5, 10],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2],
  "gpt-5.5": [5, 0.5, null, 30]
};
const anthropic: Record<string, Tariff> = {
  // The adapter never requests a one-hour lifetime; ephemeral defaults to five minutes.
  "claude-fable-5-1": [10, 0.25, 12.5, 50],
  "claude-opus-5-5": [4, 0.2, 5, 20],
  "claude-opus-5": [5, 0.5, 6.25, 25],
  "claude-opus-4-8": [5, 0.5, 6.25, 25],
  "claude-sonnet-5": [2, 0.2, 2.5, 10]
};
const gemini: Record<string, Tariff> = {
  // Current introductory prices expire 2026-12-31; update via a forward migration.
  "gemini-3.8-flash": [0.75, 0.075, null, 3.75],
  "gemini-3.6-flash": [0.75, 0.075, null, 3.75],
  "gemini-3.5-flash": [1.5, 0.15, null, 9],
  "gemini-3.5-flash-lite": [0.3, 0.03, null, 2.5],
  "gemini-3.1-pro-preview": [2, 0.2, null, 12]
};
const deepseek: Record<string, Tariff> = {
  "deepseek-flash": [0.3, 0.006, null, 1.2],
  "deepseek-v4-flash": [0.3, 0.006, null, 1.2],
  "deepseek-v4-flash-vision-exp": [0.3, 0.006, null, 1.2],
  "deepseek-v4-pro": [1.32, 0.044, null, 3.96]
};
const openrouter: Record<string, Tariff> = {
  "openai/gpt-6-astra": openai["gpt-6-astra"],
  "openai/gpt-6-sol": openai["gpt-6-sol"],
  "openai/gpt-6-sol-pro": openai["gpt-6-sol"],
  "openai/gpt-6-luna": openai["gpt-6-luna"],
  "openai/gpt-6-luna-pro": openai["gpt-6-luna"],
  "anthropic/claude-fable-5.1": anthropic["claude-fable-5-1"],
  "anthropic/claude-opus-5.5": anthropic["claude-opus-5-5"],
  "anthropic/claude-opus-5": anthropic["claude-opus-5"],
  "anthropic/claude-opus-4.8": anthropic["claude-opus-4-8"],
  "google/gemini-3.8-flash": gemini["gemini-3.8-flash"],
  "google/gemini-3.5-flash": gemini["gemini-3.5-flash"],
  "~google/gemini-pro-latest": gemini["gemini-3.1-pro-preview"],
  // OpenRouter's top-level default pricing; weekday UTC peak overrides are out of scope.
  "deepseek/deepseek-v4.1-flash": [0.0198, 0.00291, null, 0.396],
  "deepseek/deepseek-v4-pro-0813": [0.66, 0.022, null, 1.98],
  "perplexity/sonar-pro-search": [3, null, null, 15]
};

// Embedding tariffs price input tokens only. The OpenRouter presets report each
// call's cost, so only deployments that report none need a tariff.
// https://developers.openai.com/api/docs/pricing ("Specialized models", checked 2026-10-07)
const openaiEmbeddings: Record<string, Tariff> = {
  "text-embedding-3-large": [0.13, null, null, null]
};

const tariffs: ReadonlyArray<readonly [AdminProviderModelClass, Readonly<Record<string, Record<string, Tariff>>>]> = [
  ["answer", { openai, anthropic, gemini, deepseek, openrouter }],
  ["embedding", { openai: openaiEmbeddings }]
];
const catalog = new Map<string, Readonly<{ modelClass: AdminProviderModelClass; tariff: Tariff }>>(tariffs.flatMap(([modelClass, providers]) =>
  Object.entries(providers).flatMap(([provider, models]) =>
    Object.entries(models).map(([modelId, tariff]) => [`${provider}:${modelId}`, { modelClass, tariff }] as const))));

/** Keyed by `<family>:<upstream model>`; codex-lb rows resolve to the `openai:` tariff. */
export const catalogModelPrices: Readonly<Record<string, ModelTokenPricing>> = Object.fromEntries(
  [...catalog].map(([key, { tariff: [input, read, write, output] }]) => [key, {
    inputTokenPriceUsdPerMillion: input,
    cachedInputTokenPriceUsdPerMillion: read,
    cacheWriteInputTokenPriceUsdPerMillion: write,
    outputTokenPriceUsdPerMillion: output
  }])
);

/** The one model class a catalog tariff prices; rows of any other class never take it. */
export function catalogModelPriceClass(key: string): AdminProviderModelClass | null {
  return catalog.get(key)?.modelClass ?? null;
}

export function catalogModelTokenPricing(templateKey: string): ModelTokenPricing {
  return catalogModelPrices[templateKey] ?? {
    inputTokenPriceUsdPerMillion: null, cachedInputTokenPriceUsdPerMillion: null,
    cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null
  };
}
