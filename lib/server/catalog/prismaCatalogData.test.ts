import { describe, expect, it, vi } from "vitest";
import type { ProviderModel, SearchStrategy } from "@prisma/client";
import { buildCurrentUserCatalog } from "./handlers";
import {
  createPrismaCatalogDataLoader,
  exposeFakeProvider,
  filterExposedProviderModels,
  filterExposedSearchStrategies,
  providerModelToCatalogEntry
} from "./prismaCatalogData";

const now = new Date("2026-06-11T00:00:00.000Z");

function providerModel(overrides: Partial<ProviderModel>): ProviderModel {
  return {
    capabilities: {},
    contextWindow: 8192,
    createdAt: now,
    defaultParams: {},
    displayName: "Model",
    enabled: true,
    id: "model-row",
    inputTokenPriceMicros: 0,
    modelId: "model",
    outputTokenPriceMicros: 0,
    provider: "openai",
    supportsNativeSearch: false,
    supportsPdf: false,
    supportsReasoning: false,
    supportsVision: false,
    updatedAt: now,
    ...overrides
  };
}

function searchStrategy(overrides: Partial<SearchStrategy>): SearchStrategy {
  return {
    config: {},
    createdAt: now,
    description: "Search",
    displayName: "Search",
    enabled: true,
    id: "search-row",
    kind: "none",
    modelId: null,
    provider: "openai",
    strategyId: "search-disabled",
    updatedAt: now,
    ...overrides
  };
}

describe("prisma catalog data loader", () => {
  it("exposes the fake provider only in explicit test/debug modes", () => {
    expect(exposeFakeProvider({})).toBe(false);
    expect(
      exposeFakeProvider({
        APP_ENV: "local",
        PLAYWRIGHT_TEST_AUTH: "1"
      })
    ).toBe(true);
    expect(exposeFakeProvider({ NODE_ENV: "test" })).toBe(false);
    expect(exposeFakeProvider({ APP_ENV: "production", PLAYWRIGHT_TEST_AUTH: "1" })).toBe(false);
    expect(exposeFakeProvider({ AIQSA_FAKE_PROVIDER: "1" })).toBe(true);
    expect(exposeFakeProvider({ AIQSA_SHOW_FAKE_PROVIDER: "1" })).toBe(true);
  });

  it("filters models by adapter availability and fake-provider exposure", () => {
    const models = [
      providerModel({ modelId: "fake-qsa", provider: "fake" }),
      providerModel({ modelId: "gpt-5.5", provider: "openai" }),
      providerModel({ modelId: "claude-opus-4-8", provider: "anthropic" })
    ];

    expect(
      filterExposedProviderModels({
        availableProviderIds: ["openai"],
        exposeFake: false,
        models
      }).map((model) => model.provider)
    ).toEqual(["openai"]);

    expect(
      filterExposedProviderModels({
        availableProviderIds: ["openai"],
        exposeFake: true,
        models
      }).map((model) => model.provider)
    ).toEqual(["fake", "openai"]);
  });

  it("hides unsupported search strategy rows from new catalogs", () => {
    const strategies = filterExposedSearchStrategies({
      availableProviderIds: ["openrouter"],
      availableSearchProviderIds: ["openrouter"],
      searchStrategies: [
        searchStrategy({
          kind: "unsupported_kind",
          provider: "openrouter",
          strategyId: "unsupported-search"
        }),
        searchStrategy({
          kind: "perplexity_tool_search",
          provider: "openrouter",
          strategyId: "perplexity-tool-search"
        })
      ]
    });

    expect(strategies.map((strategy) => strategy.strategyId)).toEqual(["perplexity-tool-search"]);
  });

  it("synthesizes fallback controls for non-default provider-model rows", () => {
    const entry = providerModelToCatalogEntry(
      providerModel({
        defaultParams: {
          maxOutputTokens: 2048,
          reasoning: {
            effort: "high"
          },
          stream: false,
          temperature: 0.4
        },
        capabilities: {
          streaming: true
        },
        modelId: "custom/model",
        provider: "openrouter",
        supportsPdf: true,
        supportsReasoning: true,
        supportsVision: true
      })
    );

    expect(entry.capabilities).toEqual({
      nativePdfInput: false,
      nativeSearch: false,
      pdf: true,
      reasoning: true,
      streaming: true,
      vision: true
    });
    expect(entry.parameterControls).toMatchObject({
      background: {
        defaultValue: false,
        supported: false
      },
      maxOutputTokens: {
        defaultValue: 2048,
        maxValue: 2048
      },
      reasoningEffort: {
        defaultValue: "high",
        options: ["none", "low", "medium", "high"],
        supported: true
      },
      stream: {
        defaultValue: false,
        supported: true
      },
      temperature: {
        defaultValue: 0.4,
        supported: true
      }
    });
  });

  it("honors explicit native PDF capability overrides on non-default provider-model rows", () => {
    const entry = providerModelToCatalogEntry(
      providerModel({
        capabilities: {
          nativePdfInput: true
        },
        modelId: "custom/native-pdf",
        provider: "openrouter",
        supportsPdf: true
      })
    );

    expect(entry.capabilities.nativePdfInput).toBe(true);
    expect(entry.capabilities.pdf).toBe(true);
  });

  it("stops before catalog queries when the user or settings are missing", async () => {
    const loadEntitlements = vi.fn();
    const prisma = {
      providerModel: {
        findMany: vi.fn()
      },
      searchStrategy: {
        findMany: vi.fn()
      },
      user: {
        findUnique: vi.fn(async () => null)
      }
    };
    const loader = createPrismaCatalogDataLoader({
      loadEntitlements,
      prisma: prisma as never
    });

    await expect(loader("missing-user")).resolves.toBeNull();
    expect(prisma.providerModel.findMany).not.toHaveBeenCalled();
    expect(prisma.searchStrategy.findMany).not.toHaveBeenCalled();
    expect(loadEntitlements).not.toHaveBeenCalled();
  });

  it("loads prompt/settings data and lets handler shaping keep entitled defaults", async () => {
    const availableProviderIds = vi.fn(() =>
      (function* providerIds() {
        yield "openai";
      })()
    );
    const prisma = {
      providerModel: {
        findMany: vi.fn(async () => [
          providerModel({ modelId: "fake-qsa", provider: "fake" }),
          providerModel({
            modelId: "gpt-5.5",
            provider: "openai",
            supportsNativeSearch: true,
            supportsReasoning: true
          })
        ])
      },
      searchStrategy: {
        findMany: vi.fn(async () => [
          searchStrategy({ strategyId: "search-disabled" }),
          searchStrategy({
            kind: "openai_native_web_search",
            strategyId: "openai-native-web-search"
          })
        ])
      },
      user: {
        findUnique: vi.fn(async () => ({
          promptPresets: [
            {
              developerPrompt: null,
              id: "prompt-1",
              isDefault: true,
              name: "Helpful",
              systemPrompt: "System"
            }
          ],
          settings: {
            defaultControlValues: {
              "openai:gpt-5.5": {
                temperature: 0.7
              }
            },
            defaultModelId: "gpt-5.5",
            defaultPromptPresetId: "prompt-1",
            defaultProvider: "openai",
            defaultSearchStrategyId: "openai-native-web-search",
            showCitations: false,
            showReasoningBlocks: true
          }
        }))
      }
    };
    const loader = createPrismaCatalogDataLoader({
      availableProviderIds,
      availableSearchProviderIds: () => [],
      env: {},
      loadEntitlements: async () => ({
        modelKeys: new Set(["openai:gpt-5.5"]),
        providerKeys: new Set(),
        searchStrategies: new Set(["openai-native-web-search"])
      }),
      prisma: prisma as never
    });

    const data = await loader("user-1");
    expect(availableProviderIds).toHaveBeenCalledTimes(1);
    expect(data?.models.map((model) => `${model.provider}:${model.modelId}`)).toEqual(["openai:gpt-5.5"]);
    expect(data?.promptPresets).toEqual([
      {
        developerPrompt: null,
        id: "prompt-1",
        isDefault: true,
        name: "Helpful",
        systemPrompt: "System"
      }
    ]);

    const catalog = buildCurrentUserCatalog(data!);
    expect(catalog.defaults).toMatchObject({
      modelId: "gpt-5.5",
      promptPresetId: "prompt-1",
      provider: "openai",
      searchStrategyId: "openai-native-web-search",
      showCitations: false,
      showReasoningBlocks: true
    });
    expect(catalog.models).toHaveLength(1);
    expect(catalog.searchStrategies.map((strategy) => strategy.strategyId)).toEqual([
      "search-disabled",
      "openai-native-web-search"
    ]);
  });
});
