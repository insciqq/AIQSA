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
        searchStrategies: defaultSearchStrategies,
        settings: {
          defaultControlValues: {},
          defaultModelId: "gpt-5.5",
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
      "searchStrategies"
    ]);
    expect(Object.keys(body.catalog.defaults)).toEqual([
      "controlValues",
      "modelId",
      "promptPresetId",
      "provider",
      "searchStrategyId",
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
      "searchStrategyIds"
    ]);
    expect(body.catalog.models[0].capabilities.text).toBe(true);
    expect(body.catalog.searchStrategies[0]).toMatchObject({
      config: {},
      description: expect.any(String),
      provider: "fake"
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
        searchStrategies: defaultSearchStrategies,
        settings: {
          defaultControlValues: {},
          defaultModelId: "gpt-5.5",
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

  it("falls back catalog defaults when stored settings point at a filtered model", () => {
    const catalog = buildCurrentUserCatalog({
      entitlements: {
        modelKeys: new Set(["openrouter:google/gemini-3.5-flash"]),
        providerKeys: new Set(),
        searchStrategies: new Set()
      },
      models: defaultProviderModels.filter((model) => model.provider === "openrouter"),
      promptPresets: [],
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultModelId: "claude-opus-4-8",
        defaultPromptPresetId: null,
        defaultProvider: "anthropic",
        defaultSearchStrategyId: "openai-native-web-search",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      }
    });

    expect(catalog.defaults).toMatchObject({
      modelId: "google/gemini-3.5-flash",
      provider: "openrouter",
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
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultModelId: "gpt-5.5",
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
