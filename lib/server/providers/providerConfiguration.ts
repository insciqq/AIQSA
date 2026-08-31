import type { ProviderModelCapabilities } from "./types";
import type { EmbeddingProviderFamily } from "../../domain/embeddingModels";
import {
  compatibleReasoningRequestMappingDefault,
  type ProviderReasoningRequestMapping
} from "../../contracts/providerReasoningRequestMapping";

const MAX_API_ROOT_LENGTH = 2_048;
const MAX_DEFAULT_PARAMS_BYTES = 32 * 1_024;
const MAX_PROVIDER_ROUTE_COUNT = 16;
const MAX_REASONING_CONTROL_COUNT = 16;
const MAX_REASONING_CONTROL_LENGTH = 32;
const MAX_REASONING_PATH_LENGTH = 128;
const MAX_REASONING_PATH_DEPTH = 4;
const MAX_EMBEDDING_NATIVE_DIMENSION = 65_536;
const MAX_EMBEDDING_TARGET_DIMENSION = 2_000;
const MAX_EMBEDDING_QUERY_TEMPLATE_LENGTH = 2_048;
const FORBIDDEN_REASONING_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
const RESERVED_REASONING_REQUEST_ROOTS = new Set([
  "background",
  "include",
  "input",
  "instructions",
  "max_completion_tokens",
  "max_output_tokens",
  "messages",
  "metadata",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "store",
  "stream",
  "stream_options",
  "temperature",
  "tool_choice",
  "tools"
]);

export const DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS = 300_000;
export const MIN_PROVIDER_RESPONSE_TIMEOUT_MS = 5_000;
export const MAX_PROVIDER_RESPONSE_TIMEOUT_MS = 900_000;

export const providerAdapterKinds = [
  "anthropic_messages",
  "deepseek_responses_native",
  "gemini_interactions_native",
  "openai_chat_completions_compatible",
  "openai_responses_compatible",
  "openai_responses_native",
  "openai_embeddings_compatible",
  "openrouter_chat_completions",
  "openrouter_rerank"
] as const;

export type ProviderAdapterKind = (typeof providerAdapterKinds)[number];
export type ProviderFamily =
  | "anthropic"
  | "deepseek"
  | "gemini"
  | "openai"
  | "openai_compatible"
  | "openrouter";

export type ProviderAuthenticationMode = "bearer" | "none";
export type ProviderModelClass = "answer" | "embedding" | "reranker";

export type EmbeddingModelConfiguration = Readonly<{
  nativeDimension: number;
  providerFamily: EmbeddingProviderFamily;
  queryInstructionTemplate: string | null;
  supportsMrl: boolean;
  targetDimension: number;
}>;

export type ProviderConnectionConfiguration = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode: ProviderAuthenticationMode;
  responseTimeoutMs: number;
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
  embedding?: EmbeddingModelConfiguration;
  modelClass: ProviderModelClass;
  openRouterRouting?: OpenRouterRoutingConfiguration;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
  /** Missing means inherit the connection response deadline. */
  responseTimeoutMs?: number;
  upstreamModelId: string;
};

export type ProviderConfigurationErrorCode =
  | "provider_adapter_kind_invalid"
  | "provider_answer_selection_invalid"
  | "provider_api_root_invalid"
  | "provider_authentication_mode_invalid"
  | "provider_default_params_invalid"
  | "provider_embedding_configuration_invalid"
  | "provider_model_class_invalid"
  | "provider_model_capabilities_invalid"
  | "provider_reasoning_mapping_invalid"
  | "provider_response_timeout_invalid"
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

export function normalizeProviderResponseTimeoutMs(
  value: unknown,
  fallback: number | null = DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS
): number | undefined {
  if (value === undefined && fallback !== null) return fallback;
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < MIN_PROVIDER_RESPONSE_TIMEOUT_MS ||
    Number(value) > MAX_PROVIDER_RESPONSE_TIMEOUT_MS
  ) {
    throw new ProviderConfigurationError("provider_response_timeout_invalid");
  }
  return Number(value);
}

export function providerResponseTimeoutMsFromSeconds(
  value: unknown,
  fallbackMs: number | null = DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS
): number | undefined {
  if (value === undefined) return fallbackMs ?? undefined;
  if (!Number.isSafeInteger(value)) {
    throw new ProviderConfigurationError("provider_response_timeout_invalid");
  }
  return normalizeProviderResponseTimeoutMs(Number(value) * 1_000, null);
}

export function effectiveProviderResponseTimeoutMs(
  connection: ProviderConnectionConfiguration,
  model?: Pick<ProviderModelConfiguration, "responseTimeoutMs"> | null
): number {
  return model?.responseTimeoutMs ?? connection.responseTimeoutMs;
}

function normalizeReasoningPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderConfigurationError("provider_reasoning_mapping_invalid");
  }
  const path = value.trim();
  const segments = path.split(".");
  if (
    !path ||
    path.length > MAX_REASONING_PATH_LENGTH ||
    segments.length > MAX_REASONING_PATH_DEPTH ||
    segments.some((segment) =>
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(segment) ||
      FORBIDDEN_REASONING_PATH_SEGMENTS.has(segment)
    ) ||
    RESERVED_REASONING_REQUEST_ROOTS.has(segments[0]!)
  ) {
    throw new ProviderConfigurationError("provider_reasoning_mapping_invalid");
  }
  return segments.join(".");
}

export function normalizeProviderReasoningRequestMapping(
  value: unknown
): ProviderReasoningRequestMapping {
  if (!isRecord(value)) {
    throw new ProviderConfigurationError("provider_reasoning_mapping_invalid");
  }
  const allowedKeys = new Set(["effortPath", "modePath"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ProviderConfigurationError("provider_reasoning_mapping_invalid");
  }
  const effortPath = normalizeReasoningPath(value.effortPath);
  const modePath = value.modePath === undefined
    ? undefined
    : normalizeReasoningPath(value.modePath);
  if (
    modePath && (
      modePath === effortPath ||
      modePath.startsWith(`${effortPath}.`) ||
      effortPath.startsWith(`${modePath}.`)
    )
  ) {
    throw new ProviderConfigurationError("provider_reasoning_mapping_invalid");
  }
  return {
    effortPath,
    ...(modePath ? { modePath } : {})
  };
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
    value.authenticationMode !== "bearer" &&
    value.authenticationMode !== "none"
  ) {
    throw new ProviderConfigurationError("provider_authentication_mode_invalid");
  }
  const apiRoot = normalizeProviderApiRoot(value.apiRoot, value.allowPrivateNetwork);
  const responseTimeoutMs = normalizeProviderResponseTimeoutMs(value.responseTimeoutMs, null);
  if (responseTimeoutMs === undefined) {
    throw new ProviderConfigurationError("provider_response_timeout_invalid");
  }
  if (
    value.authenticationMode === "none" &&
    (!value.allowPrivateNetwork || new URL(apiRoot).protocol !== "http:")
  ) {
    throw new ProviderConfigurationError("provider_authentication_mode_invalid");
  }

  return {
    allowPrivateNetwork: value.allowPrivateNetwork,
    apiRoot,
    authenticationMode: value.authenticationMode,
    responseTimeoutMs
  };
}

export function providerAuthenticationMode(
  configuration: ProviderConnectionConfiguration
): ProviderAuthenticationMode {
  return configuration.authenticationMode;
}

export function providerRequestEndpoint(
  configuration: ProviderConnectionConfiguration,
  adapterKind: ProviderAdapterKind
): string {
  const terminalPath = adapterKind === "openai_embeddings_compatible" ? "embeddings" :
    adapterKind === "openrouter_rerank" ? "rerank" :
    adapterKind === "gemini_interactions_native" ? "interactions" :
    adapterKind.includes("responses") ? "responses" :
    adapterKind === "anthropic_messages" ? "messages" : "chat/completions";
  return `${configuration.apiRoot}/${terminalPath}`;
}

function normalizeEmbeddingModelConfiguration(
  value: unknown
): EmbeddingModelConfiguration {
  if (!isRecord(value)) {
    throw new ProviderConfigurationError("provider_embedding_configuration_invalid");
  }
  const providerFamily = value.providerFamily;
  const nativeDimension = Number(value.nativeDimension);
  const targetDimension = Number(value.targetDimension);
  const supportsMrl = value.supportsMrl;
  const template = value.queryInstructionTemplate;
  const templateMatches = typeof template === "string"
    ? template.match(/\{text\}/gu)?.length ?? 0
    : 0;
  if (
    (providerFamily !== "openai" &&
      providerFamily !== "openai_compatible" &&
      providerFamily !== "openrouter") ||
    !Number.isSafeInteger(nativeDimension) ||
    nativeDimension < 1 ||
    nativeDimension > MAX_EMBEDDING_NATIVE_DIMENSION ||
    !Number.isSafeInteger(targetDimension) ||
    targetDimension < 1 ||
    targetDimension > MAX_EMBEDDING_TARGET_DIMENSION ||
    targetDimension > nativeDimension ||
    typeof supportsMrl !== "boolean" ||
    (!supportsMrl && targetDimension !== nativeDimension) ||
    (template !== null && (
      typeof template !== "string" ||
      !template.trim() ||
      template.length > MAX_EMBEDDING_QUERY_TEMPLATE_LENGTH ||
      /[\u0000\r\u007f]/u.test(template) ||
      templateMatches !== 1
    ))
  ) {
    throw new ProviderConfigurationError("provider_embedding_configuration_invalid");
  }
  return {
    nativeDimension,
    providerFamily,
    queryInstructionTemplate: template,
    supportsMrl,
    targetDimension
  };
}

function nonAnswerCapabilitiesAreInert(capabilities: ProviderModelCapabilities): boolean {
  return !capabilities.backgroundStreaming &&
    !capabilities.defaultMaxOutputTokens &&
    !capabilities.nativeBackground &&
    !capabilities.nativeImageGeneration &&
    !capabilities.nativePdfInput &&
    !capabilities.nativeSearch &&
    !capabilities.parallelToolCalls &&
    !capabilities.pdf &&
    !capabilities.reasoning &&
    !capabilities.defaultReasoningEffort &&
    !capabilities.defaultReasoningMode &&
    !capabilities.reasoningEfforts &&
    !capabilities.reasoningModes &&
    !capabilities.streaming &&
    !capabilities.streamUsage &&
    !capabilities.toolCalling &&
    !capabilities.vision;
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
    "streamUsage",
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
    ...(typeof value.streamUsage === "boolean" ? { streamUsage: value.streamUsage } : {}),
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
  if (typeof value.answerSelectable !== "boolean") {
    throw new ProviderConfigurationError("provider_answer_selection_invalid");
  }
  if (!boundedText(value.upstreamModelId, 256)) {
    throw new ProviderConfigurationError("provider_upstream_model_invalid");
  }
  const rawDefaultParams = normalizeProviderDefaultParams(value.defaultParams);

  const adapterKind = value.adapterKind as ProviderAdapterKind;
  const modelClass = value.modelClass;
  if (modelClass !== "answer" && modelClass !== "embedding" &&
    modelClass !== "reranker") {
    throw new ProviderConfigurationError("provider_model_class_invalid");
  }
  const capabilities = normalizeProviderModelCapabilities(value.capabilities);
  const embedding = value.embedding === undefined
    ? undefined
    : normalizeEmbeddingModelConfiguration(value.embedding);
  if (modelClass === "embedding") {
    if (
      adapterKind !== "openai_embeddings_compatible" ||
      value.answerSelectable !== false ||
      !embedding ||
      !nonAnswerCapabilitiesAreInert(capabilities) ||
      Object.keys(rawDefaultParams).length > 0
    ) {
      throw new ProviderConfigurationError("provider_embedding_configuration_invalid");
    }
  } else if (modelClass === "reranker") {
    if (
      adapterKind !== "openrouter_rerank" ||
      value.answerSelectable !== false ||
      embedding ||
      !nonAnswerCapabilitiesAreInert(capabilities) ||
      Object.keys(rawDefaultParams).length > 0
    ) {
      throw new ProviderConfigurationError("provider_model_class_invalid");
    }
  } else if (adapterKind === "openai_embeddings_compatible" ||
    adapterKind === "openrouter_rerank" || embedding) {
    throw new ProviderConfigurationError("provider_embedding_configuration_invalid");
  }
  if (
    capabilities.streamUsage !== undefined &&
    adapterKind !== "openai_chat_completions_compatible"
  ) {
    throw new ProviderConfigurationError("provider_model_capabilities_invalid");
  }
  const compatibleProtocol = adapterKind === "openai_responses_compatible"
    ? "responses"
    : adapterKind === "openai_chat_completions_compatible"
      ? "chat_completions"
      : null;
  if (
    value.reasoningRequestMapping !== undefined &&
    (!compatibleProtocol || !capabilities.reasoning)
  ) {
    throw new ProviderConfigurationError("provider_reasoning_mapping_invalid");
  }
  const reasoningRequestMapping = compatibleProtocol && capabilities.reasoning
    ? value.reasoningRequestMapping === undefined
      ? compatibleReasoningRequestMappingDefault(compatibleProtocol)
      : normalizeProviderReasoningRequestMapping(value.reasoningRequestMapping)
    : undefined;
  const openRouterRouting = value.openRouterRouting === undefined
    ? undefined
    : normalizeOpenRouterRouting(value.openRouterRouting);
  const openRouterRoutingRequired = adapterKind === "openrouter_chat_completions" ||
    adapterKind === "openrouter_rerank";
  const openRouterRoutingAllowed = openRouterRoutingRequired || (
    adapterKind === "openai_embeddings_compatible" &&
    modelClass === "embedding" &&
    embedding?.providerFamily === "openrouter"
  );
  if (
    openRouterRoutingRequired && !openRouterRouting ||
    openRouterRouting && !openRouterRoutingAllowed
  ) {
    throw new ProviderConfigurationError("provider_routing_invalid");
  }
  const defaultParams = openRouterRouting && adapterKind === "openrouter_chat_completions"
    ? openRouterDefaultParams(rawDefaultParams, openRouterRouting)
    : rawDefaultParams;
  const responseTimeoutMs = normalizeProviderResponseTimeoutMs(
    value.responseTimeoutMs,
    null
  );

  return {
    adapterKind,
    answerSelectable: value.answerSelectable,
    capabilities,
    defaultParams,
    ...(embedding ? { embedding } : {}),
    modelClass,
    ...(openRouterRouting ? { openRouterRouting } : {}),
    ...(reasoningRequestMapping ? { reasoningRequestMapping } : {}),
    ...(responseTimeoutMs === undefined ? {} : { responseTimeoutMs }),
    upstreamModelId: value.upstreamModelId.trim()
  };
}
