import type {
  AdminCompatibleDiscoveredModel,
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderAdapterKind,
  AdminProviderConnection,
  AdminProviderModel,
  AdminProviderModelCapabilities,
  AdminProviderModelClass,
  AdminProviderModelConfiguration
} from "@/lib/contracts/adminProviders";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "@/lib/contracts/adminProviders";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";
import { defaultProviderModels, type ProviderModelCatalogEntry } from "@/lib/domain/catalog";

/**
 * Form model of the Add / edit model sheet (PRD 5.4.1): what the fields
 * hold, how a saved model becomes a form, how the form becomes the request
 * body, and the hints the Model field offers per provider family. Pure.
 */

export type ModelForm = Readonly<{
  adapterKind: AdminProviderAdapterKind;
  answerSelectable: boolean;
  capabilities: AdminProviderModelCapabilities;
  dataCollectionAllowed: boolean;
  defaultParamsText: string;
  displayName: string;
  modelClass: AdminProviderModelClass;
  openRouterRoutingMode: "automatic" | "only_selected";
  providerTags: readonly string[];
  reasoningEffortPath: string;
  reasoningModePath: string;
  responseTimeoutSeconds: string;
  upstreamModelId: string;
}>;

export type ModelFormBody = Readonly<{
  configuration: AdminProviderModelConfiguration;
  displayName: string;
  expectedDraftVersion?: number;
}>;

export type ModelFormResult =
  | Readonly<{ body: ModelFormBody; ok: true }>
  | Readonly<{ error: string; field: "defaultParams" | "routing" | "timeout" | "upstreamModelId"; ok: false }>;

export function adapterForFamily(family: AdminProviderConnection["family"]): AdminProviderAdapterKind {
  if (family === "anthropic") return "anthropic_messages";
  if (family === "deepseek") return "deepseek_responses_native";
  if (family === "gemini") return "gemini_interactions_native";
  if (family === "openrouter") return "openrouter_chat_completions";
  if (family === "openai") return "openai_responses_native";
  return "openai_responses_compatible";
}

function initialCapabilities(family: AdminProviderConnection["family"]): AdminProviderModelCapabilities {
  return {
    backgroundStreaming: family === "openai",
    nativeBackground: family === "openai",
    nativePdfInput: family === "openai",
    nativeSearch: family === "openai" || family === "deepseek" || family === "gemini",
    parallelToolCalls: family !== "gemini" && family !== "openai_compatible",
    pdf: true,
    reasoning: family === "deepseek" || family === "gemini",
    streaming: true,
    toolCalling: family !== "openai_compatible",
    vision: family === "gemini"
  };
}

function dataCollectionAllowed(defaultParams: Record<string, unknown>): boolean {
  const provider = defaultParams.provider;
  if (typeof provider !== "object" || provider === null || Array.isArray(provider)) return false;
  const value = (provider as Record<string, unknown>).dataCollection ??
    (provider as Record<string, unknown>).data_collection;
  return value === "allow";
}

/** Writes the OpenRouter data-collection choice into the default parameters; `deny` is the omitted default. */
export function withDataCollection(
  defaultParams: Record<string, unknown>,
  allowed: boolean
): Record<string, unknown> {
  const current = typeof defaultParams.provider === "object" && defaultParams.provider !== null &&
    !Array.isArray(defaultParams.provider)
    ? { ...(defaultParams.provider as Record<string, unknown>) }
    : {};
  delete current.data_collection;
  if (allowed) current.dataCollection = "allow";
  else delete current.dataCollection;
  const next = { ...defaultParams };
  if (Object.keys(current).length) next.provider = current;
  else delete next.provider;
  return next;
}

export function blankModelForm(connection: Pick<AdminProviderConnection, "family">): ModelForm {
  const adapterKind = adapterForFamily(connection.family);
  const mapping = compatibleReasoningRequestMappingDefault(
    adapterKind === "openai_responses_compatible" ? "responses" : "chat_completions"
  );
  return {
    adapterKind,
    answerSelectable: true,
    capabilities: initialCapabilities(connection.family),
    dataCollectionAllowed: false,
    defaultParamsText: "{}",
    displayName: "",
    modelClass: "answer",
    openRouterRoutingMode: "automatic",
    providerTags: [],
    reasoningEffortPath: mapping.effortPath,
    reasoningModePath: adapterKind === "openai_responses_compatible" ? "reasoning.mode" : "",
    responseTimeoutSeconds: "",
    upstreamModelId: ""
  };
}

export function modelFormFrom(model: AdminProviderModel): ModelForm {
  const configuration = model.draftConfig;
  const mapping = configuration.reasoningRequestMapping ?? compatibleReasoningRequestMappingDefault(
    configuration.adapterKind === "openai_responses_compatible" ? "responses" : "chat_completions"
  );
  return {
    adapterKind: configuration.adapterKind,
    answerSelectable: configuration.answerSelectable,
    capabilities: { ...configuration.capabilities },
    dataCollectionAllowed: dataCollectionAllowed(configuration.defaultParams),
    defaultParamsText: JSON.stringify(configuration.defaultParams, null, 2),
    displayName: model.displayName,
    modelClass: model.modelClass ?? configuration.modelClass ?? "answer",
    openRouterRoutingMode: configuration.openRouterRouting?.mode ?? "automatic",
    providerTags: [...(configuration.openRouterRouting?.providers ?? [])],
    reasoningEffortPath: mapping.effortPath,
    reasoningModePath: mapping.modePath ?? "",
    responseTimeoutSeconds: configuration.responseTimeoutSeconds === undefined
      ? ""
      : String(configuration.responseTimeoutSeconds),
    upstreamModelId: configuration.upstreamModelId
  };
}

export function modelFormsEqual(left: ModelForm, right: ModelForm): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Capabilities OpenRouter reports for a catalog model, in AIQSA's terms. */
export function capabilitiesFromOpenRouter(model: AdminOpenRouterDiscoveredModel): AdminProviderModelCapabilities {
  const parameters = new Set(model.supportedParameters);
  const inputs = new Set(model.inputModalities);
  return {
    ...(model.contextLength ? { contextWindow: model.contextLength } : {}),
    nativePdfInput: false,
    nativeSearch: false,
    parallelToolCalls: parameters.has("parallel_tool_calls"),
    pdf: true,
    reasoning: parameters.has("reasoning"),
    streaming: true,
    toolCalling: parameters.has("tools"),
    vision: inputs.has("image")
  };
}

/** `1M context · tools, reasoning, image input` under the OpenRouter Model field. */
export function describeOpenRouterModel(model: AdminOpenRouterDiscoveredModel): string {
  const parts: string[] = [];
  if (model.contextLength) {
    parts.push(model.contextLength >= 1_000_000
      ? `${Math.round(model.contextLength / 100_000) / 10}M context`
      : `${Math.round(model.contextLength / 1_000)}K context`);
  }
  const features = [
    model.supportedParameters.includes("tools") ? "tools" : null,
    model.supportedParameters.includes("reasoning") ? "reasoning" : null,
    model.inputModalities.includes("image") ? "image input" : null
  ].filter((entry): entry is string => entry !== null);
  if (features.length) parts.push(features.join(", "));
  return parts.join(" · ");
}

export function applyOpenRouterModel(form: ModelForm, model: AdminOpenRouterDiscoveredModel): ModelForm {
  return {
    ...form,
    capabilities: capabilitiesFromOpenRouter(model),
    displayName: model.name,
    openRouterRoutingMode: "automatic",
    providerTags: [],
    upstreamModelId: model.id
  };
}

export function applyCompatibleModel(form: ModelForm, model: AdminCompatibleDiscoveredModel | null, id: string): ModelForm {
  // Choosing the same id after rediscovery must keep reviewed overrides.
  if (form.upstreamModelId === id) return form;
  return {
    ...form,
    capabilities: {
      ...initialCapabilities("openai_compatible"),
      ...model?.capabilities,
      nativeSearch: form.capabilities.nativeSearch,
      ...(form.capabilities.nativeImageGeneration === undefined ? {} : { nativeImageGeneration: form.capabilities.nativeImageGeneration })
    },
    displayName: form.displayName.trim() ? form.displayName : id,
    upstreamModelId: id
  };
}

/** Built-in catalog hints for the Model field of non-OpenRouter families (PRD 5.4.1). */
export function catalogHintsFor(family: AdminProviderConnection["family"]): readonly ProviderModelCatalogEntry[] {
  return defaultProviderModels.filter((entry) => entry.providerFamily === family);
}

export function applyCatalogHint(form: ModelForm, hint: ProviderModelCatalogEntry): ModelForm {
  return {
    ...form,
    capabilities: {
      ...form.capabilities,
      ...hint.capabilities,
      ...(hint.contextWindow ? { contextWindow: hint.contextWindow } : {})
    },
    defaultParamsText: JSON.stringify(hint.defaultParams, null, 2),
    displayName: form.displayName.trim() ? form.displayName : hint.displayName,
    upstreamModelId: hint.upstreamModelId
  };
}

/** Provider name plus the route tag, never the quantization suffix (PRD 5.4.1). */
export function endpointLabel(endpoint: AdminOpenRouterDiscoveredEndpoint): string {
  return endpoint.providerName || endpoint.name;
}

export function endpointDetail(endpoint: AdminOpenRouterDiscoveredEndpoint): string {
  return endpoint.tag;
}

export function moveProviderTag(tags: readonly string[], index: number, direction: -1 | 1): string[] {
  const next = [...tags];
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Turns the form into the `Test & Save` request body or names the first invalid field. */
export function modelFormBody(
  form: ModelForm,
  connection: Pick<AdminProviderConnection, "family">,
  editing: Pick<AdminProviderModel, "draftConfig" | "draftVersion"> | null
): ModelFormResult {
  if (!form.upstreamModelId.trim()) {
    return { error: "Choose a model first.", field: "upstreamModelId", ok: false };
  }
  let defaultParams: Record<string, unknown>;
  try {
    const parsed = JSON.parse(form.defaultParamsText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    defaultParams = parsed as Record<string, unknown>;
  } catch {
    return { error: "Default parameters must be one JSON object.", field: "defaultParams", ok: false };
  }
  if (connection.family === "openrouter" && form.openRouterRoutingMode === "only_selected" && !form.providerTags.length) {
    return { error: "Add at least one provider or use Automatic routing.", field: "routing", ok: false };
  }
  const timeout = form.responseTimeoutSeconds.trim();
  if (timeout && (
    !/^\d+$/u.test(timeout) ||
    Number(timeout) < ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS ||
    Number(timeout) > ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS
  )) {
    return {
      error: `Response timeout must be blank or a whole number from ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS} to ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS} seconds.`,
      field: "timeout",
      ok: false
    };
  }
  const compatible = connection.family === "openai_compatible";
  const answer = form.modelClass === "answer";
  const configuration: AdminProviderModelConfiguration = {
    ...(editing?.draftConfig ?? {}),
    adapterKind: form.adapterKind,
    answerSelectable: answer ? form.answerSelectable : false,
    capabilities: form.capabilities,
    defaultParams: connection.family === "openrouter"
      ? withDataCollection(defaultParams, form.dataCollectionAllowed)
      : defaultParams,
    modelClass: form.modelClass,
    ...(connection.family === "openrouter"
      ? {
          openRouterRouting: form.openRouterRoutingMode === "automatic"
            ? { mode: "automatic" as const, providers: [] as [] }
            : { mode: "only_selected" as const, providers: [...form.providerTags] }
        }
      : {}),
    upstreamModelId: form.upstreamModelId.trim()
  };
  delete configuration.reasoningRequestMapping;
  delete configuration.responseTimeoutSeconds;
  if (compatible && answer && form.capabilities.reasoning) {
    configuration.reasoningRequestMapping = {
      effortPath: form.reasoningEffortPath.trim(),
      ...(form.reasoningModePath.trim() ? { modePath: form.reasoningModePath.trim() } : {})
    };
  }
  if (timeout) configuration.responseTimeoutSeconds = Number(timeout);
  return {
    body: {
      configuration,
      displayName: form.displayName.trim() || form.upstreamModelId.trim(),
      ...(editing ? { expectedDraftVersion: editing.draftVersion } : {})
    },
    ok: true
  };
}
