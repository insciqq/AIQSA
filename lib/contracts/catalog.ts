import type { ErrorResponse, SessionErrorCode } from "./http";
import {
  RUN_PROFILE_IDS,
  type CatalogRunProfile,
  type RunProfileId
} from "./runProfiles";
import {
  decodeSearchPlan,
  type SearchAdapterKind,
  type SearchPlan,
  type SearchPlanMode,
  type SearchProtocol
} from "./search";

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
  contextWindow: number;
  defaultParams: Record<string, unknown>;
  displayName: string;
  modelId: string;
  parameterControls: ModelParameterControls;
  provider: string;
  providerFamily: string;
  searchStrategyIds: string[];
  upstreamModelId: string;
};

export type CatalogWireSearchStrategy = {
  adapterKind?: SearchAdapterKind;
  displayName: string;
  executionModes?: SearchPlanMode[];
  kind: "gemini_google_search" | "none" | "openai_native_web_search" | "perplexity_tool_search" | "provider_model_web_search";
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

export type PromptPreset = {
  developerPrompt: string | null;
  id: string;
  isDefault: boolean;
  name: string;
  systemPrompt: string;
};

export type CatalogDefaults = {
  controlValues: Record<string, unknown>;
  modelId: string;
  organizationSearchPlan?: SearchPlan;
  promptPresetId: string | null;
  provider: string;
  searchStrategyId: string;
  searchPlan?: SearchPlan;
  searchPreferenceSource?: "organization" | "personal";
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
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

export type Catalog = {
  defaults: CatalogDefaults;
  models: CatalogModel[];
  promptPresets: PromptPreset[];
  providers: CatalogProvider[];
  runProfiles?: CatalogRunProfile[];
  searchStrategies: CatalogSearchStrategy[];
};

export type CurrentUserCatalogWire = Omit<Catalog, "models" | "providers" | "runProfiles" | "searchStrategies"> & {
  models: CatalogWireModel[];
  providers: CatalogWireProvider[];
  runProfiles: CatalogRunProfile[];
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
    !finiteNumber(value.contextWindow) ||
    !stringArray(value.searchStrategyIds) ||
    !isModelParameterControls(value.parameterControls)
  ) {
    return null;
  }

  const capabilities = value.capabilities;
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
    searchStrategyIds: value.searchStrategyIds,
    upstreamModelId: value.upstreamModelId
  };
}

function decodePromptPreset(value: unknown): PromptPreset | null {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    typeof value.isDefault !== "boolean" ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.systemPrompt) ||
    (value.developerPrompt !== null && typeof value.developerPrompt !== "string")
  ) {
    return null;
  }

  return {
    developerPrompt: value.developerPrompt,
    id: value.id,
    isDefault: value.isDefault,
    name: value.name,
    systemPrompt: value.systemPrompt
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
      value.kind !== "gemini_google_search" &&
      value.kind !== "openai_native_web_search" &&
      value.kind !== "perplexity_tool_search" &&
      value.kind !== "provider_model_web_search") ||
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
      protocol !== "gemini_google_search" &&
      protocol !== "openai_responses_web_search" &&
      protocol !== "openrouter_perplexity_chat") ||
    (value.revisionId !== undefined && !nonEmptyString(value.revisionId))
  ) {
    return null;
  }

  return {
    ...(adapterKind ? { adapterKind } : {}),
    displayName: value.displayName,
    ...(executionModes ? { executionModes: executionModes as SearchPlanMode[] } : {}),
    kind: value.kind,
    ...(privacy ? { privacy } : {}),
    ...(protocol ? { protocol } : {}),
    ...(value.revisionId ? { revisionId: value.revisionId } : {}),
    strategyId: value.strategyId
  };
}

function decodeRunProfile(value: unknown): CatalogRunProfile | null {
  if (
    !isRecord(value) ||
    !RUN_PROFILE_IDS.includes(value.id as RunProfileId) ||
    !nonEmptyString(value.label) ||
    !nonEmptyString(value.description) ||
    typeof value.available !== "boolean"
  ) {
    return null;
  }
  const base = {
    description: value.description,
    id: value.id as RunProfileId,
    label: value.label
  };
  if (value.available) {
    if (
      !nonEmptyString(value.configurationLabel) ||
      !nonEmptyString(value.modelId) ||
      !nonEmptyString(value.provider) ||
      !nonEmptyString(value.reasoningEffort) ||
      !nonEmptyString(value.reasoningMode)
    ) {
      return null;
    }
    return {
      ...base,
      available: true,
      configurationLabel: value.configurationLabel,
      modelId: value.modelId,
      provider: value.provider,
      reasoningEffort: value.reasoningEffort,
      reasoningMode: value.reasoningMode
    };
  }
  if (
    value.unavailableReason !== "configuration_invalid" &&
    value.unavailableReason !== "model_unavailable"
  ) {
    return null;
  }
  return {
    ...base,
    available: false,
    unavailableReason: value.unavailableReason
  };
}

export function decodeCatalogResponse(value: unknown): Catalog | null {
  if (!isRecord(value) || !isRecord(value.catalog)) {
    return null;
  }

  const catalog = value.catalog;
  const defaults = catalog.defaults;
  if (
    !isRecord(defaults) ||
    !isRecord(defaults.controlValues) ||
    typeof defaults.modelId !== "string" ||
    (defaults.promptPresetId !== null && typeof defaults.promptPresetId !== "string") ||
    typeof defaults.provider !== "string" ||
    !nonEmptyString(defaults.searchStrategyId) ||
    typeof defaults.showCitations !== "boolean" ||
    typeof defaults.showReasoningBlocks !== "boolean" ||
    typeof defaults.showToolActivity !== "boolean" ||
    !Array.isArray(catalog.models) ||
    !Array.isArray(catalog.promptPresets) ||
    !Array.isArray(catalog.providers) ||
    !Array.isArray(catalog.runProfiles) ||
    !Array.isArray(catalog.searchStrategies)
  ) {
    return null;
  }

  const models = catalog.models.map(decodeCatalogModel);
  const promptPresets = catalog.promptPresets.map(decodePromptPreset);
  const providers = catalog.providers.map(decodeCatalogProvider);
  const runProfiles = catalog.runProfiles.map(decodeRunProfile);
  const searchStrategies = catalog.searchStrategies.map(decodeSearchStrategy);
  const decodedSearchPlan = defaults.searchPlan === undefined
    ? null
    : decodeSearchPlan(defaults.searchPlan, defaults.searchStrategyId);
  const decodedOrganizationSearchPlan = decodeSearchPlan(defaults.organizationSearchPlan);
  const runProfileIds = new Set(
    runProfiles.flatMap((profile) => profile ? [profile.id] : [])
  );
  if (
    models.some((model) => model === null) ||
    promptPresets.some((prompt) => prompt === null) ||
    providers.some((provider) => provider === null) ||
    runProfiles.some((profile) => profile === null) ||
    runProfileIds.size !== runProfiles.length ||
    searchStrategies.some((strategy) => strategy === null) ||
    (defaults.searchPlan !== undefined && !decodedSearchPlan?.ok) ||
    !decodedOrganizationSearchPlan.ok ||
    (defaults.searchPreferenceSource !== "organization" && defaults.searchPreferenceSource !== "personal")
  ) {
    return null;
  }

  return {
    defaults: {
      controlValues: defaults.controlValues,
      modelId: defaults.modelId,
      organizationSearchPlan: decodedOrganizationSearchPlan.plan,
      promptPresetId: defaults.promptPresetId,
      provider: defaults.provider,
      searchStrategyId: defaults.searchStrategyId,
      ...(decodedSearchPlan?.ok ? { searchPlan: decodedSearchPlan.plan } : {}),
      searchPreferenceSource: defaults.searchPreferenceSource,
      showCitations: defaults.showCitations,
      showReasoningBlocks: defaults.showReasoningBlocks,
      showToolActivity: defaults.showToolActivity
    },
    models: models.filter((model): model is CatalogModel => model !== null),
    promptPresets: promptPresets.filter((prompt): prompt is PromptPreset => prompt !== null),
    providers: providers.filter((provider): provider is CatalogProvider => provider !== null),
    runProfiles: runProfiles.filter((profile): profile is CatalogRunProfile => profile !== null),
    searchStrategies: searchStrategies.filter(
      (strategy): strategy is CatalogSearchStrategy => strategy !== null
    )
  };
}
