import type {
  CurrentUserCatalogWire,
  CatalogWireModel,
  PromptPreset
} from "../../contracts/catalog";
import type { ProviderModelCatalogEntry, SearchStrategyCatalogEntry } from "../../domain/catalog";
import {
  buildCatalogModel,
  resolveSearchStrategyId,
  toCatalogSearchStrategy
} from "../../domain/catalogMatrix";
import {
  canAccessModel,
  canAccessSearchStrategy,
  type ResolvedEntitlements
} from "../auth/entitlements";

export type CatalogSettingsRecord = {
  defaultControlValues: unknown;
  defaultModelId: string;
  defaultPromptPresetId: string | null;
  defaultProvider: string;
  defaultSearchStrategyId: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
};

export type CatalogData = {
  entitlements: ResolvedEntitlements;
  models: ProviderModelCatalogEntry[];
  promptPresets: PromptPreset[];
  searchStrategies: SearchStrategyCatalogEntry[];
  settings: CatalogSettingsRecord;
};

export type CatalogSelectionData = Pick<
  CatalogData,
  "entitlements" | "models" | "searchStrategies" | "settings"
>;

export type CurrentUserCatalogSelection = {
  defaultModel: CatalogWireModel | null;
  entitledStrategies: SearchStrategyCatalogEntry[];
  models: CatalogWireModel[];
};

function providerName(provider: string): string {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    fake: "Fake",
    openai: "OpenAI",
    openrouter: "OpenRouter"
  };

  return names[provider] ?? provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveCurrentUserCatalogSelection(
  input: CatalogSelectionData
): CurrentUserCatalogSelection {
  const entitledStrategies = input.searchStrategies.filter((strategy) =>
    canAccessSearchStrategy(input.entitlements, strategy.strategyId)
  );
  const models = input.models
    .filter((model) => canAccessModel(input.entitlements, model.provider, model.modelId))
    .map((model) => buildCatalogModel(model, entitledStrategies));
  const defaultModel =
    models.find(
      (model) =>
        model.provider === input.settings.defaultProvider &&
        model.modelId === input.settings.defaultModelId
    ) ??
    models.find((model) => model.provider !== "fake") ??
    models[0] ??
    null;

  return {
    defaultModel,
    entitledStrategies,
    models
  };
}

export function buildCurrentUserCatalog(input: CatalogData): CurrentUserCatalogWire {
  const { defaultModel, entitledStrategies, models } = resolveCurrentUserCatalogSelection(input);
  const providers = Array.from(new Set(models.map((model) => model.provider))).map((provider) => ({
    id: provider,
    models: models.filter((model) => model.provider === provider).map((model) => model.modelId),
    name: providerName(provider)
  }));

  return {
    defaults: {
      controlValues: isRecord(input.settings.defaultControlValues)
        ? input.settings.defaultControlValues
        : {},
      modelId: defaultModel?.modelId ?? input.settings.defaultModelId,
      promptPresetId: input.settings.defaultPromptPresetId,
      provider: defaultModel?.provider ?? input.settings.defaultProvider,
      searchStrategyId: resolveSearchStrategyId(
        defaultModel,
        input.settings.defaultSearchStrategyId
      ),
      showCitations: input.settings.showCitations,
      showReasoningBlocks: input.settings.showReasoningBlocks,
      showToolActivity: input.settings.showToolActivity
    },
    models,
    promptPresets: input.promptPresets,
    providers,
    searchStrategies: entitledStrategies.map(toCatalogSearchStrategy)
  };
}
