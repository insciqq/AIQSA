import { safeExternalHref } from "./links";

export const MAX_SEARCH_PLAN_OPTIONS = 3;
export const SEARCH_DISABLED_STRATEGY_ID = "search-disabled";
export const ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID = "system-anthropic-web-search-client";
export const ANTHROPIC_PROVIDER_SEARCH_STRATEGY_ID = "anthropic-web-search-client";
export const OPENAI_PROVIDER_SEARCH_INTEGRATION_ID = "system-openai-provider-web-search";
export const OPENAI_PROVIDER_SEARCH_STRATEGY_ID = "openai-provider-web-search";
export const GEMINI_PROVIDER_SEARCH_INTEGRATION_ID = "system-gemini-google-search-client";
export const GEMINI_PROVIDER_SEARCH_STRATEGY_ID = "gemini-google-search-client";

export const searchPlanModes = ["all_selected", "model_choice"] as const;
export type SearchPlanMode = (typeof searchPlanModes)[number];

export const searchAdapterKinds = [
  "answer_provider_hosted",
  "provider_model_client"
] as const;
export type SearchAdapterKind = (typeof searchAdapterKinds)[number];

export const searchCredentialModes = ["answer_provider", "provider_model"] as const;
export type SearchCredentialMode = (typeof searchCredentialModes)[number];

export const searchProtocols = [
  "anthropic_web_search",
  "gemini_google_search",
  "openai_responses_web_search",
  "openrouter_perplexity_chat"
] as const;
export type SearchProtocol = (typeof searchProtocols)[number];

export type SearchPlan = Readonly<{
  mode: SearchPlanMode;
  optionIds: readonly string[];
}>;

declare const validatedSearchQueryBrand: unique symbol;
export type ValidatedSearchQuery = string & {
  readonly [validatedSearchQueryBrand]: true;
};

export type SearchPlanDecodeResult =
  | Readonly<{ ok: true; plan: SearchPlan }>
  | Readonly<{
      code:
        | "search_plan_duplicate_option"
        | "search_plan_invalid"
        | "search_plan_too_many_options";
      ok: false;
    }>;

export type NormalizedSearchSource = Readonly<{
  date?: string;
  engines: readonly Readonly<{ optionId: string; rank: number }>[];
  snippet?: string;
  title: string;
  url: string;
}>;

export type SearchEngineEvidence = Readonly<{
  invocationId: string;
  optionId: string;
  sources: readonly Readonly<{
    date?: string;
    rank: number;
    snippet?: string;
    title: string;
    url: string;
  }>[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSearchPlanMode(value: unknown): value is SearchPlanMode {
  return value === "all_selected" || value === "model_choice";
}

export function decodeSearchPlan(value: unknown): SearchPlanDecodeResult {
  if (!isRecord(value) || !Array.isArray(value.optionIds) || !isSearchPlanMode(value.mode)) {
    return { code: "search_plan_invalid", ok: false };
  }
  if (value.optionIds.length > MAX_SEARCH_PLAN_OPTIONS) {
    return { code: "search_plan_too_many_options", ok: false };
  }

  const optionIds: string[] = [];
  for (const optionId of value.optionIds) {
    if (
      typeof optionId !== "string" ||
      !optionId.trim() ||
      optionId.length > 160 ||
      optionId === SEARCH_DISABLED_STRATEGY_ID ||
      /[\u0000-\u001f\u007f]/u.test(optionId)
    ) {
      return { code: "search_plan_invalid", ok: false };
    }
    optionIds.push(optionId.trim());
  }
  if (new Set(optionIds).size !== optionIds.length) {
    return { code: "search_plan_duplicate_option", ok: false };
  }

  return {
    ok: true,
    plan: {
      mode: value.mode,
      optionIds
    }
  };
}

function normalizedUrl(value: string): string | null {
  const safe = safeExternalHref(value);
  if (!safe) return null;
  try {
    const url = new URL(safe);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

/**
 * Merge fan-out evidence without inventing a global relevance score. Plan
 * order is authoritative; each engine's local rank is the secondary order.
 */
export function mergeSearchEvidence(
  planOptionIds: readonly string[],
  evidence: readonly SearchEngineEvidence[],
  maxSources = 24
): NormalizedSearchSource[] {
  const planOrder = new Map(planOptionIds.map((optionId, index) => [optionId, index]));
  const rows = evidence.flatMap((engine) =>
    engine.sources.flatMap((source) => {
      const url = normalizedUrl(source.url);
      if (!url || !planOrder.has(engine.optionId) || !Number.isSafeInteger(source.rank) || source.rank < 1) {
        return [];
      }
      return [{
        date: boundedText(source.date, 80),
        optionId: engine.optionId,
        planRank: planOrder.get(engine.optionId)!,
        rank: source.rank,
        snippet: boundedText(source.snippet, 2_000),
        title: boundedText(source.title, 500) ?? url,
        url
      }];
    })
  ).sort((left, right) => left.planRank - right.planRank || left.rank - right.rank);

  const merged = new Map<string, NormalizedSearchSource>();
  for (const row of rows) {
    const existing = merged.get(row.url);
    if (existing) {
      if (!existing.engines.some((engine) => engine.optionId === row.optionId)) {
        merged.set(row.url, {
          ...existing,
          engines: [...existing.engines, { optionId: row.optionId, rank: row.rank }]
        });
      }
      continue;
    }
    if (merged.size >= maxSources) break;
    merged.set(row.url, {
      ...(row.date ? { date: row.date } : {}),
      engines: [{ optionId: row.optionId, rank: row.rank }],
      ...(row.snippet ? { snippet: row.snippet } : {}),
      title: row.title,
      url: row.url
    });
  }
  return [...merged.values()];
}
