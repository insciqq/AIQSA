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

/**
 * How an admitted run's Search option is used (operator decisions 2026-11-26): `in_answer` is OpenAI's hosted
 * search inside the answer model's own request, `engine` the installation's client engine behind `web_search`, and
 * `backup` the administrator's backup, called only when the engine's call failed.
 */
export type SearchOptionUse = "backup" | "engine" | "in_answer";

export const searchAdapterKinds = [
  "answer_provider_hosted",
  "provider_model_client"
] as const;
export type SearchAdapterKind = (typeof searchAdapterKinds)[number];

export const searchCredentialModes = ["answer_provider", "provider_model"] as const;
export type SearchCredentialMode = (typeof searchCredentialModes)[number];

export const searchProtocols = [
  "anthropic_web_search",
  "deepseek_search_api",
  "gemini_google_search",
  "openai_responses_web_search",
  "openrouter_perplexity_chat",
  "openrouter_web_search"
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

export {
  isSearchUnavailableReason,
  SEARCH_OFF_PLAN,
  SEARCH_ON_PLAN,
  SEARCH_UNAVAILABLE_REASONS,
  searchPlanEnabled,
  searchSettingPlan,
  WEB_SEARCH_OPTION_ID,
  type ModelWebSearch,
  type SearchUnavailableReason
} from "../contracts/search";

/** What an engine is, for the default order: its client route's protocol and, for OpenRouter's web search, the
 * engine behind it. */
export type SearchEngineIdentity = Readonly<{ openRouterEngine?: string | null; protocol: string }>;

/**
 * The default engine order when the administrator chose none (operator decision 2026-11-26, after the eval's run 2):
 * OpenAI web search as a client engine (a technical model on an OpenAI-protocol connection, free on Codex LB), then
 * OpenRouter's web search with Perplexity, the DeepSeek Search API, Gemini Google Search and Anthropic web search.
 * OpenRouter's Parallel and Exa and Perplexity Sonar may be chosen but are never defaults.
 */
export const SEARCH_ENGINE_DEFAULT_ORDER: readonly Readonly<{ openRouterEngine?: string; protocol: SearchProtocol }>[] =
  Object.freeze([
    { protocol: "openai_responses_web_search" },
    { openRouterEngine: "perplexity", protocol: "openrouter_web_search" },
    { protocol: "deepseek_search_api" },
    { protocol: "gemini_google_search" },
    { protocol: "anthropic_web_search" }
  ]);

/** An engine's place in the default order, or null for one that is never a default. */
export function searchEngineDefaultRank(engine: SearchEngineIdentity): number | null {
  const rank = SEARCH_ENGINE_DEFAULT_ORDER.findIndex((entry) => entry.protocol === engine.protocol &&
    (entry.openRouterEngine === undefined || entry.openRouterEngine === engine.openRouterEngine));
  return rank >= 0 ? rank : null;
}

/** One installation source as engine resolution sees it: whether its client route can search now. */
export type SearchEngineCandidate = SearchEngineIdentity & Readonly<{ optionId: string; ready: boolean }>;

export type SearchEngineResolution<Candidate extends SearchEngineCandidate = SearchEngineCandidate> = Readonly<{
  /** No engine was chosen, so the default order picked it. */
  automatic: boolean;
  /** The administrator's backup, used only when a call to the engine failed. */
  backup: Candidate | null;
  engine: Candidate | null;
  reason: "search_engine_not_configured" | "search_engine_unavailable" | null;
}>;

/**
 * The installation's engine: the administrator's choice while it can search, else the first ready source in the
 * default order, ties broken by the candidates' stable order. A chosen engine that cannot search is never replaced:
 * the reason says so. The backup counts only beside a resolved engine and is never the engine itself.
 */
export function resolveSearchEngine<Candidate extends SearchEngineCandidate>(input: Readonly<{
  backupOptionId: string | null;
  candidates: readonly Candidate[];
  engineOptionId: string | null;
}>): SearchEngineResolution<Candidate> {
  let engine: Candidate | null;
  let reason: SearchEngineResolution["reason"] = null;
  if (input.engineOptionId !== null) {
    engine = input.candidates.find((candidate) => candidate.optionId === input.engineOptionId && candidate.ready) ?? null;
    if (!engine) reason = "search_engine_unavailable";
  } else {
    engine = input.candidates
      .map((candidate, index) => ({ candidate, index, rank: candidate.ready ? searchEngineDefaultRank(candidate) : null }))
      .filter((entry): entry is { candidate: Candidate; index: number; rank: number } => entry.rank !== null)
      .sort((left, right) => left.rank - right.rank || left.index - right.index)[0]?.candidate ?? null;
    if (!engine) reason = "search_engine_not_configured";
  }
  const backup = engine && input.backupOptionId !== null && input.backupOptionId !== engine.optionId
    ? input.candidates.find((candidate) => candidate.optionId === input.backupOptionId && candidate.ready) ?? null
    : null;
  return { automatic: input.engineOptionId === null, backup, engine, reason };
}

/**
 * The source the default order picks among sources described by their protocols, for administrator views that
 * predate the engine policy. A source qualifies by the protocol of one of its routes; an OpenRouter web search source
 * whose engine is not named counts as Perplexity, the template's default.
 */
export function automaticSearchOptionId(
  sources: readonly Readonly<{ openRouterEngine?: string | null; protocols: readonly string[]; strategyId: string }>[]
): string | null {
  const ranked = sources.flatMap((source, index) => {
    const ranks = source.protocols.flatMap((protocol) => {
      const rank = searchEngineDefaultRank({
        openRouterEngine: protocol === "openrouter_web_search" ? source.openRouterEngine ?? "perplexity" : null,
        protocol
      });
      return rank === null ? [] : [rank];
    });
    return ranks.length ? [{ index, rank: Math.min(...ranks), strategyId: source.strategyId }] : [];
  }).sort((left, right) => left.rank - right.rank || left.index - right.index);
  return ranked[0]?.strategyId ?? null;
}

/** Results-only engines, whose empty search is an ordinary answer carrying
 * only the server's own words: the DeepSeek Search API and OpenRouter's web
 * search. */
export function searchProtocolReportsNoResults(protocol: unknown, provider: unknown): boolean {
  return protocol === "deepseek_search_api" && provider === "deepseek" ||
    protocol === "openrouter_web_search" && provider === "openrouter";
}

/** Only OpenAI-protocol hosted Search runs inside a tool-calling answer
 * request; every other source searches through its client route. */
export function hostedSearchProtocolUsable(protocol: string): boolean {
  return protocol === "openai_responses_web_search";
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
  evidence: readonly SearchEngineEvidence[]
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
