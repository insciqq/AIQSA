import type {
  ProviderModelCatalogEntry,
  SearchStrategyCatalogEntry,
  SearchStrategyRouteCatalogEntry
} from "./catalog";
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

type SearchCombinationOption = {
  executionModes?: readonly SearchPlanMode[];
  kind: SearchStrategyCatalogEntry["kind"] |
    "anthropic_native_web_search" |
    "openai_native_web_search" |
    "provider_model_web_search";
  strategyId: string;
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
    if (mode === "all_selected" && concrete.some((option) =>
      option.executionModes !== undefined &&
      !option.executionModes.includes("all_selected"))) {
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

export function reconcileModelSearchPlan(
  model: Pick<CatalogModel, "searchOptionCompatibility" | "searchStrategyIds"> | undefined,
  selectedOptionIds: readonly string[],
  mode: SearchPlanMode,
  searchOptions: readonly CatalogSearchStrategy[]
): SearchPlan {
  if (!model) return { mode: "all_selected", optionIds: [] };
  const concreteOptionIds = new Set(
    searchOptions
      .filter((option) => option.kind !== "none")
      .map((option) => option.strategyId)
  );
  const availableOptionIds = new Set(
    model.searchStrategyIds.filter((optionId) => concreteOptionIds.has(optionId))
  );
  const effectiveOptions = searchOptions.map((option) => ({
    ...option,
    executionModes:
      model.searchOptionCompatibility?.[option.strategyId]?.executionModes ??
      option.executionModes ??
      []
  }));
  return reconcileSearchPlanSelection(
    selectedOptionIds.filter((optionId) => availableOptionIds.has(optionId)),
    mode,
    effectiveOptions
  );
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

    if (resolveSearchRouteForModel(model, strategy)) strategyIds.add(strategy.strategyId);
  }

  return Array.from(strategyIds);
}

function hostedRouteCompatible(
  model: ProviderModelCatalogEntry,
  option: SearchStrategyCatalogEntry,
  route: SearchStrategyRouteCatalogEntry
): boolean {
  if (
    route.adapterKind !== "answer_provider_hosted" ||
    !option.sourceConnectionId ||
    option.sourceConnectionId !== model.provider ||
    !model.capabilities.nativeSearch
  ) {
    return false;
  }
  if (route.protocol === "gemini_google_search") {
    return option.kind === "gemini_google_search" &&
      model.adapterKind === "gemini_interactions_native";
  }
  if (route.protocol === "anthropic_web_search") {
    return option.kind === "web_search" &&
      model.adapterKind === "anthropic_messages";
  }
  return route.protocol === "openai_responses_web_search" &&
    option.kind === "web_search" &&
    (model.adapterKind === "openai_responses_native" ||
      model.adapterKind === "openai_responses_compatible");
}

function clientRouteCompatible(
  model: ProviderModelCatalogEntry,
  option: SearchStrategyCatalogEntry,
  route: SearchStrategyRouteCatalogEntry
): boolean {
  if (route.adapterKind !== "provider_model_client" || !model.capabilities.toolCalling) {
    return false;
  }
  if (option.kind === "gemini_google_search") {
    return route.protocol === "gemini_google_search";
  }
  if (option.kind === "web_search") {
    return route.protocol === "anthropic_web_search" ||
      route.protocol === "openai_responses_web_search";
  }
  return option.kind === "perplexity_tool_search" &&
    route.protocol === "openrouter_perplexity_chat" &&
    (route.providerModelId !== model.modelId || option.sourceConnectionId !== model.provider);
}

export function compatibleSearchRoutesForModel(
  model: ProviderModelCatalogEntry,
  option: SearchStrategyCatalogEntry
): SearchStrategyRouteCatalogEntry[] {
  if (option.kind === "none") return [];
  return option.routes.filter((route) =>
    hostedRouteCompatible(model, option, route) ||
    clientRouteCompatible(model, option, route)
  );
}

/** Chooses only within one logical destination. Same-connection hosted Search
 * is preferred; otherwise a tested client route may carry the generated query.
 * Callers persist this exact physical route before external I/O. */
export function resolveSearchRouteForModel(
  model: ProviderModelCatalogEntry,
  option: SearchStrategyCatalogEntry
): SearchStrategyRouteCatalogEntry | null {
  if (option.kind === "none") return null;
  return compatibleSearchRoutesForModel(model, option)[0] ?? null;
}

export function buildCatalogModel(
  model: ProviderModelCatalogEntry,
  entitledStrategies: SearchStrategyCatalogEntry[]
): CatalogModel {
  const searchStrategyIds = availableSearchStrategiesForModel(model, entitledStrategies);
  const searchOptionCompatibility = Object.fromEntries(entitledStrategies.flatMap((option) => {
    const routes = compatibleSearchRoutesForModel(model, option);
    return routes.length
      ? [[option.strategyId, {
          // This is deliberately only a coarse, privacy-safe capability bit:
          // Assistant validation needs to know that MCP can force Search onto
          // a client route, but must not expose the technical model or route.
          clientToolCompatible: routes.some(
            (route) => route.adapterKind === "provider_model_client"
          ),
          executionModes: [...new Set(routes.flatMap((route) => route.executionModes))]
        }]]
      : [];
  }));
  const openRouterPerplexitySearch = entitledStrategies.some((option) =>
    option.kind === "perplexity_tool_search" && searchStrategyIds.includes(option.strategyId));
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
        (model.adapterKind === "anthropic_messages" ||
          model.adapterKind === "openai_responses_native" ||
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
    searchOptionCompatibility,
    searchStrategyIds,
    upstreamModelId: model.upstreamModelId
  };
}

export function toCatalogSearchStrategy(strategy: SearchStrategyCatalogEntry): CatalogSearchStrategy {
  return {
    description: strategy.description,
    displayName: strategy.displayName,
    kind: strategy.kind,
    strategyId: strategy.strategyId
  };
}
