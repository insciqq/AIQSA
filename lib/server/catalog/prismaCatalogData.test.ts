import { describe, expect, it, vi } from "vitest";
import type { ProviderModel } from "@prisma/client";
import { buildCurrentUserCatalog } from "./handlers";
import {
  createPrismaCatalogDataLoader,
  exposeFakeProvider,
  filterAvailableProviderModels,
  filterExposedProviderModels,
  filterExposedSearchOptions,
  providerModelToCatalogEntry,
  searchOptionToCatalogEntry,
  searchStrategyToCatalogRoute,
  type CatalogSearchOptionRow,
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
    modelClass: "answer",
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
      answerSelectable: false,
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

type CatalogSearchStrategyRow = CatalogSearchOptionRow["strategies"][number];

function searchStrategy(
  overrides: Partial<CatalogSearchStrategyRow> = {}
): CatalogSearchStrategyRow {
  const kind = overrides.kind ?? "none";
  const adapterKind = overrides.adapterKind ?? (
    kind === "perplexity_tool_search" || kind === "provider_model_web_search"
      ? "provider_model_client"
      : "answer_provider_hosted"
  );
  const credentialMode = adapterKind === "provider_model_client"
    ? "provider_model"
    : "answer_provider";
  const protocol = kind === "gemini_google_search"
    ? "gemini_google_search"
    : kind === "perplexity_tool_search"
      ? "openrouter_perplexity_chat"
      : "openai_responses_web_search";
  const providerModelId = overrides.providerModelId ?? (
    adapterKind === "provider_model_client" ? "technical-search-deployment" : null
  );
  const activeRevision = kind === "none"
    ? null
    : {
        adapterKind,
        configuration: {
          adapterKind,
          credentialMode,
          maxResults: 8,
          protocol,
          providerModelId,
          queryMaxCharacters: 500,
          timeoutMs: 300_000
        },
        credentialMode,
        id: "search-revision",
        providerModelId
      };
  return {
    activatedAt: now,
    activeRevision,
    activeRevisionId: activeRevision?.id ?? null,
    adapterKind,
    archivedAt: null,
    config: {},
    credentialMode,
    createdAt: now,
    description: "Search",
    displayName: "Search",
    draft: {},
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: true,
    id: "search-row",
    kind,
    modelId: null,
    provider: "system",
    providerModelId,
    searchOptionId: "search-option-row",
    strategyId: "search-disabled",
    testedDraftHash: null,
    updatedAt: now,
    ...overrides
  };
}

function searchOption(
  overrides: Partial<CatalogSearchOptionRow> = {}
): CatalogSearchOptionRow {
  const kind = overrides.kind ?? "none";
  const sourceConnectionId = overrides.sourceConnectionId === undefined
    ? kind === "none" ? null : "connection-openai"
    : overrides.sourceConnectionId;
  return {
    description: "Search the web",
    displayName: "Search",
    id: "search-option-row",
    kind,
    optionId: kind === "none" ? "search-disabled" : "search-option",
    sourceConnection: sourceConnectionId ? { id: sourceConnectionId } : null,
    sourceConnectionId,
    strategies: [],
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

  it("exposes compatible Chat modes only with an explicit mode request mapping", () => {
    const activeConfig = {
      adapterKind: "openai_chat_completions_compatible",
      capabilities: {
        ...capabilities,
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        reasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"]
      },
      defaultParams: {},
      upstreamModelId: "custom/reasoning"
    };
    const withoutMode = providerModelToCatalogEntry(providerModel({
      activeConfig,
      connection: { family: "openai_compatible" }
    }));
    const withMode = providerModelToCatalogEntry(providerModel({
      activeConfig: {
        ...activeConfig,
        reasoningRequestMapping: {
          effortPath: "reasoning_effort",
          modePath: "reasoning_mode"
        }
      },
      connection: { family: "openai_compatible" }
    }));

    expect(withoutMode?.parameterControls.reasoningMode).toBeUndefined();
    expect(withMode?.parameterControls.reasoningMode).toMatchObject({
      defaultValue: "standard",
      options: ["standard", "pro"],
      supported: true
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
    const technicalModel = providerBackedSearchModel();
    const answerModel = providerModel({
      connection: { family: "anthropic", id: "connection-answer" },
      model: { connectionId: "connection-answer", id: "deployment-answer" }
    });
    expect(filterAvailableProviderModels({
      exposeFake: false,
      memberships: [],
      models: [technicalModel]
    })).toEqual([technicalModel]);
    expect(filterExposedProviderModels({
      entitlements: entitlements({ fullAccess: true }),
      models: [technicalModel]
    })).toEqual([]);

    const input = {
      availableProviderModels: [technicalModel],
      entitlements: entitlements({ searches: ["perplexity-tool-search"] }),
      searchOptions: [
        searchOption(),
        searchOption({
          kind: "perplexity_search",
          optionId: "perplexity-tool-search",
          sourceConnection: { id: "connection-openai" },
          sourceConnectionId: "connection-openai",
          strategies: [
            searchStrategy({
              kind: "perplexity_tool_search",
              provider: "openrouter",
              providerModelId: "technical-search-deployment",
              strategyId: "perplexity-tool-search"
            }),
            searchStrategy({
              activeRevision: null,
              id: "untested-search",
              kind: "perplexity_tool_search",
              strategyId: "untested-perplexity-route"
            })
          ]
        })
      ]
    };

    expect(filterExposedSearchOptions({ ...input, exposedProviderModels: [] })
      .map((option) => option.strategyId)).toEqual(["search-disabled"]);
    const options = filterExposedSearchOptions({
      ...input,
      exposedProviderModels: [answerModel]
    });
    expect(options.map((option) => option.strategyId)).toEqual([
      "search-disabled",
      "perplexity-tool-search"
    ]);
    expect(options[1]?.routes.map((route) => route.physicalStrategyId)).toEqual([
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
    const option = searchOption({
      displayName: "OpenAI Search",
      kind: "web_search",
      optionId: "openai-native-web-search",
      strategies: [hosted]
    });
    const input = {
      availableProviderModels: [answer],
      entitlements: entitlements({ searches: ["openai-native-web-search"] }),
      searchOptions: [option]
    };

    expect(filterExposedSearchOptions({
      ...input,
      exposedProviderModels: []
    })).toEqual([]);
    expect(filterExposedSearchOptions({
      ...input,
      exposedProviderModels: [answer]
    }).map((entry) => entry.strategyId)).toEqual(["openai-native-web-search"]);
    expect(filterExposedSearchOptions({
      ...input,
      entitlements: entitlements(),
      exposedProviderModels: [answer]
    })).toEqual([]);
    expect(filterExposedSearchOptions({
      ...input,
      entitlements: entitlements({ fullAccess: true }),
      exposedProviderModels: [answer]
    }).map((entry) => entry.strategyId)).toEqual(["openai-native-web-search"]);
  });

  it("keeps one logical OpenAI source while filtering client routes to its exact connection", () => {
    const hosted = searchStrategy({
      kind: "openai_native_web_search",
      strategyId: "openai-native-web-search"
    });
    const client = searchStrategy({
      id: "client-route",
      kind: "provider_model_web_search",
      providerModelId: "technical-search-deployment",
      strategyId: "openai-provider-web-search"
    });
    const option = searchOption({
      displayName: "OpenAI Search",
      kind: "web_search",
      optionId: "openai-native-web-search",
      strategies: [hosted, client]
    });
    const answer = providerModel({
      connection: { id: "connection-anthropic" },
      model: { connectionId: "connection-anthropic", id: "deployment-anthropic" }
    });
    const technical = providerModel({
      model: { id: "technical-search-deployment" }
    });

    const exposed = filterExposedSearchOptions({
      availableProviderModels: [answer, technical],
      entitlements: entitlements({ searches: ["openai-native-web-search"] }),
      exposedProviderModels: [answer],
      searchOptions: [option]
    });
    expect(exposed).toHaveLength(1);
    expect(exposed[0]).toMatchObject({
      displayName: "OpenAI Search",
      kind: "web_search",
      strategyId: "openai-native-web-search"
    });
    expect(exposed[0]?.routes.map((route) => route.physicalStrategyId)).toEqual([
      "openai-native-web-search",
      "openai-provider-web-search"
    ]);

    const mismatchedTechnical = providerModel({
      connection: { id: "another-openai-connection" },
      model: {
        connectionId: "another-openai-connection",
        id: "technical-search-deployment"
      }
    });
    expect(filterExposedSearchOptions({
      availableProviderModels: [answer, mismatchedTechnical],
      entitlements: entitlements({ searches: ["openai-native-web-search"] }),
      exposedProviderModels: [answer],
      searchOptions: [option]
    })).toEqual([]);
  });

  it.each([
    {
      label: "hosted",
      routes: [
        searchStrategy({
          adapterKind: "answer_provider_hosted",
          id: "hosted-a",
          kind: "openai_native_web_search",
          strategyId: "openai-hosted-a"
        }),
        searchStrategy({
          adapterKind: "answer_provider_hosted",
          id: "hosted-b",
          kind: "openai_native_web_search",
          strategyId: "openai-hosted-b"
        })
      ]
    },
    {
      label: "client",
      routes: [
        searchStrategy({
          id: "client-a",
          kind: "provider_model_web_search",
          providerModelId: "technical-search-deployment",
          strategyId: "openai-client-a"
        }),
        searchStrategy({
          id: "client-b",
          kind: "provider_model_web_search",
          providerModelId: "technical-search-deployment",
          strategyId: "openai-client-b"
        })
      ]
    }
  ])("rejects a logical source with two normalized $label routes", ({ routes }) => {
    const answer = providerModel();
    const technical = providerModel({ model: { id: "technical-search-deployment" } });
    const option = searchOption({
      displayName: "OpenAI Search",
      kind: "web_search",
      optionId: "openai-native-web-search",
      strategies: routes
    });

    expect(filterExposedSearchOptions({
      availableProviderModels: [answer, technical],
      entitlements: entitlements({ searches: ["openai-native-web-search"] }),
      exposedProviderModels: [answer],
      memberships: [],
      searchOptions: [option]
    })).toEqual([]);
  });

  it("exposes client Search through each user's current available credential without stored probe state", () => {
    const answer = providerModel({
      connection: { family: "anthropic", id: "connection-anthropic" },
      model: { connectionId: "connection-anthropic", id: "deployment-anthropic" }
    });
    const defaultBinding = {
      connectionId: "connection-openai",
      connectionVersion: 5,
      credentialId: "credential-default",
      credentialVersionId: "credential-default-v1",
      modelVersion: 7,
      providerModelId: "technical-search-deployment"
    };
    const option = searchOption({
      displayName: "OpenAI Search",
      kind: "web_search",
      optionId: "openai-native-web-search",
      strategies: [searchStrategy({
        id: "client-route",
        kind: "provider_model_web_search",
        providerModelId: "technical-search-deployment",
        strategyId: "openai-provider-web-search"
      })]
    });
    const expose = (technical: CatalogProviderModelRow, userId?: string) => filterExposedSearchOptions({
      availableProviderModels: [answer, technical],
      entitlements: entitlements({ searches: ["openai-native-web-search"] }),
      exposedProviderModels: [answer],
      memberships: [],
      searchOptions: [option],
      userId
    });
    const exact = providerModel({ model: { id: "technical-search-deployment" } });
    expect(expose(exact)).toHaveLength(1);

    const rotated = providerModel({
      credentials: [credential("credential-default", { versionId: "credential-default-v2" })],
      model: { id: "technical-search-deployment" }
    });
    expect(expose(rotated)).toHaveLength(1);

    const direct = credential("credential-user", { userIds: ["user-1"] });
    const reassigned = providerModel({
      activeCredentialChecks: [{
        ...defaultBinding,
        credentialId: direct.id,
        credentialVersionId: direct.activeVersion!.id,
        status: "available"
      }],
      credentials: [credential("credential-default"), direct],
      model: { id: "technical-search-deployment" }
    });
    expect(expose(reassigned, "user-1")).toHaveLength(1);

    const unchecked = providerModel({
      activeCredentialChecks: [],
      model: { id: "technical-search-deployment" }
    });
    expect(expose(unchecked)).toEqual([]);
  });

  it("rejects malformed logical options and drifted active physical revisions", () => {
    const drifted = searchStrategy({
      activeRevision: {
        adapterKind: "answer_provider_hosted",
        configuration: {
          adapterKind: "provider_model_client",
          credentialMode: "provider_model",
          maxResults: 8,
          protocol: "openai_responses_web_search",
          providerModelId: "technical-search-deployment",
          queryMaxCharacters: 500,
          timeoutMs: 300_000
        },
        credentialMode: "answer_provider",
        id: "drifted-revision",
        providerModelId: "technical-search-deployment"
      },
      kind: "provider_model_web_search",
      providerModelId: "technical-search-deployment"
    });
    expect(searchStrategyToCatalogRoute(drifted)).toBeNull();
    expect(searchOptionToCatalogEntry(searchOption({
      kind: "web_search",
      sourceConnection: null,
      sourceConnectionId: null
    }))).toBeNull();
  });

  it("stops before catalog queries when the user or settings are missing", async () => {
    const loadEntitlements = vi.fn();
    const prisma = {
      providerModel: {
        findMany: vi.fn()
      },
      searchOption: {
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
    expect(prisma.searchOption.findMany).not.toHaveBeenCalled();
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
      searchOption: {
        findMany: vi.fn(async (_query?: unknown) => [
          searchOption(),
          searchOption({
            displayName: "Perplexity Search",
            kind: "perplexity_search",
            optionId: "perplexity-tool-search",
            sourceConnection: { id: "connection-search" },
            sourceConnectionId: "connection-search",
            strategies: [searchStrategy({
              kind: "perplexity_tool_search",
              provider: "openrouter",
              providerModelId: "deployment-search",
              strategyId: "perplexity-tool-search"
            })]
          })
        ])
      },
      user: {
        findUnique: vi.fn(async () => ({
          groups: [],
          settings: {
            defaultControlValues: {},
            defaultModelId: "legacy-upstream",
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
    const searchOptionQuery = prisma.searchOption.findMany.mock.calls[0]?.[0];
    expect(searchOptionQuery).toMatchObject({
      include: {
        sourceConnection: { select: { id: true } },
        strategies: {
          where: {
            activeRevisionId: { not: null },
            archivedAt: null,
            enabled: true
          }
        }
      },
      where: { archivedAt: null, enabled: true }
    });
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
    expect(catalog.searchStrategies).toEqual([
      {
        description: "Search the web",
        displayName: "Search",
        kind: "none",
        strategyId: "search-disabled"
      },
      {
        description: "Search the web",
        displayName: "Perplexity Search",
        kind: "perplexity_tool_search",
        strategyId: "perplexity-tool-search"
      }
    ]);
    expect(catalog.providers).toEqual([{
      family: "openai",
      id: "connection-answer",
      models: ["deployment-answer"],
      name: "Primary account"
    }]);
  });

  it("does not expose or silently replace an unavailable saved deployment", () => {
    const available = providerModelToCatalogEntry(providerModel({
      model: { connectionId: "connection-available", id: "deployment-available" }
    }));
    expect(available).not.toBeNull();

    const catalog = buildCurrentUserCatalog({
      entitlements: entitlements({
        models: [["connection-available", "deployment-available"]]
      }),
      models: [available!],
      searchStrategies: [],
      settings: {
        defaultControlValues: {},
        defaultModelId: "legacy-stale",
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
      modelId: "",
      provider: ""
    });
  });
});
