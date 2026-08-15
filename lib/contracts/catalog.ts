import type { ErrorResponse, SessionErrorCode } from "./http";
import {
  decodeSearchPlan,
  type SearchAdapterKind,
  type SearchPlan,
  type SearchPlanMode,
  type SearchProtocol
} from "./search";
import {
  resolveProviderConnectionLabels,
  stripEndpointHostFragments
} from "./providerConnectionLabels";

export type ReasoningEffort = string;
export type ReasoningMode = string;

export type ModelParameterControls = {
  background: {
    defaultValue: boolean;
    supported: boolean;
  };
  maxOutputTokens: {
    defaultValue: number;
    maxValue: number;
  };
  reasoningEffort: {
    defaultValue: ReasoningEffort;
    options: ReasoningEffort[];
    supported: boolean;
  };
  reasoningMode?: {
    defaultValue: ReasoningMode;
    options: ReasoningMode[];
    supported: boolean;
  };
  stream: {
    defaultValue: boolean;
    supported: boolean;
  };
  temperature: {
    defaultValue: number;
    maxValue: number;
    minValue: number;
    supported: boolean;
  };
};

export type OpenRouterRoutePreferences = {
  allowFallbacks: boolean;
  dataCollection: "allow" | "deny";
  order: string[];
  only: string[];
  requireParameters: boolean;
  sort: "latency" | "price" | "throughput";
  zdr: boolean;
};

export type CatalogWireModelCapabilities = {
  background: boolean;
  documentInputMode: "native_pdf" | "none" | "pdf_text_extraction";
  imageInput: boolean;
  nativeWebSearch: boolean;
  openRouterPerplexitySearch: boolean;
  reasoning: boolean;
  streaming: boolean;
  text: true;
  toolCalling: boolean;
};

export type CatalogWireModel = {
  capabilities: CatalogWireModelCapabilities;
  contextWindow: number | null;
  defaultParams: Record<string, unknown>;
  displayName: string;
  modelId: string;
  parameterControls: ModelParameterControls;
  provider: string;
  providerFamily: string;
  searchOptionCompatibility?: Record<string, {
    clientToolCompatible: boolean;
    executionModes: SearchPlanMode[];
  }>;
  searchStrategyIds: string[];
  upstreamModelId: string;
};

export type CatalogWireSearchStrategy = {
  adapterKind?: SearchAdapterKind;
  description?: string;
  displayName: string;
  executionModes?: SearchPlanMode[];
  kind: "anthropic_native_web_search" | "gemini_google_search" | "none" | "openai_native_web_search" | "perplexity_tool_search" | "provider_model_web_search" | "web_search";
  privacy?: "answer_provider" | "query_only";
  protocol?: SearchProtocol;
  revisionId?: string;
  strategyId: string;
};

export type CatalogModel = Omit<
  CatalogWireModel,
  "capabilities" | "providerFamily" | "upstreamModelId"
> & {
  capabilities: Omit<CatalogWireModel["capabilities"], "text">;
  providerFamily?: string;
  upstreamModelId?: string;
};

export type CatalogSearchStrategy = CatalogWireSearchStrategy;

export type CatalogSearchStrategyKind = CatalogSearchStrategy["kind"];

export type CatalogDefaults = {
  controlValues: Record<string, unknown>;
  hasPersonalModelDefault: boolean;
  modelId: string;
  modelPreferenceSource: "none" | "organization" | "personal";
  organizationModelDefault: { modelId: string; provider: string } | null;
  personalModelDefault: { modelId: string; provider: string } | null;
  organizationSearchPlan: SearchPlan;
  provider: string;
  searchPlan: SearchPlan;
  searchPreferenceSource: "organization" | "personal";
  showCitations: boolean;
  showReasoningBlocks: boolean;
};

export type CatalogProvider = {
  family?: string;
  id: string;
  models: string[];
  name: string;
};

export type CatalogWireProvider = CatalogProvider & {
  family: string;
};

export type CatalogAttachmentLimits = {
  maxCount: number;
  maxEncodedBytes: number;
  maxMaterializedBytes: number;
};

export const DEFAULT_CATALOG_ATTACHMENT_LIMITS: Readonly<CatalogAttachmentLimits> = Object.freeze({
  maxCount: 20,
  maxEncodedBytes: 100_663_296,
  maxMaterializedBytes: 67_108_864
});

export const CATALOG_ATTACHMENT_LIMIT_CEILINGS: Readonly<CatalogAttachmentLimits> = Object.freeze({
  maxCount: 100,
  maxEncodedBytes: 402_653_184,
  maxMaterializedBytes: 268_435_456
});

export type Catalog = {
  attachmentLimits?: CatalogAttachmentLimits;
  defaults: CatalogDefaults;
  models: CatalogModel[];
  providers: CatalogProvider[];
  searchStrategies: CatalogSearchStrategy[];
};

export type CurrentUserCatalogWire = Omit<Catalog, "models" | "providers" | "searchStrategies"> & {
  models: CatalogWireModel[];
  providers: CatalogWireProvider[];
  searchStrategies: CatalogWireSearchStrategy[];
};

export type CatalogResponse = {
  catalog: CurrentUserCatalogWire;
};

export type CatalogServerErrorCode = SessionErrorCode | "user_not_found";

export type CatalogErrorResponse = ErrorResponse<CatalogServerErrorCode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function modelDefaultSelection(
  value: unknown
): value is { modelId: string; provider: string } | null {
  return value === null || (isRecord(value) && nonEmptyString(value.modelId) &&
    nonEmptyString(value.provider));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isModelParameterControls(value: unknown): value is ModelParameterControls {
  if (!isRecord(value)) {
    return false;
  }

  const reasoningMode = value.reasoningMode;

  return (
    isRecord(value.background) &&
    typeof value.background.defaultValue === "boolean" &&
    typeof value.background.supported === "boolean" &&
    isRecord(value.maxOutputTokens) &&
    finiteNumber(value.maxOutputTokens.defaultValue) &&
    finiteNumber(value.maxOutputTokens.maxValue) &&
    isRecord(value.reasoningEffort) &&
    typeof value.reasoningEffort.defaultValue === "string" &&
    stringArray(value.reasoningEffort.options) &&
    typeof value.reasoningEffort.supported === "boolean" &&
    (reasoningMode === undefined ||
      (isRecord(reasoningMode) &&
        typeof reasoningMode.defaultValue === "string" &&
        stringArray(reasoningMode.options) &&
        typeof reasoningMode.supported === "boolean")) &&
    isRecord(value.stream) &&
    typeof value.stream.defaultValue === "boolean" &&
    typeof value.stream.supported === "boolean" &&
    isRecord(value.temperature) &&
    finiteNumber(value.temperature.defaultValue) &&
    finiteNumber(value.temperature.maxValue) &&
    finiteNumber(value.temperature.minValue) &&
    typeof value.temperature.supported === "boolean"
  );
}

function decodeCatalogModel(value: unknown): CatalogModel | null {
  if (
    !isRecord(value) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.defaultParams) ||
    !nonEmptyString(value.displayName) ||
    !nonEmptyString(value.modelId) ||
    !nonEmptyString(value.provider) ||
    !nonEmptyString(value.providerFamily) ||
    !nonEmptyString(value.upstreamModelId) ||
    !(value.contextWindow === null || (
      finiteNumber(value.contextWindow) &&
      Number.isInteger(value.contextWindow) &&
      value.contextWindow > 0
    )) ||
    !stringArray(value.searchStrategyIds) ||
    !isModelParameterControls(value.parameterControls)
  ) {
    return null;
  }

  const capabilities = value.capabilities;
  const searchOptionCompatibility = value.searchOptionCompatibility;
  const documentInputMode = capabilities.documentInputMode;
  if (
    typeof capabilities.background !== "boolean" ||
    (documentInputMode !== "native_pdf" &&
      documentInputMode !== "none" &&
      documentInputMode !== "pdf_text_extraction") ||
    typeof capabilities.imageInput !== "boolean" ||
    typeof capabilities.nativeWebSearch !== "boolean" ||
    typeof capabilities.openRouterPerplexitySearch !== "boolean" ||
    typeof capabilities.reasoning !== "boolean" ||
    typeof capabilities.streaming !== "boolean" ||
    typeof capabilities.toolCalling !== "boolean" ||
    (searchOptionCompatibility !== undefined && (
      !isRecord(searchOptionCompatibility) ||
      Object.values(searchOptionCompatibility).some((candidate) =>
        !isRecord(candidate) ||
        typeof candidate.clientToolCompatible !== "boolean" ||
        !Array.isArray(candidate.executionModes) ||
        candidate.executionModes.some((mode) => mode !== "all_selected" && mode !== "model_choice")
      )
    )) ||
    ("text" in capabilities && capabilities.text !== true)
  ) {
    return null;
  }

  return {
    capabilities: {
      background: capabilities.background,
      documentInputMode,
      imageInput: capabilities.imageInput,
      nativeWebSearch: capabilities.nativeWebSearch,
      openRouterPerplexitySearch: capabilities.openRouterPerplexitySearch,
      reasoning: capabilities.reasoning,
      streaming: capabilities.streaming,
      toolCalling: capabilities.toolCalling
    },
    contextWindow: value.contextWindow,
    defaultParams: value.defaultParams,
    displayName: value.displayName,
    modelId: value.modelId,
    parameterControls: value.parameterControls,
    provider: value.provider,
    providerFamily: value.providerFamily,
    ...(searchOptionCompatibility
      ? {
          searchOptionCompatibility: Object.fromEntries(
            Object.entries(searchOptionCompatibility).map(([optionId, candidate]) => [
              optionId,
              {
                clientToolCompatible: (candidate as Record<string, unknown>)
                  .clientToolCompatible as boolean,
                executionModes: (candidate as Record<string, unknown>).executionModes as SearchPlanMode[]
              }
            ])
          )
        }
      : {}),
    searchStrategyIds: value.searchStrategyIds,
    upstreamModelId: value.upstreamModelId
  };
}

function decodeCatalogProvider(value: unknown): CatalogProvider | null {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.family) ||
    !nonEmptyString(value.id) ||
    !stringArray(value.models) ||
    !nonEmptyString(value.name)
  ) {
    return null;
  }

  return {
    family: value.family,
    id: value.id,
    models: value.models,
    name: value.name
  };
}

function decodeSearchStrategy(value: unknown): CatalogSearchStrategy | null {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.displayName) ||
    (value.kind !== "none" &&
      value.kind !== "anthropic_native_web_search" &&
      value.kind !== "gemini_google_search" &&
      value.kind !== "openai_native_web_search" &&
      value.kind !== "perplexity_tool_search" &&
      value.kind !== "provider_model_web_search" &&
      value.kind !== "web_search") ||
    !nonEmptyString(value.strategyId)
  ) {
    return null;
  }

  const adapterKind = value.adapterKind;
  const executionModes = value.executionModes;
  const privacy = value.privacy;
  const protocol = value.protocol;
  if (
    (adapterKind !== undefined &&
      adapterKind !== "answer_provider_hosted" &&
      adapterKind !== "provider_model_client") ||
    (executionModes !== undefined &&
      (!Array.isArray(executionModes) || executionModes.some((mode) =>
        mode !== "all_selected" && mode !== "model_choice"))) ||
    (privacy !== undefined && privacy !== "answer_provider" && privacy !== "query_only") ||
    (protocol !== undefined &&
      protocol !== "anthropic_web_search" &&
      protocol !== "gemini_google_search" &&
      protocol !== "openai_responses_web_search" &&
      protocol !== "openrouter_perplexity_chat") ||
    (value.revisionId !== undefined && !nonEmptyString(value.revisionId))
  ) {
    return null;
  }

  return {
    ...(adapterKind ? { adapterKind } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    displayName: value.displayName,
    ...(executionModes ? { executionModes: executionModes as SearchPlanMode[] } : {}),
    kind: value.kind,
    ...(privacy ? { privacy } : {}),
    ...(protocol ? { protocol } : {}),
    ...(value.revisionId ? { revisionId: value.revisionId } : {}),
    strategyId: value.strategyId
  };
}

function decodeCatalogAttachmentLimits(value: unknown): CatalogAttachmentLimits | null {
  if (
    !isRecord(value) ||
    !positiveSafeInteger(value.maxCount) ||
    value.maxCount > CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxCount ||
    !positiveSafeInteger(value.maxEncodedBytes) ||
    value.maxEncodedBytes > CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxEncodedBytes ||
    !positiveSafeInteger(value.maxMaterializedBytes) ||
    value.maxMaterializedBytes > CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxMaterializedBytes
  ) {
    return null;
  }

  return {
    maxCount: value.maxCount,
    maxEncodedBytes: value.maxEncodedBytes,
    maxMaterializedBytes: value.maxMaterializedBytes
  };
}

export function decodeCatalogResponse(value: unknown): Catalog | null {
  if (!isRecord(value) || !isRecord(value.catalog)) {
    return null;
  }

  const catalog = value.catalog;
  const defaults = catalog.defaults;
  const hasAttachmentLimits = Object.prototype.hasOwnProperty.call(catalog, "attachmentLimits");
  const attachmentLimits = hasAttachmentLimits
    ? decodeCatalogAttachmentLimits(catalog.attachmentLimits)
    : undefined;
  if (
    !isRecord(defaults) ||
    !isRecord(defaults.controlValues) ||
    typeof defaults.modelId !== "string" ||
    typeof defaults.hasPersonalModelDefault !== "boolean" ||
    (defaults.modelPreferenceSource !== "none" &&
      defaults.modelPreferenceSource !== "organization" &&
      defaults.modelPreferenceSource !== "personal") ||
    !modelDefaultSelection(defaults.organizationModelDefault) ||
    !modelDefaultSelection(defaults.personalModelDefault) ||
    typeof defaults.provider !== "string" ||
    typeof defaults.showCitations !== "boolean" ||
    typeof defaults.showReasoningBlocks !== "boolean" ||
    !Array.isArray(catalog.models) ||
    !Array.isArray(catalog.providers) ||
    !Array.isArray(catalog.searchStrategies)
  ) {
    return null;
  }

  const models = catalog.models.map(decodeCatalogModel);
  const providers = catalog.providers.map(decodeCatalogProvider);
  const searchStrategies = catalog.searchStrategies.map(decodeSearchStrategy);
  const decodedSearchPlan = decodeSearchPlan(defaults.searchPlan);
  const decodedOrganizationSearchPlan = decodeSearchPlan(defaults.organizationSearchPlan);
  if (
    models.some((model) => model === null) ||
    providers.some((provider) => provider === null) ||
    searchStrategies.some((strategy) => strategy === null) ||
    (hasAttachmentLimits && attachmentLimits === null) ||
    defaults.searchPlan === undefined ||
    defaults.organizationSearchPlan === undefined ||
    !decodedSearchPlan.ok ||
    !decodedOrganizationSearchPlan.ok ||
    (defaults.searchPreferenceSource !== "organization" && defaults.searchPreferenceSource !== "personal")
  ) {
    return null;
  }

  const decodedProviders = providers.filter(
    (provider): provider is CatalogProvider => provider !== null
  );
  // Ordinary UI receives display names with endpoint-host fragments removed;
  // stripping happens before collision resolution so "· ref" still
  // disambiguates connections whose stripped names collide. Admin surfaces
  // resolve their own labels from the unstripped source.
  const providerLabels = resolveProviderConnectionLabels(
    decodedProviders.map((provider) => ({
      id: provider.id,
      name: stripEndpointHostFragments(provider.name)
    }))
  );

  return {
    ...(attachmentLimits ? { attachmentLimits } : {}),
    defaults: {
      controlValues: defaults.controlValues,
      hasPersonalModelDefault: defaults.hasPersonalModelDefault,
      modelId: defaults.modelId,
      modelPreferenceSource: defaults.modelPreferenceSource,
      organizationModelDefault: defaults.organizationModelDefault,
      personalModelDefault: defaults.personalModelDefault,
      organizationSearchPlan: decodedOrganizationSearchPlan.plan,
      provider: defaults.provider,
      searchPlan: decodedSearchPlan.plan,
      searchPreferenceSource: defaults.searchPreferenceSource,
      showCitations: defaults.showCitations,
      showReasoningBlocks: defaults.showReasoningBlocks
    },
    models: models.filter((model): model is CatalogModel => model !== null),
    providers: decodedProviders.map((provider) => ({
      ...provider,
      name: providerLabels.get(provider.id) ?? provider.name
    })),
    searchStrategies: searchStrategies.filter(
      (strategy): strategy is CatalogSearchStrategy => strategy !== null
    )
  };
}
