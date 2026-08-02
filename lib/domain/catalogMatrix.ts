import type { ProviderModelCatalogEntry, SearchStrategyCatalogEntry } from "./catalog";
import type { SearchPlan, SearchPlanMode } from "./search";
import type {
  CatalogWireModel,
  CatalogWireModelCapabilities,
  CatalogWireSearchStrategy,
  OpenRouterRoutePreferences
} from "../contracts/catalog";

export type CatalogModelCapabilities = CatalogWireModelCapabilities;
export type CatalogModel = CatalogWireModel;
export type CatalogSearchStrategy = CatalogWireSearchStrategy;
export type { OpenRouterRoutePreferences } from "../contracts/catalog";

const defaultOpenRouterRoutePreferences: OpenRouterRoutePreferences = {
  allowFallbacks: true,
  dataCollection: "deny",
  order: [],
  only: [],
  requireParameters: false,
  sort: "throughput",
  zdr: false
};

type SearchCombinationOption = Omit<Pick<
  SearchStrategyCatalogEntry,
  "adapterKind" | "executionModes" | "kind" | "protocol" | "strategyId"
>, "executionModes"> & {
  executionModes?: readonly SearchPlanMode[];
};

/**
 * Combination policy shared by defaults, settings, model switching, and the
 * composer. It mirrors server admission without exposing provider secrets.
 */
export function isSearchCombinationCompatible(
  optionIds: readonly string[],
  options: readonly SearchCombinationOption[],
  mode: SearchPlanMode
): boolean {
  const selected = optionIds.map((optionId) =>
    options.find((option) => option.strategyId === optionId));
  if (selected.some((option) => !option || option.kind === "none")) return false;
  const concrete = selected as SearchCombinationOption[];
  if (concrete.length > 1) {
    if (concrete.some((option) => option.protocol === "gemini_google_search")) return false;
    if (concrete.filter((option) => option.adapterKind === "answer_provider_hosted").length > 1) {
      return false;
    }
    if (mode === "all_selected" && concrete.some((option) =>
      option.executionModes?.includes("all_selected") !== true)) {
      return false;
    }
  }
  return true;
}

export function reconcileSearchPlanSelection(
  optionIds: readonly string[],
  mode: SearchPlanMode,
  options: readonly SearchCombinationOption[]
): SearchPlan {
  const selected: string[] = [];
  for (const optionId of optionIds) {
    if (selected.length >= 3 || selected.includes(optionId)) continue;
    if (isSearchCombinationCompatible([...selected, optionId], options, "model_choice")) {
      selected.push(optionId);
    }
  }
  if (selected.length === 0) return { mode: "all_selected", optionIds: [] };
  return {
    mode: isSearchCombinationCompatible(selected, options, mode) ? mode : "model_choice",
    optionIds: selected
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeOpenRouterRoutePreferences(input: unknown): OpenRouterRoutePreferences {
  if (!isRecord(input)) {
    return defaultOpenRouterRoutePreferences;
  }

  const provider = isRecord(input.provider) ? input.provider : input;
  const sort = provider.sort;
  const dataCollection = provider.dataCollection;
  const order = provider.order;
  const only = provider.only;

  return {
    allowFallbacks:
      typeof provider.allowFallbacks === "boolean"
        ? provider.allowFallbacks
        : typeof provider.allow_fallbacks === "boolean"
          ? provider.allow_fallbacks
          : defaultOpenRouterRoutePreferences.allowFallbacks,
    dataCollection:
      dataCollection === "allow" || dataCollection === "deny"
        ? dataCollection
        : defaultOpenRouterRoutePreferences.dataCollection,
    order: Array.isArray(order) ? order.filter((item): item is string => typeof item === "string") : [],
    only: Array.isArray(only) ? only.filter((item): item is string => typeof item === "string") : [],
    requireParameters:
      typeof provider.requireParameters === "boolean"
        ? provider.requireParameters
        : typeof provider.require_parameters === "boolean"
          ? provider.require_parameters
          : defaultOpenRouterRoutePreferences.requireParameters,
    sort: sort === "latency" || sort === "price" || sort === "throughput" ? sort : defaultOpenRouterRoutePreferences.sort,
    zdr: typeof provider.zdr === "boolean" ? provider.zdr : defaultOpenRouterRoutePreferences.zdr
  };
}

export function availableSearchStrategiesForModel(
  model: ProviderModelCatalogEntry,
  entitledStrategies: SearchStrategyCatalogEntry[]
): string[] {
  const strategyIds = new Set<string>();

  for (const strategy of entitledStrategies) {
    if (strategy.kind === "none") {
      strategyIds.add(strategy.strategyId);
      continue;
    }

    if (
      strategy.kind === "gemini_google_search" &&
      model.adapterKind === "gemini_interactions_native" &&
      model.capabilities.nativeSearch
    ) {
      strategyIds.add(strategy.strategyId);
      continue;
    }

    if (
      strategy.kind === "openai_native_web_search" &&
      (model.adapterKind === "openai_responses_native" ||
        model.adapterKind === "openai_responses_compatible") &&
      model.capabilities.nativeSearch
    ) {
      strategyIds.add(strategy.strategyId);
      continue;
    }

    if (strategy.kind === "perplexity_tool_search") {
      const isAnswerModel = model.modelId !== strategy.providerModelId;

      if (isAnswerModel && model.capabilities.toolCalling) {
        strategyIds.add(strategy.strategyId);
      }
      continue;
    }

    if (
      strategy.kind === "provider_model_web_search" &&
      strategy.adapterKind === "provider_model_client"
    ) {
      if (model.capabilities.toolCalling) {
        strategyIds.add(strategy.strategyId);
      }
      continue;
    }

  }

  return Array.from(strategyIds);
}

export function resolveSearchStrategyId(
  model: Pick<CatalogModel, "searchStrategyIds"> | null | undefined,
  preferredSearchStrategyId: string | null | undefined
): string {
  const strategyIds = model?.searchStrategyIds ?? [];

  if (preferredSearchStrategyId && strategyIds.includes(preferredSearchStrategyId)) {
    return preferredSearchStrategyId;
  }

  if (strategyIds.includes("search-disabled")) {
    return "search-disabled";
  }

  return strategyIds[0] ?? "search-disabled";
}

export function buildCatalogModel(
  model: ProviderModelCatalogEntry,
  entitledStrategies: SearchStrategyCatalogEntry[]
): CatalogModel {
  const searchStrategyIds = availableSearchStrategiesForModel(model, entitledStrategies);
  const openRouterPerplexitySearch = searchStrategyIds.includes("perplexity-tool-search");
  const controls = model.parameterControls;
  const reasoningDefaults = controls.reasoningEffort.supported
    ? {
        effort: controls.reasoningEffort.defaultValue,
        ...(controls.reasoningMode?.supported
          ? { mode: controls.reasoningMode.defaultValue }
          : {})
      }
    : undefined;
  const defaultParams: Record<string, unknown> = {
    ...(model.adapterKind === "anthropic_messages" ||
    model.adapterKind === "openrouter_chat_completions"
      ? { maxTokens: controls.maxOutputTokens.defaultValue }
      : { maxOutputTokens: controls.maxOutputTokens.defaultValue }),
    ...(controls.background.supported
      ? { background: controls.background.defaultValue }
      : {}),
    ...(reasoningDefaults ? { reasoning: reasoningDefaults } : {}),
    ...(controls.stream.supported ? { stream: controls.stream.defaultValue } : {}),
    ...(controls.temperature.supported
      ? { temperature: controls.temperature.defaultValue }
      : {})
  };

  // `defaultParams` in the active provider model is server-owned execution
  // configuration and may contain vendor extensions. The ordinary catalog
  // publishes only the small UI-control projection above. `verbosity` is the
  // one shape marker needed to choose OpenRouter's supported effort control.
  if (
    model.adapterKind === "openrouter_chat_completions" &&
    typeof model.defaultParams.verbosity === "string" &&
    controls.reasoningEffort.supported
  ) {
    defaultParams.verbosity = controls.reasoningEffort.defaultValue;
  }

  return {
    capabilities: {
      background: model.parameterControls.background.supported,
      documentInputMode: model.capabilities.nativePdfInput
        ? "native_pdf"
        : model.capabilities.pdf
          ? "pdf_text_extraction"
          : "none",
      imageInput: model.capabilities.vision,
      nativeWebSearch:
        (model.adapterKind === "openai_responses_native" ||
          model.adapterKind === "openai_responses_compatible" ||
          model.adapterKind === "gemini_interactions_native") &&
        model.capabilities.nativeSearch,
      openRouterPerplexitySearch,
      reasoning: model.capabilities.reasoning,
      streaming: model.capabilities.streaming,
      text: true,
      toolCalling: model.capabilities.toolCalling === true
    },
    contextWindow: model.contextWindow,
    defaultParams,
    displayName: model.displayName,
    modelId: model.modelId,
    parameterControls: model.parameterControls,
    provider: model.provider,
    providerFamily: model.providerFamily,
    searchStrategyIds,
    upstreamModelId: model.upstreamModelId
  };
}

export function toCatalogSearchStrategy(strategy: SearchStrategyCatalogEntry): CatalogSearchStrategy {
  return {
    ...(strategy.adapterKind && strategy.adapterKind !== "none"
      ? { adapterKind: strategy.adapterKind }
      : {}),
    displayName: strategy.displayName,
    ...(strategy.executionModes ? { executionModes: strategy.executionModes } : {}),
    kind: strategy.kind,
    ...(strategy.privacy ? { privacy: strategy.privacy } : {}),
    ...(strategy.protocol ? { protocol: strategy.protocol } : {}),
    ...(strategy.revisionId ? { revisionId: strategy.revisionId } : {}),
    strategyId: strategy.strategyId
  };
}
