import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { CatalogData } from "../catalog/currentUserCatalog";
import type { ProviderModelCatalogEntry } from "../../domain/catalog";
import {
  createCreateAssistantHandler,
  createDuplicateAssistantHandler,
  createGetAssistantHandler,
  createListAssistantsHandler,
  createPublishAssistantHandler,
  createRevokeAssistantPublicationHandler,
  createUpdateAssistantHandler,
  type AssistantHandlerDeps
} from "./handlers";
import type { AssistantAccessEntry, AssistantRevisionRow } from "./prismaRepository";

const avatar = {
  accents: [1],
  backgroundShape: "circle",
  foregroundShape: "ring",
  kind: "generated",
  paletteId: "ember",
  recipeVersion: 1,
  rotations: [0, 0]
};

function session(role: "admin" | "user" = "user"): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    id: "session-1",
    user: {
      displayName: "Runner",
      email: "runner@example.test",
      id: "user-1",
      role,
      status: "active"
    },
    userId: "user-1"
  };
}

function catalogModel(): ProviderModelCatalogEntry {
  return {
    adapterKind: "openai_responses_native",
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: false
    },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: "Luna",
    inputTokenPriceMicros: 0,
    modelId: "model-1",
    outputTokenPriceMicros: 0,
    parameterControls: {
      background: { defaultValue: false, supported: true },
      maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
      reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
      stream: { defaultValue: false, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "connection-1",
    providerDisplayName: "OpenAI",
    providerFamily: "openai",
    upstreamModelId: "gpt-test"
  };
}

function catalogData(): CatalogData {
  return {
    entitlements: {
      fullAccess: true,
      modelKeys: new Set<string>(),
      providerKeys: new Set<string>(),
      searchStrategies: new Set<string>()
    },
    models: [catalogModel()],
    searchStrategies: [
      {
        description: "Web search",
        displayName: "OpenAI Search",
        kind: "web_search",
        routes: [
          {
            adapterKind: "provider_model_client",
            config: {},
            credentialMode: "provider_model",
            executionModes: ["all_selected", "model_choice"],
            kind: "provider_model_web_search",
            physicalStrategyId: "openai-search-client",
            protocol: "openai_responses_web_search",
            providerModelId: "search-model-1",
            revisionId: "search-revision-1",
            searchStrategyRowId: "search-strategy-row-1"
          }
        ],
        strategyId: "openai-native-web-search"
      }
    ],
    settings: {
      defaultControlValues: {},
      defaultModelId: "model-1",
      defaultProvider: "connection-1",
      defaultSearchStrategyId: "search-disabled",
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true
    }
  };
}

function revisionRow(overrides: Partial<AssistantRevisionRow> = {}): AssistantRevisionRow {
  return {
    authorDisplayName: "Owner",
    avatar,
    category: "coding",
    createdAt: new Date("2026-08-06T00:00:00.000Z"),
    description: "Reviews changes.",
    developerPrompt: null,
    id: "revision-1",
    mcpServerIds: [],
    name: "Code Reviewer",
    providerModelId: "model-1",
    revisionNumber: 4,
    runControls: { reasoningEffort: "high" },
    searchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search"] },
    starterPrompts: ["Review a diff"],
    systemPrompt: "You review code.",
    ...overrides
  };
}

function accessEntry(overrides: Partial<AssistantAccessEntry> = {}): AssistantAccessEntry {
  return {
    archived: false,
    id: "assistant-1",
    installationScope: false,
    memberGroupNames: ["Design"],
    owned: false,
    ownerDisplayName: "Alex",
    pinned: false,
    published: true,
    revision: revisionRow(),
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    version: 3,
    ...overrides
  };
}

function fakeRepository(overrides: Partial<AssistantHandlerDeps["repository"]> = {}) {
  return {
    create: vi.fn(async () => "assistant-1"),
    duplicate: vi.fn(async () => ({ kind: "not_found" as const })),
    getDetail: vi.fn(async () => null),
    getRevision: vi.fn(async () => null),
    listForUser: vi.fn(async () => []),
    listPublishableGroups: vi.fn(async () => []),
    listRevisions: vi.fn(async () => null),
    loadUserAccessibleMcpServerIds: vi.fn(async () => new Set<string>()),
    loadUserMcpRunPlanView: vi.fn(async () => ({
      isGenerationLive: () => false,
      now: new Date("2026-08-07T10:00:00.000Z"),
      recordsByServerId: new Map()
    })),
    loadUserRunnableMcpServerIds: vi.fn(async () => new Set<string>()),
    publish: vi.fn(async () => ({ kind: "not_found" as const })),
    revise: vi.fn(async () => ({ kind: "not_found" as const })),
    revokePublication: vi.fn(async () => "not_found" as const),
    setArchived: vi.fn(async () => ({ kind: "not_found" as const })),
    setPinned: vi.fn(async () => false),
    ...overrides
  } satisfies AssistantHandlerDeps["repository"];
}

function handlerDeps(
  repositoryOverrides: Partial<AssistantHandlerDeps["repository"]> = {},
  options: { catalogData?: CatalogData; role?: "admin" | "user" } = {}
): AssistantHandlerDeps {
  return {
    loadCatalogData: async () => options.catalogData ?? catalogData(),
    repository: fakeRepository(repositoryOverrides),
    resolveAuth: async () => session(options.role ?? "user")
  };
}

describe("assistant list handler", () => {
  it("projects runner-safe summaries with availability and fingerprint", async () => {
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry(),
        accessEntry({
          id: "assistant-2",
          revision: revisionRow({ id: "revision-2", mcpServerIds: ["hidden-server"], name: "Ops" })
        })
      ]),
      listPublishableGroups: vi.fn(async () => [{ id: "group-1", name: "Design" }])
    });
    const response = await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      assistants: Array<Record<string, unknown>>;
      publishableGroups: unknown[];
      viewer: { canPublishInstallation: boolean };
    };

    expect(body.viewer.canPublishInstallation).toBe(false);
    expect(body.publishableGroups).toEqual([{ id: "group-1", name: "Design" }]);
    const [first, second] = body.assistants;
    expect(first).toMatchObject({
      availability: { ok: true },
      fingerprint: {
        mcpServerCount: 0,
        modelLabel: "Luna",
        reasoningEffort: "high",
        searchOptionCount: 1
      },
      name: "Code Reviewer",
      revisionNumber: 4,
      scope: { groupNames: ["Design"], kind: "group" }
    });
    expect(second).toMatchObject({
      availability: { ok: false, reason: "tools_access" }
    });
  });

  it("marks assistants whose model is outside the runner catalog as unavailable", async () => {
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({ revision: revisionRow({ providerModelId: "hidden-model" }) })
      ])
    });
    const response = await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"));
    const body = (await response.json()) as { assistants: Array<Record<string, unknown>> };
    expect(body.assistants[0]).toMatchObject({
      availability: { ok: false, reason: "model_access" },
      fingerprint: { modelLabel: null }
    });
  });

  it("marks a granted but disabled or unready MCP dependency unavailable", async () => {
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({
          revision: revisionRow({ mcpServerIds: ["server-1"] })
        })
      ]),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["server-1"])),
      loadUserMcpRunPlanView: vi.fn(async () => ({
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map()
      }))
    });
    const response = await createListAssistantsHandler(deps)(
      new Request("http://test/api/me/assistants")
    );
    const body = (await response.json()) as { assistants: Array<Record<string, unknown>> };
    expect(body.assistants[0]).toMatchObject({
      availability: { ok: false, reason: "tools_access" }
    });
  });
});

describe("assistant detail handler", () => {
  it("censors hidden dependency ids for consumers while keeping instructions inspectable", async () => {
    const deps = handlerDeps({
      getDetail: vi.fn(async () => ({
        ...accessEntry({
          revision: revisionRow({
            mcpServerIds: ["granted-server", "hidden-server"],
            providerModelId: "hidden-model",
            searchPlan: {
              mode: "all_selected",
              optionIds: ["openai-native-web-search", "hidden-search"]
            }
          })
        }),
        publications: null,
        revisionCount: null
      })),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["granted-server"]))
    });
    const response = await createGetAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1"),
      { params: { assistantId: "assistant-1" } }
    );
    const body = (await response.json()) as { assistant: Record<string, unknown> };
    const revision = body.assistant.revision as Record<string, unknown>;

    expect(revision.systemPrompt).toBe("You review code.");
    expect(revision.providerModelId).toBeNull();
    expect(revision.mcpServerIds).toEqual(["granted-server"]);
    expect(revision.searchPlan).toEqual({
      mode: "all_selected",
      optionIds: ["openai-native-web-search"]
    });
    expect(body.assistant.publications).toBeUndefined();
    expect(body.assistant.version).toBeUndefined();
  });

  it("returns one privacy-neutral not-found for invisible assistants", async () => {
    const response = await createGetAssistantHandler(handlerDeps())(
      new Request("http://test/api/me/assistants/ghost"),
      { params: { assistantId: "ghost" } }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "assistant_not_available" });
  });
});

describe("assistant duplicate handler", () => {
  it("fails closed instead of turning hidden dependencies into owned detail", async () => {
    const duplicate = vi.fn(async () => ({ kind: "model_not_available" as const }));
    const getDetail = vi.fn();
    const deps = handlerDeps({
      duplicate,
      getDetail
    });
    const response = await createDuplicateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1/duplicate", { method: "POST" }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "assistant_model_not_available" });
    expect(duplicate).toHaveBeenCalledWith("user-1", "assistant-1");
    expect(getDetail).not.toHaveBeenCalled();
  });
});

describe("assistant create handler", () => {
  it("rejects model-incompatible controls, Search, and MCP before persistence", async () => {
    const create = vi.fn(async () => "assistant-1");
    const noTools = catalogModel();
    noTools.capabilities = { ...noTools.capabilities, toolCalling: false };
    const incompatibleCatalog = catalogData();
    incompatibleCatalog.models = [noTools];
    const deps = handlerDeps(
      {
        create,
        loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["server-1"]))
      },
      { catalogData: incompatibleCatalog }
    );
    const request = (overrides: {
      mcpServerIds?: string[];
      optionIds?: string[];
      runControls?: Record<string, unknown>;
    }) =>
      new Request("http://test/api/me/assistants", {
        body: JSON.stringify({
          avatar,
          category: null,
          description: "",
          developerPrompt: null,
          mcpServerIds: overrides.mcpServerIds ?? [],
          name: "Reviewer",
          providerModelId: "model-1",
          runControls: overrides.runControls ?? {},
          searchPlan: {
            mode: "all_selected",
            optionIds: overrides.optionIds ?? []
          },
          starterPrompts: [],
          systemPrompt: ""
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

    const controlsResponse = await createCreateAssistantHandler(deps)(
      request({ runControls: { maxOutputTokens: 128_001 } })
    );
    expect(controlsResponse.status).toBe(400);
    expect(await controlsResponse.json()).toEqual({
      error: "assistant_run_controls_invalid"
    });

    const searchResponse = await createCreateAssistantHandler(deps)(
      request({ optionIds: ["openai-native-web-search"] })
    );
    expect(searchResponse.status).toBe(400);
    expect(await searchResponse.json()).toEqual({
      error: "assistant_search_option_not_available"
    });

    const toolsResponse = await createCreateAssistantHandler(deps)(
      request({ mcpServerIds: ["server-1"] })
    );
    expect(toolsResponse.status).toBe(400);
    expect(await toolsResponse.json()).toEqual({
      error: "assistant_tools_not_available"
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("assistant update handler", () => {
  it("validates drafts against the owner catalog before persistence", async () => {
    const revise = vi.fn();
    const deps = handlerDeps({ revise });
    const response = await createUpdateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          revision: {
            avatar,
            category: null,
            description: "",
            developerPrompt: null,
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "not-in-catalog",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: [] },
            starterPrompts: [],
            systemPrompt: ""
          }
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "assistant_model_not_available" });
    expect(revise).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a max-output value outside the selected model range",
      { maxOutputTokens: 128_001 },
      "assistant_run_controls_invalid"
    ],
    [
      "an unsupported reasoning effort",
      { reasoningEffort: "ultra" },
      "assistant_run_controls_invalid"
    ],
    [
      "reasoning disabled when the model does not offer a none option",
      { reasoningEffort: "none" },
      "assistant_run_controls_invalid"
    ]
  ])("rejects %s before persistence", async (_label, runControls, error) => {
    const revise = vi.fn();
    const response = await createUpdateAssistantHandler(handlerDeps({ revise }))(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          revision: {
            avatar,
            category: null,
            description: "",
            developerPrompt: null,
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "model-1",
            runControls,
            searchPlan: { mode: "all_selected", optionIds: [] },
            starterPrompts: [],
            systemPrompt: ""
          }
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(revise).not.toHaveBeenCalled();
  });

  it("rejects Search and MCP choices that the selected model cannot execute", async () => {
    const revise = vi.fn();
    const noTools = catalogModel();
    noTools.capabilities = { ...noTools.capabilities, toolCalling: false };
    const unavailableCatalog = catalogData();
    unavailableCatalog.models = [noTools];
    const request = (overrides: { mcpServerIds: string[]; optionIds: string[] }) =>
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          revision: {
            avatar,
            category: null,
            description: "",
            developerPrompt: null,
            mcpServerIds: overrides.mcpServerIds,
            name: "Reviewer",
            providerModelId: "model-1",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: overrides.optionIds },
            starterPrompts: [],
            systemPrompt: ""
          }
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
    const deps = handlerDeps(
      {
        loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["server-1"])),
        revise
      },
      { catalogData: unavailableCatalog }
    );

    const searchResponse = await createUpdateAssistantHandler(deps)(
      request({ mcpServerIds: [], optionIds: ["openai-native-web-search"] }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(searchResponse.status).toBe(400);
    expect(await searchResponse.json()).toEqual({
      error: "assistant_search_option_not_available"
    });

    const toolsResponse = await createUpdateAssistantHandler(deps)(
      request({ mcpServerIds: ["server-1"], optionIds: [] }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(toolsResponse.status).toBe(400);
    expect(await toolsResponse.json()).toEqual({ error: "assistant_tools_not_available" });
    expect(revise).not.toHaveBeenCalled();
  });

  it("maps CAS conflicts to a stable version conflict", async () => {
    const deps = handlerDeps({
      revise: vi.fn(async () => ({ kind: "version_conflict" as const }))
    });
    const response = await createUpdateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 1,
          revision: {
            avatar,
            category: null,
            description: "",
            developerPrompt: null,
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "model-1",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: [] },
            starterPrompts: [],
            systemPrompt: ""
          }
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "assistant_version_conflict" });
  });
});

describe("assistant publish handler", () => {
  it("rejects installation publication for non-admin publishers", async () => {
    const deps = handlerDeps({
      publish: vi.fn(async () => ({ kind: "forbidden" as const }))
    });
    const response = await createPublishAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1/publications", {
        body: JSON.stringify({ scope: "installation" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("rejects malformed publication requests before repository work", async () => {
    const publish = vi.fn();
    const deps = handlerDeps({ publish });
    const response = await createPublishAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1/publications", {
        body: JSON.stringify({ scope: "group" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(response.status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("assistant publication revoke handler", () => {
  it("binds the publication deletion to the Assistant path parent", async () => {
    const revokePublication = vi.fn(async () => "not_found" as const);
    const response = await createRevokeAssistantPublicationHandler(
      handlerDeps({ revokePublication })
    )(
      new Request(
        "http://test/api/me/assistants/assistant-parent/publications/publication-child",
        { method: "DELETE" }
      ),
      {
        params: {
          assistantId: "assistant-parent",
          publicationId: "publication-child"
        }
      }
    );

    expect(response.status).toBe(404);
    expect(revokePublication).toHaveBeenCalledWith({
      actorIsAdmin: false,
      assistantId: "assistant-parent",
      publicationId: "publication-child",
      userId: "user-1"
    });
  });
});
