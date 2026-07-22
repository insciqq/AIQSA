import { defaultProviderModels, defaultSearchStrategies, fallbackParameterControls } from "@/lib/domain/catalog";
import type { ProviderModelCatalogEntry, SearchStrategyCatalogEntry } from "@/lib/domain/catalog";
import type { ResolvedEntitlements } from "@/lib/server/auth/entitlements";
import { loadEntitlementsForUser } from "@/lib/server/auth/dbEntitlements";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import type { CatalogData } from "@/lib/server/catalog/currentUserCatalog";
import { createProviderAdaptersFromEnv, createSearchProviderAdaptersFromEnv } from "@/lib/server/providers/registry";
import type { PrismaClient, ProviderModel, SearchStrategy } from "@prisma/client";

type CatalogPrismaClient = Pick<PrismaClient, "providerModel" | "searchStrategy" | "user">;

type PromptPresetRow = {
  developerPrompt: string | null;
  id: string;
  isDefault: boolean;
  name: string;
  systemPrompt: string;
};

type UserSettingsRow = {
  defaultControlValues: unknown;
  defaultModelId: string;
  defaultPromptPresetId: string | null;
  defaultProvider: string;
  defaultSearchStrategyId: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
};

type CatalogUserRow = {
  promptPresets: PromptPresetRow[];
  settings: UserSettingsRow | null;
};

export type CatalogDataLoaderDeps = {
  availableProviderIds?(): Iterable<string>;
  availableSearchProviderIds?(): Iterable<string>;
  env?: Record<string, string | undefined>;
  loadEntitlements?(userId: string): Promise<ResolvedEntitlements>;
  prisma: CatalogPrismaClient;
};

export function exposeFakeProvider(env: Record<string, string | undefined> = process.env): boolean {
  return isTestModeAllowedEnv(env);
}

export function providerModelToCatalogEntry(model: ProviderModel): ProviderModelCatalogEntry {
  const defaultEntry = defaultProviderModels.find(
    (entry) => entry.provider === model.provider && entry.modelId === model.modelId
  );
  const defaultParams = model.defaultParams as Record<string, unknown>;
  const capabilityOverrides =
    typeof model.capabilities === "object" && model.capabilities !== null && !Array.isArray(model.capabilities)
      ? (model.capabilities as Record<string, unknown>)
      : {};
  const fallbackCapabilities = {
    nativePdfInput:
      typeof capabilityOverrides.nativePdfInput === "boolean" ? capabilityOverrides.nativePdfInput : false,
    nativeSearch: model.supportsNativeSearch,
    pdf: model.supportsPdf,
    reasoning: model.supportsReasoning,
    streaming: typeof capabilityOverrides.streaming === "boolean" ? capabilityOverrides.streaming : false,
    vision: model.supportsVision
  };
  const capabilities = defaultEntry?.capabilities ?? fallbackCapabilities;

  return {
    capabilities,
    contextWindow: model.contextWindow,
    defaultParams,
    displayName: model.displayName,
    inputTokenPriceMicros: model.inputTokenPriceMicros,
    modelId: model.modelId,
    outputTokenPriceMicros: model.outputTokenPriceMicros,
    parameterControls:
      defaultEntry?.parameterControls ??
      fallbackParameterControls({
        defaultParams,
        provider: model.provider,
        supportsReasoning: capabilities.reasoning,
        supportsStreaming: capabilities.streaming
      }),
    provider: model.provider as ProviderModelCatalogEntry["provider"]
  };
}

export function searchStrategyToCatalogEntry(strategy: SearchStrategy): SearchStrategyCatalogEntry {
  const knownKinds = new Set<SearchStrategyCatalogEntry["kind"]>([
    "none",
    "openai_native_web_search",
    "perplexity_tool_search"
  ]);
  const storedKind = knownKinds.has(strategy.kind as SearchStrategyCatalogEntry["kind"])
    ? (strategy.kind as SearchStrategyCatalogEntry["kind"])
    : undefined;

  return {
    config: strategy.config as Record<string, unknown>,
    description: strategy.description,
    displayName: strategy.displayName,
    kind: defaultSearchStrategies.find((entry) => entry.strategyId === strategy.strategyId)?.kind ?? storedKind ?? "none",
    modelId: strategy.modelId ?? undefined,
    provider: strategy.provider as SearchStrategyCatalogEntry["provider"],
    strategyId: strategy.strategyId
  };
}

export function filterExposedProviderModels(input: {
  availableProviderIds: Iterable<string>;
  exposeFake: boolean;
  models: ProviderModel[];
}): ProviderModel[] {
  const availableProviders = new Set(input.availableProviderIds);

  return input.models.filter((model) => {
    if (model.provider === "fake") {
      return input.exposeFake;
    }

    return availableProviders.has(model.provider);
  });
}

export function filterExposedSearchStrategies(input: {
  availableProviderIds: Iterable<string>;
  availableSearchProviderIds: Iterable<string>;
  searchStrategies: SearchStrategy[];
}): SearchStrategy[] {
  const availableProviders = new Set(input.availableProviderIds);
  const availableSearchProviders = new Set(input.availableSearchProviderIds);
  const supportedStrategyIds = new Set([
    "search-disabled",
    "openai-native-web-search",
    "perplexity-tool-search"
  ]);

  return input.searchStrategies.filter((strategy) => {
    if (!supportedStrategyIds.has(strategy.strategyId)) {
      return false;
    }

    if (strategy.kind === "none" || strategy.strategyId === "search-disabled") {
      return true;
    }

    if (strategy.provider === "openrouter") {
      return availableSearchProviders.has("openrouter");
    }

    return availableProviders.has(strategy.provider);
  });
}

export function createPrismaCatalogDataLoader({
  availableProviderIds = () => Object.keys(createProviderAdaptersFromEnv()),
  availableSearchProviderIds = () => Object.keys(createSearchProviderAdaptersFromEnv()),
  env = process.env,
  loadEntitlements = loadEntitlementsForUser,
  prisma
}: CatalogDataLoaderDeps) {
  return async function loadCatalogData(userId: string): Promise<CatalogData | null> {
    const user = (await prisma.user.findUnique({
      include: {
        promptPresets: true,
        settings: true
      },
      where: {
        id: userId
      }
    })) as CatalogUserRow | null;

    if (!user?.settings) {
      return null;
    }

    const exposeFake = exposeFakeProvider(env);
    const [models, searchStrategies, entitlements] = await Promise.all([
      prisma.providerModel.findMany({
        where: {
          enabled: true,
          ...(exposeFake ? {} : { provider: { not: "fake" } })
        }
      }),
      prisma.searchStrategy.findMany({
        orderBy: {
          strategyId: "asc"
        },
        where: {
          enabled: true
        }
      }),
      loadEntitlements(userId)
    ]);

    const providerIds = Array.from(availableProviderIds());
    const exposedModels = filterExposedProviderModels({
      availableProviderIds: providerIds,
      exposeFake,
      models
    });
    const exposedSearchStrategies = filterExposedSearchStrategies({
      availableProviderIds: providerIds,
      availableSearchProviderIds: availableSearchProviderIds(),
      searchStrategies
    });

    return {
      entitlements,
      models: exposedModels.map(providerModelToCatalogEntry),
      promptPresets: user.promptPresets.map((preset) => ({
        developerPrompt: preset.developerPrompt,
        id: preset.id,
        isDefault: preset.isDefault,
        name: preset.name,
        systemPrompt: preset.systemPrompt
      })),
      searchStrategies: exposedSearchStrategies.map(searchStrategyToCatalogEntry),
      settings: {
        defaultControlValues: user.settings.defaultControlValues,
        defaultModelId: user.settings.defaultModelId,
        defaultPromptPresetId: user.settings.defaultPromptPresetId,
        defaultProvider: user.settings.defaultProvider,
        defaultSearchStrategyId: user.settings.defaultSearchStrategyId,
        showCitations: user.settings.showCitations,
        showReasoningBlocks: user.settings.showReasoningBlocks
      }
    };
  };
}
