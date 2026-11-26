export const MAX_SEARCH_PLAN_OPTIONS = 3;
export const SEARCH_DISABLED_STRATEGY_ID = "search-disabled";

export type SearchPlanMode = "all_selected" | "model_choice";
export type SearchAdapterKind = "answer_provider_hosted" | "provider_model_client";
export type SearchCredentialMode = "answer_provider" | "provider_model";
export type SearchProtocol =
  | "anthropic_web_search"
  | "deepseek_search_api"
  | "gemini_google_search"
  | "openai_responses_web_search"
  | "openrouter_perplexity_chat"
  | "openrouter_web_search";

export type SearchPlan = Readonly<{
  mode: SearchPlanMode;
  optionIds: readonly string[];
}>;

export type SearchPlanDecodeResult =
  | Readonly<{ ok: true; plan: SearchPlan }>
  | Readonly<{
      code: "search_plan_duplicate_option" | "search_plan_invalid" | "search_plan_too_many_options";
      ok: false;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeSearchPlan(value: unknown): SearchPlanDecodeResult {
  if (!isRecord(value) || !Array.isArray(value.optionIds) ||
    (value.mode !== "all_selected" && value.mode !== "model_choice")) {
    return { code: "search_plan_invalid", ok: false };
  }
  if (value.optionIds.length > MAX_SEARCH_PLAN_OPTIONS) {
    return { code: "search_plan_too_many_options", ok: false };
  }
  const optionIds: string[] = [];
  for (const optionId of value.optionIds) {
    if (typeof optionId !== "string" || !optionId.trim() || optionId.length > 160 ||
      optionId === SEARCH_DISABLED_STRATEGY_ID || /[\u0000-\u001f\u007f]/u.test(optionId)) {
      return { code: "search_plan_invalid", ok: false };
    }
    optionIds.push(optionId.trim());
  }
  if (new Set(optionIds).size !== optionIds.length) {
    return { code: "search_plan_duplicate_option", ok: false };
  }
  return { ok: true, plan: { mode: value.mode, optionIds } };
}

/**
 * Users switch Search on or off; which engine runs is the installation's
 * (operator decisions 2026-11-26). Plans the browser, Assistants and chats
 * still carry say only that: one virtual source, this id, means on, and no
 * source means off. A stored plan that names real sources, written before
 * the single engine, reads as on.
 */
export const WEB_SEARCH_OPTION_ID = "web-search";

export const SEARCH_ON_PLAN: SearchPlan = Object.freeze({
  mode: "all_selected",
  optionIds: Object.freeze([WEB_SEARCH_OPTION_ID])
}) as SearchPlan;

export const SEARCH_OFF_PLAN: SearchPlan = Object.freeze({
  mode: "all_selected",
  optionIds: Object.freeze([] as string[])
}) as SearchPlan;

/** Whether a plan turns Search on: it names any source. */
export function searchPlanEnabled(plan: Readonly<{ optionIds: readonly string[] }>): boolean {
  return plan.optionIds.length > 0;
}

/** The plan that says on or off, the only two plans a writer stores from now on. */
export function searchSettingPlan(enabled: boolean): SearchPlan {
  return enabled
    ? { mode: SEARCH_ON_PLAN.mode, optionIds: [...SEARCH_ON_PLAN.optionIds] }
    : { mode: SEARCH_OFF_PLAN.mode, optionIds: [] };
}

/**
 * Why a run with Search on cannot search with the installation's engine:
 * the user holds no Search grant, the installation has no usable engine, or
 * the engine the administrator chose (or the one resolved for the run) cannot
 * be used now. Never replaced by another engine; Admin and the answer say so.
 */
export const SEARCH_UNAVAILABLE_REASONS = [
  "search_engine_not_configured",
  "search_engine_unavailable",
  "search_not_granted"
] as const;
export type SearchUnavailableReason = (typeof SEARCH_UNAVAILABLE_REASONS)[number];

export function isSearchUnavailableReason(value: unknown): value is SearchUnavailableReason {
  return (SEARCH_UNAVAILABLE_REASONS as readonly unknown[]).includes(value);
}

/** How a model searches: inside its own answer (OpenAI hosted search), with the installation's engine, or not at all. */
export type ModelWebSearch = "engine" | "in_answer" | null;
