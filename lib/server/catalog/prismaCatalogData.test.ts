import { describe, expect, it, vi } from "vitest";
import type { ProviderModel, SearchStrategy } from "@prisma/client";
import { buildCurrentUserCatalog } from "./handlers";
import {
  createPrismaCatalogDataLoader,
  exposeFakeProvider,
  filterAvailableProviderModels,
  filterExposedProviderModels,
  filterExposedSearchStrategies,
  providerModelToCatalogEntry,
  type CatalogProviderModelRow
} from "./prismaCatalogData";

const now = new Date("2026-07-23T00:00:00.000Z");

const capabilities = {
  nativePdfInput: false,
  nativeSearch: true,
  pdf: false,
  reasoning: true,
  streaming: true,
  toolCalling: true,
  vision: false
};

type ProviderModelFixtureOptions = {
  activeCredentialChecks?: CatalogProviderModelRow["activeCredentialChecks"];
  activeConfig?: unknown;
  connection?: Partial<Omit<CatalogProviderModelRow["connection"], "credentials">>;
  credentials?: CatalogProviderModelRow["connection"]["credentials"];
  fake?: boolean;
  model?: Partial<ProviderModel>;
};

function credential(
  id: string,
  options: {
    enabled?: boolean;
    groupIds?: string[];
    revoked?: boolean;
    userIds?: string[];
    versionId?: string | null;
  } = {}
): CatalogProviderModelRow["connection"]["credentials"][number] {
  const versionId = options.versionId === undefined ? `${id}-v1` : options.versionId;

  return {
    activeVersion: versionId
      ? {
          id: versionId,
          revokedAt: options.revoked ? now : null
        }
      : null,
    enabled: options.enabled ?? true,
    groupAssignments: (options.groupIds ?? []).map((groupId) => ({
      credentialId: id,
      groupId
    })),
    id,
    userAssignments: (options.userIds ?? []).map((userId) => ({
      credentialId: id,
      userId
    }))
  };
}

function providerModel(options: ProviderModelFixtureOptions = {}): CatalogProviderModelRow {
  const fake = options.fake ?? false;
  const connectionId = options.model?.connectionId ?? (fake ? "connection-fake" : "connection-openai");
  const id = options.model?.id ?? (fake ? "deployment-fake" : "deployment-answer");
  const activeVersion = options.model?.activeVersion ?? 7;
  const connectionVersion = options.connection?.activeVersion ?? 5;
  const credentials = options.credentials ?? (fake ? [] : [credential("credential-default")]);
  const activeConfig = options.activeConfig ?? (fake
    ? {
        adapterKind: "fake",
        capabilities,
        defaultParams: { stream: true },
        upstreamModelId: "fake-qsa"
      }
    : {
        adapterKind: "openai_responses_native",
        capabilities,
        defaultParams: { maxOutputTokens: 2048, stream: false },
        upstreamModelId: "upstream/answer"
      });
  const row: CatalogProviderModelRow = {
    activeConfig: activeConfig as never,
    activeCredentialChecks: [],
    activeVersion,
    activatedAt: now,
    capabilities: {},
    connection: {
      activeConfig: {
        allowPrivateNetwork: fake,
        apiRoot: fake ? "http://127.0.0.1" : "https://api.example.com/v1"
      },
      activeVersion: connectionVersion,
      activatedAt: now,
      credentials,
      defaultCredentialId: fake ? null : "credential-default",
      displayName: fake ? "Fake" : "Primary account",
      enabled: true,
      family: fake ? "fake" : "openai",
      id: connectionId,
      templateKey: fake ? "fake" : null,
      unassignedPolicy: "use_default",
      ...options.connection
    },
    connectionId,
    contextWindow: 8192,
    createdAt: now,
    defaultParams: { stale: true },
    displayName: "Answer deployment",
    draftConfig: {},
    draftVersion: 1,
    enabled: true,
    id,
    inputTokenPriceMicros: 0,
    modelId: "legacy-upstream",
    outputTokenPriceMicros: 0,
    provider: "legacy-family",
    supportsNativeSearch: false,
    supportsPdf: false,
    supportsReasoning: false,
    supportsVision: false,
    templateKey: fake ? "fake:fake-qsa" : null,
    updatedAt: now,
    ...options.model
  };
  const selectedCredential = credentials.find((candidate) => candidate.id === row.connection.defaultCredentialId);
  const selectedVersionId = selectedCredential?.activeVersion?.id;
  row.activeCredentialChecks = options.activeCredentialChecks ?? (
    fake || !selectedCredential || !selectedVersionId
      ? []
      : [{
          connectionId,
          connectionVersion: row.connection.activeVersion,
          credentialId: selectedCredential.id,
          credentialVersionId: selectedVersionId,
          modelVersion: row.activeVersion,
          providerModelId: row.id,
          status: "available"
        }]
  );

  return row;
}

function membership(groupId: string, archived = false) {
  return {
    group: {
      archivedAt: archived ? now : null
    },
    groupId
  };
}

function providerBackedSearchModel(id = "technical-search-deployment") {
  return providerModel({
    activeConfig: {
      adapterKind: "openrouter_chat_completions",
      capabilities,
      defaultParams: { maxTokens: 1024 },
      openRouterRouting: {
        mode: "automatic",
        providers: []
      },
      upstreamModelId: "perplexity/sonar-pro-search"
    },
    connection: {
      family: "openrouter"
    },
    model: {
      id
    }
  });
}

function entitlements(input: {
  connections?: string[];
  fullAccess?: boolean;
  models?: Array<[string, string]>;
  searches?: string[];
} = {}) {
  return {
    fullAccess: input.fullAccess === true,
    modelKeys: new Set((input.models ?? []).map(([connectionId, modelId]) => `${connectionId}:${modelId}`)),
    providerKeys: new Set(input.connections ?? []),
    searchStrategies: new Set(input.searches ?? [])
  };
}

function searchStrategy(overrides: Partial<SearchStrategy>): SearchStrategy {
  return {
    activatedAt: now,
    activeRevisionId: "search-revision",
    adapterKind: "none",
    archivedAt: null,
    config: {},
    credentialMode: "answer_provider",
    createdAt: now,
    description: "Search",
    displayName: "Search",
    draft: {},
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: true,
    id: "search-row",
    kind: "none",
    modelId: null,
    provider: "system",
    providerModelId: null,
    strategyId: "search-disabled",
    testedDraftHash: null,
    updatedAt: now,
    ...overrides
  };
}

describe("prisma catalog data loader", () => {
  it("exposes the code-owned Fake deployment only in explicit non-production test mode", () => {
    expect(exposeFakeProvider({})).toBe(false);
    expect(exposeFakeProvider({ AIQSA_TEST_MODE: "1" })).toBe(true);
    expect(exposeFakeProvider({ NODE_ENV: "test" })).toBe(false);
    expect(exposeFakeProvider({ AIQSA_TEST_MODE: "1", NODE_ENV: "production" })).toBe(false);
    expect(exposeFakeProvider({ AIQSA_TEST_MODE: "true" })).toBe(false);

    const real = providerModel();
    const fake = providerModel({ fake: true });
    const adminShapedFake = providerModel({
      fake: true,
      model: { id: "admin-created-fake", templateKey: null }
    });

    expect(filterAvailableProviderModels({ exposeFake: false, memberships: [], models: [real, fake] }))
      .toEqual([real]);
    expect(filterAvailableProviderModels({
      exposeFake: true,
      memberships: [],
      models: [real, fake, adminShapedFake]
    })).toEqual([real, fake]);
  });

  it("applies only stable connection/deployment entitlements", () => {
    const first = providerModel({
      model: { connectionId: "connection-a", id: "deployment-a" }
    });
    const second = providerModel({
      model: { connectionId: "connection-b", id: "deployment-b" }
    });

    expect(filterExposedProviderModels({
      entitlements: entitlements({ models: [["connection-a", "deployment-a"]] }),
      models: [first, second]
    })).toEqual([first]);
    expect(filterExposedProviderModels({
      entitlements: entitlements({ connections: ["connection-b"] }),
      models: [first, second]
    })).toEqual([second]);
    expect(filterExposedProviderModels({
      entitlements: entitlements({ fullAccess: true }),
      models: [first, second]
    })).toEqual([first, second]);
  });

  it("requires one effective credential and an exact current AVAILABLE tuple", () => {
    const assigned = credential("credential-group", { groupIds: ["group-a", "group-b"] });
    const model = providerModel({
      activeCredentialChecks: [{
        connectionId: "connection-openai",
        connectionVersion: 5,
        credentialId: "credential-group",
        credentialVersionId: "credential-group-v1",
        modelVersion: 7,
        providerModelId: "deployment-answer",
        status: "available"
      }],
      credentials: [credential("credential-default"), assigned]
    });

    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [membership("group-a"), membership("group-b")],
      models: [model]
    })).toEqual([model]);

    const ambiguous = providerModel({
      credentials: [
        credential("credential-default"),
        credential("credential-a", { groupIds: ["group-a"] }),
        credential("credential-b", { groupIds: ["group-b"] })
      ]
    });
    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [membership("group-a"), membership("group-b")],
      models: [ambiguous]
    })).toEqual([]);

    const staleCheck = providerModel();
    staleCheck.activeCredentialChecks[0]!.modelVersion -= 1;
    const unavailableCheck = providerModel();
    unavailableCheck.activeCredentialChecks[0]!.status = "unavailable";
    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [],
      models: [staleCheck, unavailableCheck]
    })).toEqual([]);
  });

  it("uses the current user's direct credential before conflicting group assignments", () => {
    const direct = credential("credential-user", { userIds: ["user-1"] });
    const model = providerModel({
      activeCredentialChecks: [{
        connectionId: "connection-openai",
        connectionVersion: 5,
        credentialId: direct.id,
        credentialVersionId: direct.activeVersion!.id,
        modelVersion: 7,
        providerModelId: "deployment-answer",
        status: "available"
      }],
      credentials: [
        credential("credential-default"),
        credential("credential-a", { groupIds: ["group-a"] }),
        credential("credential-b", { groupIds: ["group-b"] }),
        direct
      ]
    });

    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [membership("group-a"), membership("group-b")],
      models: [model],
      userId: "user-1"
    })).toEqual([model]);

    direct.enabled = false;
    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [membership("group-a")],
      models: [model],
      userId: "user-1"
    })).toEqual([]);
  });

  it("requires both the connection and deployment to be enabled and activated", () => {
    const disabledModel = providerModel({ model: { enabled: false } });
    const draftOnlyModel = providerModel({
      model: { activeVersion: 0, activatedAt: null }
    });
    const disabledConnection = providerModel({
      connection: { enabled: false }
    });
    const draftOnlyConnection = providerModel({
      connection: { activeVersion: 0, activatedAt: null }
    });

    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [],
      models: [disabledModel, draftOnlyModel, disabledConnection, draftOnlyConnection]
    })).toEqual([]);
  });

  it("ignores archived-group assignments and never falls through from an unusable current assignment", () => {
    const model = providerModel({
      credentials: [
        credential("credential-default"),
        credential("credential-disabled", { enabled: false, groupIds: ["group-a"] })
      ]
    });

    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [membership("group-a", true)],
      models: [model]
    })).toEqual([model]);
    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [membership("group-a")],
      models: [model]
    })).toEqual([]);
  });

  it("uses active typed configuration and opaque DB identities in model options", () => {
    const model = providerModel({
      activeConfig: {
        adapterKind: "openai_chat_completions_compatible",
        capabilities: {
          ...capabilities,
          nativeSearch: false,
          reasoning: false,
          streaming: false
        },
        defaultParams: {
          max_tokens: 512,
          temperature: 0.4
        },
        upstreamModelId: "custom/upstream"
      },
      connection: {
        displayName: "Internal gateway",
        family: "openai_compatible"
      },
      model: {
        id: "opaque-deployment-id"
      }
    });
    const entry = providerModelToCatalogEntry(model);

    expect(entry).toMatchObject({
      adapterKind: "openai_chat_completions_compatible",
      capabilities: {
        nativeSearch: false,
        reasoning: false,
        streaming: false
      },
      defaultParams: {
        max_tokens: 512,
        temperature: 0.4
      },
      modelId: "opaque-deployment-id",
      provider: "connection-openai",
      providerDisplayName: "Internal gateway",
      providerFamily: "openai_compatible",
      upstreamModelId: "custom/upstream"
    });
    expect(entry?.parameterControls.background).toEqual({
      defaultValue: false,
      supported: false
    });
  });

  it("never exposes the provider compatibility sentinel as a context window", () => {
    const known = providerModelToCatalogEntry(providerModel({
      activeConfig: {
        adapterKind: "openai_responses_native",
        capabilities,
        defaultParams: {},
        upstreamModelId: "gpt-5.6-sol"
      },
      model: { contextWindow: 1 }
    }));
    const unknown = providerModelToCatalogEntry(providerModel({
      activeConfig: {
        adapterKind: "openai_responses_compatible",
        capabilities,
        defaultParams: {},
        upstreamModelId: "private/model"
      },
      connection: { family: "openai_compatible" },
      model: { contextWindow: 1 }
    }));

    expect(known?.contextWindow).toBe(1_050_000);
    expect(unknown?.contextWindow).toBe(0);
  });

  it("fails closed on unreadable active model configuration", () => {
    const model = providerModel({
      activeConfig: {
        adapterKind: "unknown",
        capabilities,
        defaultParams: {},
        upstreamModelId: "upstream/answer"
      }
    });

    expect(providerModelToCatalogEntry(model)).toBeNull();
    expect(filterAvailableProviderModels({ exposeFake: false, memberships: [], models: [model] }))
      .toEqual([]);
  });

  it("makes provider-backed search availability independent from answer-model grants", () => {
    const strategies = filterExposedSearchStrategies({
      availableProviderModels: [providerBackedSearchModel()],
      entitlements: entitlements({ searches: ["perplexity-tool-search"] }),
      exposedProviderModels: [],
      searchStrategies: [
        searchStrategy({ strategyId: "search-disabled" }),
        searchStrategy({
          kind: "perplexity_tool_search",
          provider: "openrouter",
          providerModelId: "technical-search-deployment",
          strategyId: "perplexity-tool-search"
        }),
        searchStrategy({
          id: "missing-search",
          kind: "perplexity_tool_search",
          providerModelId: "missing-technical-deployment",
          strategyId: "perplexity-tool-search"
        }),
        searchStrategy({
          id: "unsupported-search",
          kind: "unsupported_kind",
          strategyId: "unsupported-search"
        })
      ]
    });

    expect(strategies.map((strategy) => strategy.strategyId)).toEqual([
      "search-disabled",
      "perplexity-tool-search"
    ]);
  });

  it("publishes hosted Search only when an entitled available answer model can run it", () => {
    const hosted = searchStrategy({
      adapterKind: "answer_provider_hosted",
      credentialMode: "answer_provider",
      kind: "openai_native_web_search",
      provider: "openai",
      strategyId: "openai-native-web-search"
    });
    const answer = providerModel();
    const input = {
      availableProviderModels: [answer],
      entitlements: entitlements({ searches: ["openai-native-web-search"] }),
      searchStrategies: [hosted]
    };

    expect(filterExposedSearchStrategies({
      ...input,
      exposedProviderModels: []
    })).toEqual([]);
    expect(filterExposedSearchStrategies({
      ...input,
      exposedProviderModels: [answer]
    }).map((strategy) => strategy.strategyId)).toEqual(["openai-native-web-search"]);
  });

  it("stops before catalog queries when the user or settings are missing", async () => {
    const loadEntitlements = vi.fn();
    const prisma = {
      providerModel: {
        findMany: vi.fn()
      },
      runProfile: {
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
    expect(prisma.runProfile.findMany).not.toHaveBeenCalled();
    expect(prisma.searchStrategy.findMany).not.toHaveBeenCalled();
    expect(loadEntitlements).not.toHaveBeenCalled();
  });

  it("loads only entitled available deployments and preserves the stable saved default", async () => {
    const answer = providerModel({
      model: { connectionId: "connection-answer", id: "deployment-answer" }
    });
    const technicalSearch = providerBackedSearchModel("deployment-search");
    technicalSearch.connectionId = "connection-search";
    technicalSearch.connection.id = "connection-search";
    technicalSearch.activeCredentialChecks = technicalSearch.activeCredentialChecks.map((check) => ({
      ...check,
      connectionId: "connection-search"
    }));
    const prisma = {
      providerModel: {
        findMany: vi.fn(async (_query?: unknown) => [answer, technicalSearch, providerModel({ fake: true })])
      },
      runProfile: {
        findMany: vi.fn(async () => [{
          description: "Most everyday questions",
          enabled: true,
          id: "balanced",
          providerModelId: "deployment-answer",
          reasoningEffort: "medium",
          reasoningMode: "standard"
        }])
      },
      searchStrategy: {
        findMany: vi.fn(async () => [
          searchStrategy({ strategyId: "search-disabled" }),
          searchStrategy({
            kind: "perplexity_tool_search",
            provider: "openrouter",
            providerModelId: "deployment-search",
            strategyId: "perplexity-tool-search"
          })
        ])
      },
      user: {
        findUnique: vi.fn(async () => ({
          groups: [],
          promptPresets: [{
            developerPrompt: null,
            id: "prompt-1",
            isDefault: true,
            name: "Helpful",
            systemPrompt: "System"
          }],
          settings: {
            defaultControlValues: {},
            defaultModelId: "legacy-upstream",
            defaultPromptPresetId: "prompt-1",
            defaultProvider: "legacy-family",
            defaultProviderModel: { connectionId: "connection-answer" },
            defaultProviderModelId: "deployment-answer",
            defaultSearchStrategyId: "perplexity-tool-search",
            showCitations: false,
            showReasoningBlocks: true,
            showToolActivity: true
          }
        }))
      }
    };
    const loader = createPrismaCatalogDataLoader({
      env: {},
      loadEntitlements: async () => entitlements({
        models: [["connection-answer", "deployment-answer"]],
        searches: ["perplexity-tool-search"]
      }),
      prisma: prisma as never
    });

    const data = await loader("user-1");
    const modelQuery = prisma.providerModel.findMany.mock.calls[0]?.[0] as {
      include: {
        connection: {
          include: {
            credentials: unknown;
          };
        };
      };
    } | undefined;
    expect(modelQuery?.include.connection.include.credentials).toHaveProperty("select");
    expect(JSON.stringify(modelQuery)).not.toMatch(/draftSecretEnvelope|secretEnvelope|testEvidence/u);
    expect(data?.models.map((model) => [model.provider, model.modelId])).toEqual([
      ["connection-answer", "deployment-answer"]
    ]);
    expect(data?.searchStrategies.map((strategy) => strategy.strategyId)).toEqual([
      "search-disabled",
      "perplexity-tool-search"
    ]);

    const catalog = buildCurrentUserCatalog(data!);
    expect(catalog.defaults).toMatchObject({
      modelId: "deployment-answer",
      provider: "connection-answer",
      searchStrategyId: "perplexity-tool-search"
    });
    expect(catalog.providers).toEqual([{
      family: "openai",
      id: "connection-answer",
      models: ["deployment-answer"],
      name: "Primary account"
    }]);
    expect(catalog.runProfiles).toEqual([expect.objectContaining({
      available: true,
      id: "balanced",
      modelId: "deployment-answer",
      provider: "connection-answer"
    })]);
  });

  it("does not silently replace an unavailable saved deployment with the first model", () => {
    const available = providerModelToCatalogEntry(providerModel({
      model: { connectionId: "connection-available", id: "deployment-available" }
    }));
    expect(available).not.toBeNull();

    const catalog = buildCurrentUserCatalog({
      entitlements: entitlements({
        models: [["connection-available", "deployment-available"]]
      }),
      models: [available!],
      promptPresets: [],
      runProfiles: [],
      searchStrategies: [],
      settings: {
        defaultControlValues: {},
        defaultModelId: "legacy-stale",
        defaultPromptPresetId: null,
        defaultProvider: "legacy-stale",
        defaultProviderConnectionId: "connection-unavailable",
        defaultProviderModelId: "deployment-unavailable",
        defaultSearchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true
      }
    });

    expect(catalog.defaults).toMatchObject({
      modelId: "deployment-unavailable",
      provider: "connection-unavailable"
    });
  });
});
