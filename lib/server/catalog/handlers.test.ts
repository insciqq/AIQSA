import { describe, expect, it } from "vitest";
import { decodeCatalogResponse, type CatalogResponse } from "../../contracts/catalog";
import { defaultProviderModels, defaultSearchStrategies } from "../../domain/catalog";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import { buildCurrentUserCatalog, createCatalogHandler } from "./handlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

describe("catalog handler", () => {
  it("filters models and search strategies by the current user's entitlements", async () => {
    const GET = createCatalogHandler({
      loadCatalogData: async () => ({
        entitlements: {
          modelKeys: new Set(["openai:gpt-5.5"]),
          providerKeys: new Set(),
          searchStrategies: new Set(["openai-native-web-search"])
        },
        models: defaultProviderModels,
        promptPresets: [
          {
            developerPrompt: null,
            id: "prompt-1",
            isDefault: true,
            name: "Helpful Assistant",
            systemPrompt: "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}."
          }
        ],
        runProfiles: [{
          description: "Simple, well-defined questions",
          enabled: true,
          id: "fast",
          providerModelId: "gpt-5.5",
          reasoningEffort: "medium",
          reasoningMode: "standard"
        }],
        searchStrategies: defaultSearchStrategies,
        settings: {
          defaultControlValues: {},
          defaultModelId: "gpt-5.5",
          defaultProviderConnectionId: "openai",
          defaultProviderModelId: "gpt-5.5",
          defaultPromptPresetId: "prompt-1",
          defaultProvider: "openai",
          defaultSearchStrategyId: "openai-native-web-search",
          showCitations: true,
          showReasoningBlocks: false,
          showToolActivity: true,
        }
      }),
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/me/catalog", {
        headers: {
          cookie: auth.cookie
        }
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as CatalogResponse;
    const catalog = decodeCatalogResponse(body);

    expect(catalog).not.toBeNull();
    expect(Object.keys(body.catalog)).toEqual([
      "defaults",
      "models",
      "promptPresets",
      "providers",
      "runProfiles",
      "searchStrategies"
    ]);
    expect(Object.keys(body.catalog.defaults)).toEqual([
      "controlValues",
      "modelId",
      "promptPresetId",
      "provider",
      "searchStrategyId",
      "organizationSearchPlan",
      "searchPlan",
      "searchPreferenceSource",
      "showCitations",
      "showReasoningBlocks",
      "showToolActivity"
    ]);
    expect(Object.keys(body.catalog.models[0])).toEqual([
      "capabilities",
      "contextWindow",
      "defaultParams",
      "displayName",
      "modelId",
      "parameterControls",
      "provider",
      "providerFamily",
      "searchStrategyIds",
      "upstreamModelId"
    ]);
    expect(body.catalog.models[0].capabilities.text).toBe(true);
    expect(body.catalog.searchStrategies[0]).toEqual({
      displayName: "No Search",
      kind: "none",
      strategyId: "search-disabled"
    });
    expect(catalog?.models.map((model) => model.modelId)).toEqual(["gpt-5.5"]);
    expect(catalog?.searchStrategies.map((strategy) => strategy.strategyId)).toEqual([
      "search-disabled",
      "openai-native-web-search"
    ]);
    expect(catalog?.models[0].searchStrategyIds).toEqual([
      "search-disabled",
      "openai-native-web-search"
    ]);
    expect(catalog?.runProfiles).toEqual([expect.objectContaining({
      available: true,
      id: "fast",
      modelId: "gpt-5.5",
      provider: "openai"
    })]);
  });

  it("projects every supplied current and future catalog item for full access", () => {
    const catalog = buildCurrentUserCatalog({
      entitlements: {
        fullAccess: true,
        modelKeys: new Set(),
        providerKeys: new Set(),
        searchStrategies: new Set()
      },
      models: defaultProviderModels,
      promptPresets: [],
      runProfiles: [],
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultModelId: "gpt-5.5",
        defaultProviderConnectionId: "openai",
        defaultProviderModelId: "gpt-5.5",
        defaultPromptPresetId: null,
        defaultProvider: "openai",
        defaultSearchStrategyId: "openai-native-web-search",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true
      }
    });

    expect(catalog.models).toHaveLength(defaultProviderModels.length);
    expect(catalog.searchStrategies).toHaveLength(defaultSearchStrategies.length);
    expect(catalog.providers.map((provider) => provider.id)).toEqual(
      [...new Set(defaultProviderModels.map((model) => model.provider))]
    );
  });

  it("exposes entitled OpenRouter Gemini models with model-specific controls", async () => {
    const GET = createCatalogHandler({
      loadCatalogData: async () => ({
        entitlements: {
          modelKeys: new Set(["openrouter:google/gemini-3.5-flash", "openrouter:~google/gemini-pro-latest"]),
          providerKeys: new Set(),
          searchStrategies: new Set(["perplexity-tool-search"])
        },
        models: defaultProviderModels,
        promptPresets: [],
        runProfiles: [],
        searchStrategies: defaultSearchStrategies,
        settings: {
          defaultControlValues: {},
          defaultModelId: "gpt-5.5",
          defaultProviderConnectionId: "openai",
          defaultProviderModelId: "gpt-5.5",
          defaultPromptPresetId: null,
          defaultProvider: "openai",
          defaultSearchStrategyId: "openai-native-web-search",
          showCitations: true,
          showReasoningBlocks: false,
          showToolActivity: true,
        }
      }),
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/me/catalog", {
        headers: {
          cookie: auth.cookie
        }
      })
    );

    expect(response.status).toBe(200);
    const catalog = decodeCatalogResponse(await response.json());

    expect(catalog).not.toBeNull();
    expect(catalog?.defaults.searchStrategyId).toBe("search-disabled");
    expect(catalog?.models.map((model) => model.modelId)).toEqual([
      "google/gemini-3.5-flash",
      "~google/gemini-pro-latest"
    ]);
    expect(catalog?.models[0].searchStrategyIds).toContain("perplexity-tool-search");
    expect(catalog?.models[0]).toMatchObject({
      capabilities: {
        background: false
      },
      parameterControls: {
        reasoningEffort: {
          defaultValue: "medium",
          options: ["none", "minimal", "low", "medium", "high"]
        },
        temperature: {
          defaultValue: 1,
          supported: true
        }
      }
    });
  });

  it("does not expose or replace a filtered stable default", () => {
    const catalog = buildCurrentUserCatalog({
      entitlements: {
        modelKeys: new Set(["openrouter:google/gemini-3.5-flash"]),
        providerKeys: new Set(),
        searchStrategies: new Set()
      },
      models: defaultProviderModels.filter((model) => model.provider === "openrouter"),
      promptPresets: [],
      runProfiles: [],
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultModelId: "claude-opus-4-8",
        defaultProviderConnectionId: "anthropic",
        defaultProviderModelId: "claude-opus-4-8",
        defaultPromptPresetId: null,
        defaultProvider: "anthropic",
        defaultSearchStrategyId: "openai-native-web-search",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      }
    });

    expect(catalog.defaults).toMatchObject({
      modelId: "",
      provider: "",
      searchStrategyId: "search-disabled"
    });
  });

  it("returns no models or providers when the user has no model entitlements", () => {
    const catalog = buildCurrentUserCatalog({
      entitlements: {
        modelKeys: new Set(),
        providerKeys: new Set(),
        searchStrategies: new Set()
      },
      models: defaultProviderModels,
      promptPresets: [],
      runProfiles: [{
        description: "Simple questions",
        enabled: true,
        id: "fast",
        providerModelId: "gpt-5.5",
        reasoningEffort: "medium",
        reasoningMode: "standard"
      }],
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultModelId: "gpt-5.5",
        defaultProviderConnectionId: null,
        defaultProviderModelId: null,
        defaultPromptPresetId: null,
        defaultProvider: "openai",
        defaultSearchStrategyId: "openai-native-web-search",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      }
    });

    expect(catalog.models).toEqual([]);
    expect(catalog.providers).toEqual([]);
    expect(catalog.searchStrategies.map((strategy) => strategy.strategyId)).toEqual(["search-disabled"]);
    expect(catalog.runProfiles).toEqual([{
      available: false,
      description: "Simple questions",
      id: "fast",
      label: "Fast",
      unavailableReason: "model_unavailable"
    }]);
    expect(JSON.stringify(catalog.runProfiles)).not.toContain("gpt-5.5");
    expect(JSON.stringify(catalog.runProfiles)).not.toContain("openai");
  });

  it("resolves inherited, personal Off, and entitlement-filtered Search preferences without model clamping", () => {
    const base = {
      entitlements: {
        fullAccess: true as const,
        modelKeys: new Set<string>(),
        providerKeys: new Set<string>(),
        searchStrategies: new Set<string>()
      },
      models: defaultProviderModels,
      promptPresets: [],
      runProfiles: [],
      searchPolicy: {
        defaultPlan: {
          mode: "model_choice",
          optionIds: ["openai-native-web-search", "perplexity-tool-search"]
        }
      },
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultModelId: "fake-qsa",
        defaultProviderConnectionId: "fake",
        defaultProviderModelId: "fake-qsa",
        defaultPromptPresetId: null,
        defaultProvider: "fake",
        defaultSearchPlan: null,
        defaultSearchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true
      }
    };
    const inherited = buildCurrentUserCatalog(base);
    expect(inherited.defaults).toMatchObject({
      searchPlan: {
        mode: "model_choice",
        optionIds: ["openai-native-web-search", "perplexity-tool-search"]
      },
      searchPreferenceSource: "organization"
    });
    expect(inherited.models.find((model) => model.modelId === "fake-qsa")?.searchStrategyIds)
      .toEqual(["search-disabled"]);

    const personalOff = buildCurrentUserCatalog({
      ...base,
      settings: {
        ...base.settings,
        defaultSearchPlan: { mode: "all_selected", optionIds: [] }
      }
    });
    expect(personalOff.defaults).toMatchObject({
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferenceSource: "personal"
    });

    const restricted = buildCurrentUserCatalog({
      ...base,
      entitlements: {
        modelKeys: new Set(["openai:gpt-5.5"]),
        providerKeys: new Set<string>(),
        searchStrategies: new Set(["openai-native-web-search"])
      },
      settings: {
        ...base.settings,
        defaultModelId: "gpt-5.5",
        defaultProviderConnectionId: "openai",
        defaultProviderModelId: "gpt-5.5",
        defaultProvider: "openai"
      }
    });
    expect(restricted.defaults.searchPlan).toEqual({
      mode: "model_choice",
      optionIds: ["openai-native-web-search"]
    });
    expect(restricted.searchStrategies.map((strategy) => strategy.strategyId))
      .not.toContain("perplexity-tool-search");
  });

  it("rejects anonymous catalog requests", async () => {
    const GET = createCatalogHandler({
      loadCatalogData: async () => null,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(new Request("http://app.local/api/me/catalog"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("reports an authenticated user whose catalog data is missing", async () => {
    const GET = createCatalogHandler({
      loadCatalogData: async () => null,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/me/catalog", {
        headers: {
          cookie: auth.cookie
        }
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "user_not_found" });
  });
});
