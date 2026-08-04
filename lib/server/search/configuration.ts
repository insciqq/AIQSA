import { createHash } from "node:crypto";
import {
  adminSearchExecutionDefaults,
  adminSearchExecutionLimits,
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

export function normalizeSearchDraft(value: unknown): AdminSearchDraft {
  if (!isRecord(value)) throw new SearchConfigurationError("search_configuration_invalid");
  const adapterKind = enumValue(value.adapterKind, searchAdapterKinds);
  const credentialMode = enumValue(value.credentialMode, searchCredentialModes);
  const protocol = enumValue(value.protocol, searchProtocols);
  const normalized: AdminSearchDraft = {
    adapterKind,
    credentialMode,
    maxOutputTokens: boundedInteger(
      value.maxOutputTokens ?? adminSearchExecutionDefaults.maxOutputTokens,
      adminSearchExecutionLimits.maxOutputTokens.minimum,
      adminSearchExecutionLimits.maxOutputTokens.maximum
    ),
    maxResults: boundedInteger(value.maxResults ?? 8, 1, 20),
    maxSearchCallsPerAnswer: boundedInteger(
      value.maxSearchCallsPerAnswer ?? adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.minimum,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.maximum
    ),
    protocol,
    providerModelId: providerModelId(value.providerModelId ?? null),
    queryMaxCharacters: boundedInteger(value.queryMaxCharacters ?? 500, 32, 1_000),
    reasoningPolicy: enumValue<AdminSearchReasoningPolicy>(
      value.reasoningPolicy ?? adminSearchExecutionDefaults.reasoningPolicy,
      ["lowest_supported", "provider_default"]
    ),
    timeoutMs: boundedInteger(value.timeoutMs ?? 300_000, 5_000, 900_000)
  };

  const hosted = adapterKind === "answer_provider_hosted";
  if (
    (hosted && credentialMode !== "answer_provider") ||
    (!hosted && credentialMode !== "provider_model") ||
    (hosted && normalized.providerModelId !== null) ||
    (!hosted && normalized.providerModelId === null) ||
    (protocol === "openrouter_perplexity_chat" && hosted)
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

export function searchDraftHash(value: AdminSearchDraft): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function searchExecutionModes(adapterKind: SearchAdapterKind): SearchPlanMode[] {
  return adapterKind === "provider_model_client"
    ? ["all_selected", "model_choice"]
    : ["model_choice"];
}

export function legacySearchKind(
  protocol: SearchProtocol,
  adapterKind: SearchAdapterKind
): string {
  if (protocol === "anthropic_web_search") {
    return adapterKind === "answer_provider_hosted"
      ? "anthropic_native_web_search"
      : "provider_model_web_search";
  }
  if (protocol === "gemini_google_search") return "gemini_google_search";
  if (protocol === "openrouter_perplexity_chat") return "perplexity_tool_search";
  return adapterKind === "answer_provider_hosted"
    ? "openai_native_web_search"
    : "provider_model_web_search";
}

export function legacyProvider(protocol: SearchProtocol): string {
  if (protocol === "anthropic_web_search") return "anthropic";
  if (protocol === "gemini_google_search") return "gemini";
  if (protocol === "openrouter_perplexity_chat") return "openrouter";
  return "openai_compatible";
}

export function compatibleTechnicalAdapter(protocol: SearchProtocol, adapterKind: string): boolean {
  if (protocol === "anthropic_web_search") {
    return adapterKind === "anthropic_messages";
  }
  if (protocol === "openrouter_perplexity_chat") {
    return adapterKind === "openrouter_chat_completions";
  }
  if (protocol === "openai_responses_web_search") {
    return adapterKind === "openai_responses_native" || adapterKind === "openai_responses_compatible";
  }
  return adapterKind === "gemini_interactions_native";
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
    adapterKind: input.kind === "perplexity_tool_search"
      ? "provider_model_client"
      : "answer_provider_hosted",
    credentialMode: input.kind === "perplexity_tool_search"
      ? "provider_model"
      : "answer_provider",
    maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
    maxResults: 8,
    maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
    protocol: input.kind === "anthropic_native_web_search"
      ? "anthropic_web_search"
      : input.kind === "gemini_google_search"
        ? "gemini_google_search"
      : input.kind === "perplexity_tool_search"
        ? "openrouter_perplexity_chat"
        : "openai_responses_web_search",
    providerModelId: input.providerModelId ?? null,
    queryMaxCharacters: 500,
    reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
    timeoutMs: 300_000
  };
}
