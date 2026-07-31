import type { ProviderModelCapabilities } from "./types";

const MAX_API_ROOT_LENGTH = 2_048;
const MAX_DEFAULT_PARAMS_BYTES = 32 * 1_024;
const MAX_PROVIDER_ROUTE_COUNT = 16;
const MAX_REASONING_CONTROL_COUNT = 16;
const MAX_REASONING_CONTROL_LENGTH = 32;

export const providerAdapterKinds = [
  "anthropic_messages",
  "gemini_interactions_native",
  "openai_chat_completions_compatible",
  "openai_responses_compatible",
  "openai_responses_native",
  "openrouter_chat_completions"
] as const;

export type ProviderAdapterKind = (typeof providerAdapterKinds)[number];
export type ProviderFamily =
  | "anthropic"
  | "gemini"
  | "openai"
  | "openai_compatible"
  | "openrouter";

export type ProviderAuthenticationMode = "bearer" | "none";

export type ProviderConnectionConfiguration = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode?: ProviderAuthenticationMode;
};

export type OpenRouterRoutingConfiguration =
  | {
      mode: "automatic";
      providers: [];
    }
  | {
      mode: "only_selected";
      providers: string[];
    };

export type ProviderModelConfiguration = {
  adapterKind: ProviderAdapterKind;
  answerSelectable: boolean;
  capabilities: ProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  openRouterRouting?: OpenRouterRoutingConfiguration;
  upstreamModelId: string;
};

export type ProviderConfigurationErrorCode =
  | "provider_adapter_kind_invalid"
  | "provider_answer_selection_invalid"
  | "provider_api_root_invalid"
  | "provider_authentication_mode_invalid"
  | "provider_default_params_invalid"
  | "provider_model_capabilities_invalid"
  | "provider_routing_invalid"
  | "provider_upstream_model_invalid";

export class ProviderConfigurationError extends Error {
  readonly code: ProviderConfigurationErrorCode;

  constructor(code: ProviderConfigurationErrorCode) {
    super(code);
    this.code = code;
    this.name = "ProviderConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function optionalReasoningControls(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REASONING_CONTROL_COUNT) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }
  const normalized = value.map((entry) => boundedText(entry, MAX_REASONING_CONTROL_LENGTH)
    ? entry.trim()
    : null);
  if (normalized.some((entry) => entry === null) ||
    new Set(normalized).size !== normalized.length) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }
  return normalized as string[];
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : Infinity;
  } catch {
    return Infinity;
  }
}

export function normalizeProviderApiRoot(
  value: unknown,
  allowPrivateNetwork: boolean
): string {
  if (!boundedText(value, MAX_API_ROOT_LENGTH)) {
    throw new ProviderConfigurationError("provider_api_root_invalid");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderConfigurationError("provider_api_root_invalid");
  }

  if (
    (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderConfigurationError("provider_api_root_invalid");
  }

  return url.href.replace(/\/+$/u, "");
}

export function normalizeProviderConnectionConfiguration(
  value: unknown
): ProviderConnectionConfiguration {
  if (!isRecord(value) || typeof value.allowPrivateNetwork !== "boolean") {
    throw new ProviderConfigurationError("provider_api_root_invalid");
  }

  if (
    value.authenticationMode !== undefined &&
    value.authenticationMode !== "bearer" &&
    value.authenticationMode !== "none"
  ) {
    throw new ProviderConfigurationError("provider_authentication_mode_invalid");
  }
  const apiRoot = normalizeProviderApiRoot(value.apiRoot, value.allowPrivateNetwork);
  if (
    value.authenticationMode === "none" &&
    (!value.allowPrivateNetwork || new URL(apiRoot).protocol !== "http:")
  ) {
    throw new ProviderConfigurationError("provider_authentication_mode_invalid");
  }

  return {
    allowPrivateNetwork: value.allowPrivateNetwork,
    apiRoot,
    ...(value.authenticationMode === "bearer" || value.authenticationMode === "none"
      ? { authenticationMode: value.authenticationMode }
      : {})
  };
}

export function providerAuthenticationMode(
  configuration: ProviderConnectionConfiguration
): ProviderAuthenticationMode {
  return configuration.authenticationMode ?? "bearer";
}

export function providerRequestEndpoint(
  configuration: ProviderConnectionConfiguration,
  adapterKind: ProviderAdapterKind
): string {
  const terminalPath = adapterKind === "gemini_interactions_native" ? "interactions" :
    adapterKind.includes("responses") ? "responses" :
    adapterKind === "anthropic_messages" ? "messages" : "chat/completions";
  return `${configuration.apiRoot}/${terminalPath}`;
}

export function normalizeProviderModelCapabilities(value: unknown): ProviderModelCapabilities {
  if (!isRecord(value)) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }

  const required = ["nativePdfInput", "nativeSearch", "pdf", "reasoning", "vision"] as const;
  if (required.some((key) => typeof value[key] !== "boolean")) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }

  const optional = [
    "backgroundStreaming",
    "nativeBackground",
    "nativeImageGeneration",
    "parallelToolCalls",
    "streaming",
    "toolCalling"
  ] as const;
  if (optional.some((key) => value[key] !== undefined && typeof value[key] !== "boolean")) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }
  if (
    value.contextWindow !== undefined &&
    (!Number.isInteger(value.contextWindow) || Number(value.contextWindow) <= 0)
  ) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }
  if (
    value.defaultMaxOutputTokens !== undefined &&
    (!Number.isInteger(value.defaultMaxOutputTokens) || Number(value.defaultMaxOutputTokens) <= 0)
  ) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }
  const reasoningEfforts = optionalReasoningControls(value.reasoningEfforts);
  const reasoningModes = optionalReasoningControls(value.reasoningModes);
  const defaultReasoningEffort = value.defaultReasoningEffort === undefined
    ? undefined
    : boundedText(value.defaultReasoningEffort, MAX_REASONING_CONTROL_LENGTH)
      ? value.defaultReasoningEffort.trim()
      : null;
  const defaultReasoningMode = value.defaultReasoningMode === undefined
    ? undefined
    : boundedText(value.defaultReasoningMode, MAX_REASONING_CONTROL_LENGTH)
      ? value.defaultReasoningMode.trim()
      : null;
  if (
    defaultReasoningEffort === null ||
    defaultReasoningMode === null ||
    (!value.reasoning && (
      reasoningEfforts || reasoningModes || defaultReasoningEffort || defaultReasoningMode
    )) ||
    (reasoningEfforts && (!defaultReasoningEffort || !reasoningEfforts.includes(defaultReasoningEffort))) ||
    (!reasoningEfforts && defaultReasoningEffort) ||
    (reasoningModes && (!defaultReasoningMode || !reasoningModes.includes(defaultReasoningMode))) ||
    (!reasoningModes && defaultReasoningMode)
  ) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }

  return {
    ...(typeof value.backgroundStreaming === "boolean"
      ? { backgroundStreaming: value.backgroundStreaming }
      : {}),
    ...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
    ...(typeof value.defaultMaxOutputTokens === "number"
      ? { defaultMaxOutputTokens: value.defaultMaxOutputTokens }
      : {}),
    nativePdfInput: value.nativePdfInput as boolean,
    ...(typeof value.nativeBackground === "boolean" ? { nativeBackground: value.nativeBackground } : {}),
    ...(typeof value.nativeImageGeneration === "boolean"
      ? { nativeImageGeneration: value.nativeImageGeneration }
      : {}),
    nativeSearch: value.nativeSearch as boolean,
    ...(typeof value.parallelToolCalls === "boolean" ? { parallelToolCalls: value.parallelToolCalls } : {}),
    pdf: value.pdf as boolean,
    reasoning: value.reasoning as boolean,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(defaultReasoningMode ? { defaultReasoningMode } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(reasoningModes ? { reasoningModes } : {}),
    ...(typeof value.streaming === "boolean" ? { streaming: value.streaming } : {}),
    ...(typeof value.toolCalling === "boolean" ? { toolCalling: value.toolCalling } : {}),
    vision: value.vision as boolean
  };
}

export function normalizeProviderDefaultParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || jsonByteLength(value) > MAX_DEFAULT_PARAMS_BYTES) {
    throw new ProviderConfigurationError("provider_default_params_invalid");
  }
  return { ...value };
}

function normalizeOpenRouterRouting(value: unknown): OpenRouterRoutingConfiguration {
  if (!isRecord(value) || (value.mode !== "automatic" && value.mode !== "only_selected")) {
    throw new ProviderConfigurationError("provider_routing_invalid");
  }
  const providers = Array.isArray(value.providers) ? value.providers : [];
  if (
    providers.length > MAX_PROVIDER_ROUTE_COUNT ||
    providers.some((provider) => !boundedText(provider, 80))
  ) {
    throw new ProviderConfigurationError("provider_routing_invalid");
  }
  const unique = [...new Set(providers.map((provider) => (provider as string).trim()))];
  if (unique.length !== providers.length) {
    throw new ProviderConfigurationError("provider_routing_invalid");
  }

  if (value.mode === "automatic") {
    if (unique.length > 0) {
      throw new ProviderConfigurationError("provider_routing_invalid");
    }
    return { mode: "automatic", providers: [] };
  }
  if (unique.length === 0) {
    throw new ProviderConfigurationError("provider_routing_invalid");
  }
  return { mode: "only_selected", providers: unique };
}

function openRouterDefaultParams(
  defaultParams: Record<string, unknown>,
  routing: OpenRouterRoutingConfiguration
): Record<string, unknown> {
  const selected = routing.mode === "only_selected" ? [...routing.providers] : [];
  return {
    ...defaultParams,
    provider: {
      allowFallbacks: routing.mode === "automatic",
      dataCollection: "deny",
      only: selected,
      order: selected,
      requireParameters: false,
      sort: "throughput",
      zdr: false
    }
  };
}

export function normalizeProviderModelConfiguration(value: unknown): ProviderModelConfiguration {
  if (!isRecord(value) || !providerAdapterKinds.includes(value.adapterKind as ProviderAdapterKind)) {
    throw new ProviderConfigurationError("provider_adapter_kind_invalid");
  }
  if (value.answerSelectable !== undefined && typeof value.answerSelectable !== "boolean") {
    throw new ProviderConfigurationError("provider_answer_selection_invalid");
  }
  if (!boundedText(value.upstreamModelId, 256)) {
    throw new ProviderConfigurationError("provider_upstream_model_invalid");
  }
  const rawDefaultParams = normalizeProviderDefaultParams(value.defaultParams);

  const adapterKind = value.adapterKind as ProviderAdapterKind;
  const openRouterRouting = value.openRouterRouting === undefined
    ? undefined
    : normalizeOpenRouterRouting(value.openRouterRouting);
  if ((adapterKind === "openrouter_chat_completions") !== Boolean(openRouterRouting)) {
    throw new ProviderConfigurationError("provider_routing_invalid");
  }
  const defaultParams = openRouterRouting
    ? openRouterDefaultParams(rawDefaultParams, openRouterRouting)
    : rawDefaultParams;

  return {
    adapterKind,
    answerSelectable: value.answerSelectable ?? true,
    capabilities: normalizeProviderModelCapabilities(value.capabilities),
    defaultParams,
    ...(openRouterRouting ? { openRouterRouting } : {}),
    upstreamModelId: value.upstreamModelId.trim()
  };
}
