import type { ErrorResponse, SessionErrorCode } from "./http";

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
};

export type CatalogWireModel = {
  capabilities: CatalogWireModelCapabilities;
  contextWindow: number;
  defaultParams: Record<string, unknown>;
  displayName: string;
  modelId: string;
  parameterControls: ModelParameterControls;
  provider: string;
  routeProviderPreferences?: OpenRouterRoutePreferences;
  searchStrategyIds: string[];
};

export type CatalogWireSearchStrategy = {
  config: Record<string, unknown>;
  description: string;
  displayName: string;
  kind: "none" | "openai_native_web_search" | "perplexity_tool_search";
  modelId?: string;
  provider: string;
  strategyId: string;
};

export type CatalogModel = Omit<
  CatalogWireModel,
  "capabilities" | "routeProviderPreferences"
> & {
  capabilities: Omit<CatalogWireModel["capabilities"], "text">;
};

export type CatalogSearchStrategy = Pick<
  CatalogWireSearchStrategy,
  "displayName" | "kind" | "strategyId"
>;

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
  promptPresetId: string | null;
  provider: string;
  searchStrategyId: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
};

export type CatalogProvider = {
  id: string;
  models: string[];
  name: string;
};

export type Catalog = {
  defaults: CatalogDefaults;
  models: CatalogModel[];
  promptPresets: PromptPreset[];
  providers: CatalogProvider[];
  searchStrategies: CatalogSearchStrategy[];
};

export type CurrentUserCatalogWire = Omit<Catalog, "models" | "searchStrategies"> & {
  models: CatalogWireModel[];
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

function decodeRoutePreferences(value: unknown): OpenRouterRoutePreferences | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.allowFallbacks !== "boolean" ||
    (value.dataCollection !== "allow" && value.dataCollection !== "deny") ||
    !stringArray(value.order) ||
    !stringArray(value.only) ||
    typeof value.requireParameters !== "boolean" ||
    (value.sort !== "latency" && value.sort !== "price" && value.sort !== "throughput") ||
    typeof value.zdr !== "boolean"
  ) {
    return null;
  }

  return {
    allowFallbacks: value.allowFallbacks,
    dataCollection: value.dataCollection,
    order: value.order,
    only: value.only,
    requireParameters: value.requireParameters,
    sort: value.sort,
    zdr: value.zdr
  };
}

function decodeCatalogModel(value: unknown): CatalogModel | null {
  if (
    !isRecord(value) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.defaultParams) ||
    !nonEmptyString(value.displayName) ||
    !nonEmptyString(value.modelId) ||
    !nonEmptyString(value.provider) ||
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
    ("text" in capabilities && capabilities.text !== true)
  ) {
    return null;
  }

  const routeProviderPreferences =
    "routeProviderPreferences" in value
      ? decodeRoutePreferences(value.routeProviderPreferences)
      : undefined;
  if (routeProviderPreferences === null) {
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
      streaming: capabilities.streaming
    },
    contextWindow: value.contextWindow,
    defaultParams: value.defaultParams,
    displayName: value.displayName,
    modelId: value.modelId,
    parameterControls: value.parameterControls,
    provider: value.provider,
    searchStrategyIds: value.searchStrategyIds
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
    !nonEmptyString(value.id) ||
    !stringArray(value.models) ||
    !nonEmptyString(value.name)
  ) {
    return null;
  }

  return {
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
      value.kind !== "openai_native_web_search" &&
      value.kind !== "perplexity_tool_search") ||
    !nonEmptyString(value.strategyId)
  ) {
    return null;
  }

  if (
    ("config" in value && !isRecord(value.config)) ||
    ("description" in value && typeof value.description !== "string") ||
    ("modelId" in value && typeof value.modelId !== "string") ||
    ("provider" in value && typeof value.provider !== "string")
  ) {
    return null;
  }

  return {
    displayName: value.displayName,
    kind: value.kind,
    strategyId: value.strategyId
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
    !nonEmptyString(defaults.modelId) ||
    (defaults.promptPresetId !== null && typeof defaults.promptPresetId !== "string") ||
    !nonEmptyString(defaults.provider) ||
    !nonEmptyString(defaults.searchStrategyId) ||
    typeof defaults.showCitations !== "boolean" ||
    typeof defaults.showReasoningBlocks !== "boolean" ||
    !Array.isArray(catalog.models) ||
    !Array.isArray(catalog.promptPresets) ||
    !Array.isArray(catalog.providers) ||
    !Array.isArray(catalog.searchStrategies)
  ) {
    return null;
  }

  const models = catalog.models.map(decodeCatalogModel);
  const promptPresets = catalog.promptPresets.map(decodePromptPreset);
  const providers = catalog.providers.map(decodeCatalogProvider);
  const searchStrategies = catalog.searchStrategies.map(decodeSearchStrategy);
  if (
    models.some((model) => model === null) ||
    promptPresets.some((prompt) => prompt === null) ||
    providers.some((provider) => provider === null) ||
    searchStrategies.some((strategy) => strategy === null)
  ) {
    return null;
  }

  return {
    defaults: {
      controlValues: defaults.controlValues,
      modelId: defaults.modelId,
      promptPresetId: defaults.promptPresetId,
      provider: defaults.provider,
      searchStrategyId: defaults.searchStrategyId,
      showCitations: defaults.showCitations,
      showReasoningBlocks: defaults.showReasoningBlocks
    },
    models: models.filter((model): model is CatalogModel => model !== null),
    promptPresets: promptPresets.filter((prompt): prompt is PromptPreset => prompt !== null),
    providers: providers.filter((provider): provider is CatalogProvider => provider !== null),
    searchStrategies: searchStrategies.filter(
      (strategy): strategy is CatalogSearchStrategy => strategy !== null
    )
  };
}
