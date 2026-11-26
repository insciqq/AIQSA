import { createHash } from "node:crypto";
import {
  adminSearchExecutionDefaults,
  adminSearchExecutionLimits,
  DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS,
  decodeOpenRouterWebSearchSettings,
  type AdminSearchDraft,
  type AdminSearchReasoningPolicy
} from "../../contracts/adminSearch";
import {
  searchAdapterKinds,
  searchCredentialModes,
  searchProtocols,
  type SearchAdapterKind,
  type SearchPlanMode,
  type SearchProtocol
} from "../../domain/search";

export class SearchConfigurationError extends Error {
  constructor(readonly code: "search_configuration_invalid") {
    super(code);
    this.name = "SearchConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new SearchConfigurationError("search_configuration_invalid");
  }
  return Number(value);
}

function enumValue<Value extends string>(value: unknown, values: readonly Value[]): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) {
    throw new SearchConfigurationError("search_configuration_invalid");
  }
  return value as Value;
}

function providerModelId(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SearchConfigurationError("search_configuration_invalid");
  }
  return value.trim();
}

/** Old persisted drafts may carry retired call/result limits; the explicit
 * projection ignores them without requiring a data migration or a new probe. */
export function normalizeSearchDraft(value: unknown): AdminSearchDraft {
  if (!isRecord(value)) throw new SearchConfigurationError("search_configuration_invalid");
  const adapterKind = enumValue(value.adapterKind, searchAdapterKinds);
  const credentialMode = enumValue(value.credentialMode, searchCredentialModes);
  const protocol = enumValue(value.protocol, searchProtocols);
  // Only an OpenRouter web search source names an engine; every other draft
  // keeps its exact earlier shape and hash.
  const openRouterWebSearch = protocol === "openrouter_web_search"
    ? decodeOpenRouterWebSearchSettings(value.openRouterWebSearch)
    : null;
  if (protocol === "openrouter_web_search" ? !openRouterWebSearch : value.openRouterWebSearch !== undefined) {
    throw new SearchConfigurationError("search_configuration_invalid");
  }
  const normalized: AdminSearchDraft = {
    adapterKind,
    credentialMode,
    maxOutputTokens: value.maxOutputTokens === null ? null : boundedInteger(
      value.maxOutputTokens,
      adminSearchExecutionLimits.maxOutputTokens.minimum,
      adminSearchExecutionLimits.maxOutputTokens.maximum
    ),
    ...(openRouterWebSearch ? { openRouterWebSearch } : {}),
    protocol,
    providerModelId: providerModelId(value.providerModelId),
    queryMaxCharacters: boundedInteger(
      value.queryMaxCharacters,
      adminSearchExecutionLimits.queryMaxCharacters.minimum,
      adminSearchExecutionLimits.queryMaxCharacters.maximum
    ),
    reasoningPolicy: enumValue<AdminSearchReasoningPolicy>(
      value.reasoningPolicy,
      ["lowest_supported", "provider_default"]
    ),
    timeoutMs: boundedInteger(
      value.timeoutMs,
      adminSearchExecutionLimits.timeoutMs.minimum,
      adminSearchExecutionLimits.timeoutMs.maximum
    )
  };

  const hosted = adapterKind === "answer_provider_hosted";
  if (
    (hosted && credentialMode !== "answer_provider") ||
    (!hosted && credentialMode !== "provider_model") ||
    (hosted && normalized.providerModelId !== null) ||
    (!hosted && normalized.providerModelId === null) ||
    (protocol === "openrouter_web_search" && hosted) ||
    (protocol === "deepseek_search_api" &&
      (hosted || normalized.queryMaxCharacters > DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS))
  ) {
    throw new SearchConfigurationError("search_configuration_invalid");
  }

  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint effective settings even when the caller supplies a stored legacy draft. */
export function searchDraftHash(value: AdminSearchDraft): string {
  return createHash("sha256").update(canonicalJson(normalizeSearchDraft(value)), "utf8").digest("hex");
}

export function searchExecutionModes(adapterKind: SearchAdapterKind): SearchPlanMode[] {
  return adapterKind === "provider_model_client"
    ? ["all_selected", "model_choice"]
    : ["model_choice"];
}

export function searchStrategyKind(
  protocol: SearchProtocol,
  adapterKind: SearchAdapterKind
): string {
  if (protocol === "anthropic_web_search") {
    return adapterKind === "answer_provider_hosted"
      ? "anthropic_native_web_search"
      : "provider_model_web_search";
  }
  if (protocol === "gemini_google_search") return "gemini_google_search";
  if (protocol === "deepseek_search_api" || protocol === "openrouter_web_search") return "provider_model_web_search";
  return adapterKind === "answer_provider_hosted"
    ? "openai_native_web_search"
    : "provider_model_web_search";
}

export function compatibleTechnicalAdapter(protocol: SearchProtocol, adapterKind: string): boolean {
  if (protocol === "anthropic_web_search") {
    return adapterKind === "anthropic_messages";
  }
  if (protocol === "openrouter_web_search") {
    return adapterKind === "openrouter_chat_completions";
  }
  if (protocol === "openai_responses_web_search") {
    return adapterKind === "openai_responses_native" || adapterKind === "openai_responses_compatible";
  }
  if (protocol === "deepseek_search_api") {
    return adapterKind === "deepseek_responses_native";
  }
  return adapterKind === "gemini_interactions_native";
}

/**
 * Whether a client route's technical model can carry the protocol. A
 * model-backed protocol searches with that model, so the model's native Search
 * is required. The DeepSeek Search API only borrows the DeepSeek connection
 * and credential the model resolves; the model itself is never called.
 * OpenRouter's web search runs as OpenRouter's own server tool beside any
 * OpenRouter model: only the source's probe (one search with the verbatim
 * query and a result) qualifies the model.
 */
export function technicalSearchModelSupports(
  protocol: SearchProtocol,
  model: Readonly<{ adapterKind: string; nativeSearch?: boolean }>
): boolean {
  return compatibleTechnicalAdapter(protocol, model.adapterKind) &&
    (protocol === "deepseek_search_api" || protocol === "openrouter_web_search" || model.nativeSearch === true);
}

export function builtInSearchDraft(input: Readonly<{
  config: unknown;
  kind: string;
  providerModelId?: string | null;
}>): Record<string, unknown> {
  if (input.kind === "none") {
    return {
      adapterKind: "none",
      configuration: isRecord(input.config) ? input.config : {},
      credentialMode: "answer_provider",
      protocol: "none",
      providerModelId: null
    };
  }
  return {
    adapterKind: "answer_provider_hosted",
    credentialMode: "answer_provider",
    maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
    protocol: input.kind === "anthropic_native_web_search"
      ? "anthropic_web_search"
      : input.kind === "gemini_google_search"
        ? "gemini_google_search"
        : "openai_responses_web_search",
    providerModelId: input.providerModelId ?? null,
    queryMaxCharacters: adminSearchExecutionDefaults.queryMaxCharacters,
    reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
    timeoutMs: adminSearchExecutionDefaults.timeoutMs
  };
}
