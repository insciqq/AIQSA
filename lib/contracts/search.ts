export const MAX_SEARCH_PLAN_OPTIONS = 3;
export const SEARCH_DISABLED_STRATEGY_ID = "search-disabled";

export type SearchPlanMode = "all_selected" | "model_choice";
export type SearchAdapterKind = "answer_provider_hosted" | "provider_model_client";
export type SearchCredentialMode = "answer_provider" | "provider_model";
export type SearchProtocol =
  | "anthropic_web_search"
  | "gemini_google_search"
  | "openai_responses_web_search"
  | "openrouter_perplexity_chat";

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
