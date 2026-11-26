import { describe, expect, it, vi } from "vitest";
import { decodeCatalogResponse, type CatalogResponse } from "../../contracts/catalog";
import { defaultProviderModels, defaultSearchStrategies, type SearchStrategyCatalogEntry } from "../../domain/catalog";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
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
  it.each([undefined, true, false])("defaults Workspace on while preserving an explicit preference: %s", (preference) => {
    const catalog = buildCurrentUserCatalog({
      entitlements: { modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
      models: defaultProviderModels,
      searchStrategies: [],
      settings: {
        defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null,
        defaultWorkspaceEnabled: preference, showCitations: true, showReasoningBlocks: false
      }
    });
    expect(catalog.defaults.workspaceEnabled).toBe(preference !== false);
  });

  it.each([
    [undefined, undefined, { assistantId: null, assistantUnavailable: false }],
    ["assistant-1", true, { assistantId: "assistant-1", assistantUnavailable: false }],
    ["assistant-1", false, { assistantId: null, assistantUnavailable: true }],
    ["assistant-1", undefined, { assistantId: null, assistantUnavailable: true }]
  ] as const)("names the default Assistant %s only while it is available (%s)", (assistantId, available, expected) => {
    const catalog = buildCurrentUserCatalog({
      entitlements: { modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
      models: defaultProviderModels,
      searchStrategies: [],
      settings: {
        defaultAssistantAvailable: available, defaultAssistantId: assistantId,
        defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null,
        showCitations: true, showReasoningBlocks: false
      }
    });
    expect(catalog.defaults).toMatchObject(expected);
  });

  it.each([
    { effort: "high", personalModel: null, personal: {}, allowed: true, expected: "high" },
    { effort: "high", personalModel: null, personal: { temperature: "0.5" }, allowed: true, expected: "high" },
    { effort: "high", personalModel: null, personal: { reasoningEffort: "low" }, allowed: true, expected: "low" },
    { effort: "unsupported", personalModel: null, personal: {}, allowed: true, expected: undefined },
    { effort: null, personalModel: null, personal: {}, allowed: true, expected: undefined },
    { effort: "high", personalModel: "gpt-5.5", personal: {}, allowed: true, expected: undefined },
    { effort: "high", personalModel: "unavailable", personal: {}, allowed: true, expected: undefined },
    { effort: "high", personalModel: null, personal: {}, allowed: false, expected: undefined }
  ])("resolves installation reasoning with personal and entitlement precedence: %j", ({
    effort, personalModel, personal, allowed, expected
  }) => {
    const key = "openai:gpt-5.5";
    const catalog = buildCurrentUserCatalog({
      entitlements: { modelKeys: new Set(allowed ? [key] : []), providerKeys: new Set(), searchStrategies: new Set() },
      modelPolicy: { defaultProviderModelId: "gpt-5.5", reasoningEffort: effort },
      models: defaultProviderModels,
      searchStrategies: [],
      settings: {
        defaultControlValues: { [key]: personal },
        defaultProviderModelId: personalModel,
        defaultSearchPlan: null,
        showCitations: true,
        showReasoningBlocks: false
      }
    });
    expect(catalog.defaults.controlValues[key]).toEqual({
      ...(expected ? { reasoningEffort: expected } : {}), ...personal
    });
  });

  it("filters models and search strategies by the current user's entitlements", async () => {
    const GET = createCatalogHandler({
      loadCatalogData: async () => ({
        entitlements: {
          modelKeys: new Set(["openai:gpt-5.5"]),
          providerKeys: new Set(),
          searchStrategies: new Set(["openai-native-web-search"])
        },
        models: defaultProviderModels,
        searchStrategies: defaultSearchStrategies,
        settings: {
          defaultControlValues: {},
          defaultProviderModelId: "gpt-5.5",
          defaultSearchPlan: {
            mode: "all_selected",
            optionIds: ["openai-native-web-search"]
          },
          showCitations: true,
          showReasoningBlocks: false,
        }
      }),
      resolveAuth: auth.resolveAuth,
      resolveRunAttachmentLimits: () => ({
        maxCount: 7,
        maxEncodedBytes: 11_000,
        maxMaterializedBytes: 9_000,
        readConcurrency: 3
      })
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
      "providers",
      "search",
      "searchStrategies",
      "attachmentLimits"
    ]);
    expect(body.catalog.attachmentLimits).toEqual({
      maxCount: 7,
      maxEncodedBytes: 11_000,
      maxMaterializedBytes: 9_000
    });
    expect(body.catalog.attachmentLimits).not.toHaveProperty("readConcurrency");
    expect(catalog?.attachmentLimits).toEqual(body.catalog.attachmentLimits);
    expect(Object.keys(body.catalog.defaults)).toEqual([
      "answerSoundEnabled",
      "answerSoundId",
      "browserNotificationsEnabled",
      "controlValues",
      "modelId",
      "hasPersonalModelDefault",
      "modelPreferenceSource",
      "organizationModelDefault",
      "personalModelDefault",
      "provider",
      "organizationSearchPlan",
      "searchPlan",
      "searchEnabled",
      "searchPreferenceSource",
      "mcpMode",
      "skillsMode",
      "sendWithEnter",
      "assistantId",
      "assistantUnavailable",
      "workspaceEnabled",
      "showCitations",
      "showReasoningBlocks",
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
      "searchOptionCompatibility",
      "searchStrategyIds",
      "upstreamModelId",
      "webSearch"
    ]);
    expect(body.catalog.models[0].capabilities.text).toBe(true);
    // Users switch Search on or off: one virtual source while a model can search, whichever engine runs.
    expect(body.catalog.searchStrategies).toEqual([{
      description: "Searches the web with the engine your administrator set up.",
      displayName: "Web search",
      kind: "web_search",
      strategyId: "web-search"
    }]);
    expect(catalog?.models.map((model) => model.modelId)).toEqual(["gpt-5.5"]);
    // GPT searches inside its own answer; no engine reaches other models (Sonar is never a default).
    expect(catalog?.models[0]).toMatchObject({
      searchOptionCompatibility: { "web-search": { clientToolCompatible: true, executionModes: ["all_selected", "model_choice"] } },
      searchStrategyIds: ["web-search"],
      webSearch: "in_answer"
    });
    expect(catalog?.search).toEqual({ engine: null, reason: "search_engine_not_configured" });
    expect(catalog?.defaults).toMatchObject({
      searchEnabled: true, searchPlan: { mode: "all_selected", optionIds: ["web-search"] }
    });
  });

  it("projects dictation availability, and a failed read as unavailable rather than absent", async () => {
    const handler = (resolveDictation: () => Promise<{ available: boolean; unavailableReason: "not_configured" | "unavailable" | null }>) =>
      createCatalogHandler({
        loadCatalogData: async () => ({
          entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
          models: defaultProviderModels,
          searchStrategies: [],
          settings: { defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null, showCitations: true, showReasoningBlocks: false }
        }),
        resolveAuth: auth.resolveAuth,
        resolveDictation
      });
    const read = async (GET: ReturnType<typeof createCatalogHandler>) => decodeCatalogResponse(await (await GET(
      new Request("http://app.local/api/me/catalog", { headers: { cookie: auth.cookie } }))).json());
    expect((await read(handler(async () => ({ available: true, unavailableReason: null }))))?.dictation)
      .toEqual({ available: true, unavailableReason: null });
    expect((await read(handler(async () => { throw new Error("db"); })))?.dictation)
      .toEqual({ available: false, unavailableReason: "unavailable" });
  });

  it.each([
    { systemVision: true, imageEditing: false },
    { systemVision: false, imageEditing: true },
    { systemVision: false, imageEditing: false }
  ])("projects image routes on tool-calling models from one admission rule: %j", async (facts) => {
    const resolveImageRoutes = vi.fn(async () => facts);
    const GET = createCatalogHandler({
      loadCatalogData: async () => ({
        entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
        models: defaultProviderModels,
        searchStrategies: [],
        settings: { defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null, showCitations: true, showReasoningBlocks: false }
      }),
      resolveAuth: auth.resolveAuth,
      resolveImageRoutes
    });
    const catalog = decodeCatalogResponse(await (await GET(new Request("http://app.local/api/me/catalog", {
      headers: { cookie: auth.cookie } }))).json());
    expect(resolveImageRoutes).toHaveBeenCalledExactlyOnceWith(config.bootstrapUserId);
    const models = catalog?.models ?? [];
    expect(models.some((model) => model.capabilities.toolCalling && !model.capabilities.imageInput)).toBe(true);
    for (const model of models) {
      expect(model.capabilities.imageRoutes).toEqual(model.capabilities.toolCalling
        // System Vision answers only for a model without its own image input.
        ? { systemVision: facts.systemVision && !model.capabilities.imageInput, imageEditing: facts.imageEditing }
        : undefined);
    }
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
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultProviderModelId: "gpt-5.5",
        defaultSearchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        showCitations: true,
        showReasoningBlocks: false,
      }
    });

    expect(catalog.models).toHaveLength(defaultProviderModels.length);
    expect(catalog.searchStrategies.map((strategy) => strategy.strategyId)).toEqual(["web-search"]);
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
        searchStrategies: defaultSearchStrategies,
        settings: {
          defaultControlValues: {},
          defaultProviderModelId: "gpt-5.5",
          defaultSearchPlan: {
            mode: "all_selected",
            optionIds: ["openai-native-web-search"]
          },
          showCitations: true,
          showReasoningBlocks: false,
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
    // The user's own choice of sources reads as Search on.
    expect(catalog?.defaults.searchPlan).toEqual({ mode: "all_selected", optionIds: ["web-search"] });
    expect(catalog?.models.map((model) => model.modelId)).toEqual([
      "google/gemini-3.5-flash",
      "~google/gemini-pro-latest"
    ]);
    // Perplexity Sonar may be chosen but is never the default engine, so these models cannot search, visibly.
    expect(catalog?.models[0]).toMatchObject({ searchStrategyIds: [], webSearch: null });
    expect(catalog?.search).toEqual({ engine: null, reason: "search_engine_not_configured" });
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
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultProviderModelId: "claude-opus-4-8",
        defaultSearchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        showCitations: true,
        showReasoningBlocks: false,
      }
    });

    expect(catalog.defaults).toMatchObject({
      hasPersonalModelDefault: true,
      modelId: "",
      modelPreferenceSource: "personal",
      organizationModelDefault: null,
      personalModelDefault: null,
      provider: "",
      // Search stays on: the user's switch is never filtered by what the catalog offers.
      searchEnabled: true,
      searchPlan: { mode: "all_selected", optionIds: ["web-search"] }
    });
  });

  it("inherits only an entitled organization model and never falls through an unavailable personal choice", () => {
    const base = {
      entitlements: {
        modelKeys: new Set(["openai:gpt-5.5"]),
        providerKeys: new Set<string>(),
        searchStrategies: new Set<string>()
      },
      modelPolicy: { defaultProviderModelId: "gpt-5.5" },
      models: defaultProviderModels,
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultProviderModelId: null,
        defaultSearchPlan: { mode: "all_selected", optionIds: [] },
        showCitations: true,
        showReasoningBlocks: false,
      }
    };
    const inherited = buildCurrentUserCatalog(base);
    expect(inherited.defaults).toMatchObject({
      hasPersonalModelDefault: false,
      modelId: "gpt-5.5",
      modelPreferenceSource: "organization",
      organizationModelDefault: { modelId: "gpt-5.5", provider: "openai" },
      personalModelDefault: null,
      provider: "openai"
    });

    const unavailablePersonal = buildCurrentUserCatalog({
      ...base,
      settings: {
        ...base.settings,
        defaultProviderModelId: "claude-opus-4-8"
      }
    });
    expect(unavailablePersonal.defaults).toMatchObject({
      hasPersonalModelDefault: true,
      modelId: "",
      modelPreferenceSource: "personal",
      organizationModelDefault: { modelId: "gpt-5.5", provider: "openai" },
      personalModelDefault: null,
      provider: ""
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
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultProviderModelId: null,
        defaultSearchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        showCitations: true,
        showReasoningBlocks: false,
      }
    });

    expect(catalog.models).toEqual([]);
    expect(catalog.providers).toEqual([]);
    expect(catalog.searchStrategies).toEqual([]);
    expect(catalog.search).toEqual({ engine: null, reason: "search_not_granted" });
  });

  it("reads Search on from no personal plan or one naming sources, and keeps a personal Off", () => {
    const base = {
      entitlements: {
        fullAccess: true as const,
        modelKeys: new Set<string>(),
        providerKeys: new Set<string>(),
        searchStrategies: new Set<string>()
      },
      models: defaultProviderModels,
      searchStrategies: defaultSearchStrategies,
      settings: {
        defaultControlValues: {},
        defaultProviderModelId: "fake-qsa",
        defaultSearchPlan: null,
        showCitations: true,
        showReasoningBlocks: false,
      }
    };
    const on = { mode: "all_selected", optionIds: ["web-search"] };
    expect(buildCurrentUserCatalog(base).defaults).toMatchObject({
      organizationSearchPlan: on, searchEnabled: true, searchPlan: on, searchPreferenceSource: "organization"
    });
    // An earlier release's personal choice of sources is Search on, whichever sources it named.
    expect(buildCurrentUserCatalog({ ...base, settings: { ...base.settings,
      defaultSearchPlan: { mode: "model_choice", optionIds: ["openai-native-web-search", "perplexity-tool-search"] } } }).defaults)
      .toMatchObject({ searchEnabled: true, searchPlan: on, searchPreferenceSource: "personal" });
    expect(buildCurrentUserCatalog({ ...base, settings: { ...base.settings,
      defaultSearchPlan: { mode: "all_selected", optionIds: [] } } }).defaults).toMatchObject({
      organizationSearchPlan: on,
      searchEnabled: false,
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferenceSource: "personal"
    });
  });

  it("names the installation's engine while it serves the user, and the reason otherwise", () => {
    const deepSeek: SearchStrategyCatalogEntry = {
      description: "Raw results.", displayName: "DeepSeek Search API", kind: "web_search",
      routes: [{ adapterKind: "provider_model_client", config: {}, credentialMode: "provider_model",
        executionModes: ["all_selected", "model_choice"], kind: "provider_model_web_search", physicalStrategyId: "deepseek-api",
        protocol: "deepseek_search_api", providerModelId: "deepseek-flash", revisionId: "revision-deepseek",
        searchStrategyRowId: "deepseek-api" }],
      sourceConnectionId: "deepseek", strategyId: "deepseek-search-api"
    };
    const base = {
      entitlements: { fullAccess: true as const, modelKeys: new Set<string>(), providerKeys: new Set<string>(),
        searchStrategies: new Set<string>() },
      models: defaultProviderModels,
      searchStrategies: [...defaultSearchStrategies, deepSeek],
      settings: { defaultControlValues: {}, defaultProviderModelId: "fake-qsa", defaultSearchPlan: null,
        showCitations: true, showReasoningBlocks: false }
    };
    const catalog = buildCurrentUserCatalog(base);
    expect(catalog.search).toEqual({ engine: { displayName: "DeepSeek Search API" }, reason: null });
    // Every tool-calling model searches with the engine; GPT on its OpenAI connection searches in its own answer.
    expect(catalog.models.find((model) => model.modelId === "claude-opus-4-8")?.webSearch).toBe("engine");
    expect(catalog.models.find((model) => model.modelId === "gpt-5.5")?.webSearch).toBe("in_answer");
    // The switch off gives GPT the engine too.
    expect(buildCurrentUserCatalog({ ...base, searchPolicy: { inAnswerSearch: false } })
      .models.find((model) => model.modelId === "gpt-5.5")?.webSearch).toBe("engine");
    // A chosen engine that cannot search is named, never replaced.
    expect(buildCurrentUserCatalog({ ...base, searchPolicy: { engineOptionId: "removed-source" } }).search)
      .toEqual({ engine: null, reason: "search_engine_unavailable" });
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
