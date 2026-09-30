import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { CatalogData } from "../catalog/currentUserCatalog";
import type { ProviderModelCatalogEntry } from "../../domain/catalog";
import type { McpRunPlanRecord } from "../mcp/runPlan";
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
import type { AssistantAccessEntry, AssistantContentRow } from "./prismaRepository";
import {
  assistantRowsFromLegacyFields,
  type AssistantLegacyRowFields,
  decodeAssistantDetailResponse,
  decodeAssistantDuplicateResponse,
  decodeAssistantListResponse,
  type AssistantRowKey,
  type AssistantRows,
  type AssistantRunControls,
  type AssistantSummary
} from "../../contracts/assistants";
import type { SearchPlan } from "../../contracts/search";

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
    inputTokenPriceUsdPerMillion: 0,
    modelId: "model-1",
    outputTokenPriceUsdPerMillion: 0,
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
      defaultSearchPlan: null,
      defaultProviderModelId: "model-1",
      showCitations: true,
      showReasoningBlocks: false,
    }
  };
}

/** A rows draft from compact flat row fields, every row fixed as the first release wrote them. */
function draftBody(value: Record<string, unknown>): Record<string, unknown> {
  const { knowledgeSelection, mcpServerIds, providerModelId, runControls, searchPlan, skillIds, ...fields } = value;
  return {
    ...fields,
    rows: assistantRowsFromLegacyFields({
      knowledgeSelection, mcpServerIds, providerModelId, runControls, searchPlan, skillIds: skillIds ?? []
    } as AssistantLegacyRowFields)
  };
}

function contentRow(overrides: Partial<AssistantContentRow> = {}): AssistantContentRow {
  const content: Omit<AssistantContentRow, "rows"> = {
    answerRules: null,
    avatar,
    category: "coding",
    description: "Reviews changes.",
    id: "assistant-1",
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [],
    name: "Code Reviewer",
    providerModelId: "model-1",
    runControls: { reasoningEffort: "high" },
    searchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search"] },
    skillIds: [],
    starterPrompts: ["Review a diff"],
    systemPrompt: "You review code.",
    ...overrides
  };
  const rows = overrides.rows ?? assistantRowsFromLegacyFields({
    knowledgeSelection: content.knowledgeSelection,
    mcpServerIds: content.mcpServerIds,
    providerModelId: content.providerModelId ?? "",
    runControls: content.runControls as AssistantRunControls,
    searchPlan: content.searchPlan as SearchPlan,
    skillIds: content.skillIds,
    skillModes: content.skillModes,
    skills: content.skills
  });
  return {
    ...content,
    rows: content.providerModelId === null
      ? { ...rows, model: { policy: "adjustable", value: { mode: "inherit" } } }
      : rows
  };
}

function accessEntry(overrides: Partial<AssistantAccessEntry> = {}): AssistantAccessEntry {
  return {
    archived: false,
    audience: null,
    featured: false,
    featuredOrder: null,
    id: "assistant-1",
    installationScope: false,
    memberGroupNames: ["Design"],
    owned: false,
    ownerDisplayName: "Alex",
    pinned: false,
    published: true,
    content: contentRow(),
    dependencyAvailability: { knowledge: "ready", skills: true },
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    version: 3,
    ...overrides
  };
}

function mcpRecord(overrides: Partial<McpRunPlanRecord> = {}): McpRunPlanRecord {
  return {
    credentialSources: [],
    enabled: true,
    errorCode: null,
    externalAccountLabel: null,
    fingerprint: null,
    generationId: null,
    inventory: null,
    inventoryUpdatedAt: null,
    namespace: "github",
    readiness: "queued",
    revisionId: "mcp-revision-1",
    serverId: "server-1",
    serverName: "GitHub",
    ...overrides
  };
}

function fakeRepository(overrides: Partial<AssistantHandlerDeps["repository"]> = {}) {
  return {
    create: vi.fn(async () => ({ assistantId: "assistant-1", kind: "ok" as const })),
    duplicate: vi.fn(async () => ({ kind: "not_found" as const })),
    getDetail: vi.fn(async () => null),
    listForUser: vi.fn(async () => []),
    listPublishableGroups: vi.fn(async () => []),
    loadDefaultAssistantId: vi.fn(async () => null),
    loadRecentAssistantIds: vi.fn(async () => []),
    loadUserAccessibleMcpServerIds: vi.fn(async () => new Set<string>()),
    loadUserMcpRunPlanView: vi.fn(async () => ({
      isGenerationLive: () => false,
      now: new Date("2026-08-07T10:00:00.000Z"),
      recordsByServerId: new Map()
    })),
    publish: vi.fn(async () => ({ kind: "not_found" as const })),
    update: vi.fn(async () => ({ kind: "not_found" as const })),
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

describe("Assistant dependency availability projection", () => {
  it.each(["not_ready", "unavailable"] as const)("projects Knowledge %s consistently in list and detail", async (knowledge) => {
    const entry = accessEntry({
      dependencyAvailability: { knowledge, skills: true },
      content: contentRow({ knowledgeSelection: { mode: "explicit", version: 1, baseIds: ["hidden-base"], sourceIds: [] } })
    });
    const deps = handlerDeps({ listForUser: vi.fn(async () => [entry]), getDetail: vi.fn(async () => ({ ...entry, publications: null })) });
    const listed = await (await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"))).json();
    const detail = await (await createGetAssistantHandler(deps)(new Request("http://test/api/me/assistants/assistant-1"),
      { params: { assistantId: "assistant-1" } })).json();
    expect(listed.assistants[0].availability).toEqual({ ok: false, reason: `knowledge_${knowledge}` });
    expect(detail.assistant.availability).toEqual(listed.assistants[0].availability);
    expect(JSON.stringify({ listed, detail })).not.toContain("hidden-base");
  });

  it.each(["skills", "knowledge"] as const)("rechecks %s for list/detail and keeps shared failures neutral", async (kind) => {
    const entry = accessEntry({
      dependencyAvailability: { knowledge: kind === "knowledge" ? "access_denied" : "ready", skills: kind !== "skills" },
      content: contentRow({
        skillIds: kind === "skills" ? ["hidden-skill"] : [], skillSummaries: [],
        knowledgeSelection: kind === "knowledge"
          ? { mode: "explicit", version: 1, baseIds: ["hidden-base"], sourceIds: [] }
          : { mode: "none", version: 1, baseIds: [], sourceIds: [] }
      })
    });
    const deps = handlerDeps({ listForUser: vi.fn(async () => [entry]), getDetail: vi.fn(async () => ({ ...entry, publications: null })) });
    const listed = await (await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"))).json();
    const detail = await (await createGetAssistantHandler(deps)(new Request("http://test/api/me/assistants/assistant-1"),
      { params: { assistantId: "assistant-1" } })).json();
    expect(listed.assistants[0].availability).toEqual({ ok: false, reason: `${kind}_access` });
    expect(detail.assistant.availability).toEqual(listed.assistants[0].availability);
    expect(JSON.stringify({ listed, detail })).not.toMatch(/hidden-skill|hidden-base/);
    entry.dependencyAvailability = { knowledge: "ready", skills: true };
    const restored = await (await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"))).json();
    expect(restored.assistants[0].availability).toEqual({ ok: true });
  });
});

describe("assistant list handler", () => {
  it("projects runner-safe summaries with availability and fingerprint", async () => {
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({
          content: contentRow({
            knowledgeSelection: {
              baseIds: ["hidden-base"],
              mode: "explicit",
              sourceIds: ["hidden-source"],
              version: 1
            }
          })
        }),
        accessEntry({
          id: "assistant-2",
          content: contentRow({ id: "assistant-2", mcpServerIds: ["hidden-server"], name: "Ops" })
        })
      ]),
      listPublishableGroups: vi.fn(async () => [{ id: "group-1", memberCount: 5, name: "Design" }])
    });
    const response = await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      assistants: Array<Record<string, unknown>>;
      publishableGroups: unknown[];
      viewer: { canPublishInstallation: boolean };
    };

    expect(body.viewer.canPublishInstallation).toBe(false);
    expect(body.publishableGroups).toEqual([{ id: "group-1", memberCount: 5, name: "Design" }]);
    expect(decodeAssistantListResponse(body)).not.toBeNull();
    const [first, second] = body.assistants;
    expect(first).toMatchObject({
      availability: { ok: true },
      fingerprint: {
        knowledgeLabel: "Knowledge · 2",
        knowledgeResourceCount: 2,
        mcpServerCount: 0,
        modelLabel: "Luna",
        reasoningEffort: "high",
        searchOptionCount: 1
      },
      name: "Code Reviewer",
      scope: { groupNames: ["Design"], kind: "group" }
    });
    expect(second).toMatchObject({
      availability: { ok: false, reason: "tools_access" }
    });
  });

  it("marks assistants whose model is outside the runner catalog as unavailable", async () => {
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({ content: contentRow({ providerModelId: "hidden-model" }) })
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
          content: contentRow({ mcpServerIds: ["server-1"] })
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

  it("names failing MCP dependencies only in the owner's projection", async () => {
    const record = mcpRecord({ enabled: false, readiness: "disabled" });
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({
          id: "owned-assistant",
          owned: true,
          content: contentRow({ mcpServerIds: [record.serverId] })
        }),
        accessEntry({
          id: "shared-assistant",
          owned: false,
          content: contentRow({ id: "assistant-2", mcpServerIds: [record.serverId] })
        })
      ]),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set([record.serverId])),
      loadUserMcpRunPlanView: vi.fn(async () => ({
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map([[record.serverId, record]])
      }))
    });

    const response = await createListAssistantsHandler(deps)(
      new Request("http://test/api/me/assistants")
    );
    const body = await response.json() as {
      assistants: Array<{ availability: Record<string, unknown>; id: string }>;
    };

    expect(body.assistants[0]?.availability).toEqual({
      dependencies: [{ kind: "mcp", name: "GitHub" }],
      ok: false,
      reason: "tools_access"
    });
    expect(body.assistants[1]?.availability).toEqual({
      ok: false,
      reason: "tools_access"
    });
  });

  it("keeps an unknown MCP startability failure generic for the owner", async () => {
    const record = mcpRecord({
      enabled: false,
      errorCode: "mcp_startability_unknown",
      readiness: "unavailable"
    });
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({
          owned: true,
          content: contentRow({ mcpServerIds: [record.serverId] })
        })
      ]),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set([record.serverId])),
      loadUserMcpRunPlanView: vi.fn(async () => ({
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map([[record.serverId, record]])
      }))
    });

    const response = await createListAssistantsHandler(deps)(
      new Request("http://test/api/me/assistants")
    );
    const body = await response.json() as {
      assistants: Array<{ availability: Record<string, unknown> }>;
    };

    expect(body.assistants[0]?.availability).toEqual({
      dependencies: [{ kind: "mcp", name: "Required MCP tools" }],
      ok: false,
      reason: "tools_access"
    });
  });

  it("keeps a revoked MCP dependency generic across inconsistent read snapshots", async () => {
    const record = mcpRecord({ readiness: "ready" });
    const deps = handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({
          owned: true,
          content: contentRow({ mcpServerIds: [record.serverId] })
        })
      ]),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set<string>()),
      loadUserMcpRunPlanView: vi.fn(async () => ({
        isGenerationLive: () => true,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map([[record.serverId, record]])
      }))
    });

    const response = await createListAssistantsHandler(deps)(
      new Request("http://test/api/me/assistants")
    );
    const body = await response.json() as {
      assistants: Array<{ availability: Record<string, unknown> }>;
    };

    expect(body.assistants[0]?.availability).toEqual({
      dependencies: [{ kind: "mcp", name: "Required MCP tools" }],
      ok: false,
      reason: "tools_access"
    });
    expect(JSON.stringify(body)).not.toContain(record.serverName);
  });
});

describe("assistant detail handler", () => {
  it("censors hidden dependency ids for consumers while keeping instructions inspectable", async () => {
    const deps = handlerDeps({
      getDetail: vi.fn(async () => ({
        ...accessEntry({
          content: contentRow({
            mcpServerIds: ["granted-server", "hidden-server"],
            knowledgeSelection: {
              baseIds: ["hidden-base"],
              mode: "explicit",
              sourceIds: ["hidden-source"],
              version: 1
            },
            providerModelId: "hidden-model",
            searchPlan: {
              mode: "all_selected",
              optionIds: ["openai-native-web-search", "hidden-search"]
            },
            skillSummaries: [
              { id: "skill-review", name: "Careful reviewer", instructionApproxTokens: 42 },
              { id: "skill-finish", name: "Action closer", instructionApproxTokens: 12 }
            ],
            skillIds: ["skill-review", "skill-finish"]
          })
        }),
        publications: null,
      })),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["granted-server"]))
    });
    const response = await createGetAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1"),
      { params: { assistantId: "assistant-1" } }
    );
    const body = (await response.json()) as { assistant: Record<string, unknown> };
    const content = body.assistant.content as Record<string, unknown>;

    expect(content.systemPrompt).toBe("You review code.");
    expect(content.knowledgeSelection).toEqual({
      baseIds: [],
      inheritedFrom: "assistant",
      mode: "inherited",
      sourceIds: [],
      version: 1
    });
    expect(content.providerModelId).toBeNull();
    expect(content.mcpServerIds).toEqual(["granted-server"]);
    expect(content.searchPlan).toEqual({
      mode: "all_selected",
      optionIds: ["openai-native-web-search"]
    });
    expect(content.skillIds).toEqual(["skill-review", "skill-finish"]);
    expect(body.assistant.skills).toEqual([
      { id: "skill-review", name: "Careful reviewer", instructionApproxTokens: 42 },
      { id: "skill-finish", name: "Action closer", instructionApproxTokens: 12 }
    ]);
    expect(body.assistant.publications).toBeUndefined();
    expect(body.assistant.version).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/hidden-base|hidden-source/u);
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
  it("answers one privacy-neutral not-found when the source is not visible", async () => {
    const duplicate = vi.fn(async () => ({ kind: "not_found" as const }));
    const getDetail = vi.fn();
    const response = await createDuplicateAssistantHandler(handlerDeps({ duplicate, getDetail }))(
      new Request("http://test/api/me/assistants/assistant-1/duplicate", { method: "POST" }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "assistant_not_available" });
    expect(duplicate).toHaveBeenCalledWith("user-1", "assistant-1");
    expect(getDetail).not.toHaveBeenCalled();
  });
});

describe("assistant create handler", () => {
  it("rejects model-incompatible controls, Search, and MCP before persistence", async () => {
    const create = vi.fn(async () => ({ assistantId: "assistant-1", kind: "ok" as const }));
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
        body: JSON.stringify(draftBody({
          avatar,
          category: null,
          description: "",
          knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
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
        })),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

    const controlsResponse = await createCreateAssistantHandler(deps)(
      request({ runControls: { maxOutputTokens: 128_001 } })
    );
    expect(controlsResponse.status).toBe(400);
    expect(await controlsResponse.json()).toEqual({
      error: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      limit: 128_000
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

  it("creates an Assistant whose enabled MCP dependency starts on demand", async () => {
    const record = mcpRecord({ readiness: "idle" });
    const create = vi.fn(async () => ({ assistantId: "assistant-1", kind: "ok" as const }));
    const owned = accessEntry({
      owned: true,
      content: contentRow({ mcpServerIds: [record.serverId], searchPlan: {
        mode: "all_selected",
        optionIds: []
      } })
    });
    const deps = handlerDeps({
      create,
      getDetail: vi.fn(async () => ({ ...owned, publications: [] })),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set([record.serverId])),
      loadUserMcpRunPlanView: vi.fn(async () => ({
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map([[record.serverId, record]])
      }))
    });

    const response = await createCreateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants", {
        body: JSON.stringify(draftBody({
          avatar,
          category: null,
          description: "",
          knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
          mcpServerIds: [record.serverId],
          name: "Reviewer",
          providerModelId: "model-1",
          runControls: {},
          searchPlan: { mode: "all_selected", optionIds: [] },
          skillIds: [],
          starterPrompts: [],
          systemPrompt: ""
        })),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      assistant: { availability: { ok: true } }
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("preserves ordered Skill ids and maps unavailable dependencies", async () => {
    const create = vi.fn(async () => ({ kind: "skills_not_available" as const }));
    const response = await createCreateAssistantHandler(handlerDeps({ create }))(
      new Request("http://test/api/me/assistants", {
        body: JSON.stringify(draftBody({
          avatar,
          category: null,
          description: "",
          knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
          mcpServerIds: [],
          name: "Reviewer",
          providerModelId: "model-1",
          runControls: {},
          searchPlan: { mode: "all_selected", optionIds: [] },
          skillIds: ["skill-review", "skill-finish"],
          starterPrompts: [],
          systemPrompt: ""
        })),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "assistant_skills_not_available" });
    expect(create).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        rows: expect.objectContaining({
          skills: {
            policy: "fixed",
            value: {
              links: [
                { delivery: "always", skillId: "skill-review" },
                { delivery: "always", skillId: "skill-finish" }
              ],
              mode: "auto"
            }
          }
        })
      })
    );
  });
});

describe("assistant update handler", () => {
  it("validates drafts against the owner catalog before persistence", async () => {
    const update = vi.fn();
    const deps = handlerDeps({ update });
    const response = await createUpdateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          content: draftBody({
            avatar,
            category: null,
            description: "",
            knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "not-in-catalog",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: [] },
            starterPrompts: [],
            systemPrompt: ""
          })
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "assistant_model_not_available" });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a structurally invalid max-output value",
      { maxOutputTokens: 0 },
      { error: "assistant_run_controls_invalid", field: "maxOutputTokens", row: "controls" }
    ],
    [
      "a max-output value outside the selected model range",
      { maxOutputTokens: 128_001 },
      { error: "assistant_run_controls_invalid", field: "maxOutputTokens", limit: 128_000 }
    ],
    [
      "an unsupported reasoning effort",
      { reasoningEffort: "ultra" },
      { error: "assistant_run_controls_invalid", field: "reasoningEffort" }
    ],
    [
      "a Temperature value above the selected model range",
      { temperature: 3 },
      { error: "assistant_run_controls_invalid", field: "temperature", limit: 2 }
    ],
    [
      "reasoning disabled when the model does not offer a none option",
      { reasoningEffort: "none" },
      { error: "assistant_run_controls_invalid", field: "reasoningEffort" }
    ]
  ])("rejects %s before persistence", async (_label, runControls, errorBody) => {
    const update = vi.fn();
    const response = await createUpdateAssistantHandler(handlerDeps({ update }))(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          content: draftBody({
            avatar,
            category: null,
            description: "",
            knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "model-1",
            runControls,
            searchPlan: { mode: "all_selected", optionIds: [] },
            starterPrompts: [],
            systemPrompt: ""
          })
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(errorBody);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects Search and MCP choices that the selected model cannot execute", async () => {
    const update = vi.fn();
    const noTools = catalogModel();
    noTools.capabilities = { ...noTools.capabilities, toolCalling: false };
    const unavailableCatalog = catalogData();
    unavailableCatalog.models = [noTools];
    const request = (overrides: { mcpServerIds: string[]; optionIds: string[] }) =>
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          content: draftBody({
            avatar,
            category: null,
            description: "",
            knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
            mcpServerIds: overrides.mcpServerIds,
            name: "Reviewer",
            providerModelId: "model-1",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: overrides.optionIds },
            starterPrompts: [],
            systemPrompt: ""
          })
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
    const deps = handlerDeps(
      {
        loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["server-1"])),
        update
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
    expect(update).not.toHaveBeenCalled();
  });

  it("maps CAS conflicts to a stable version conflict", async () => {
    const deps = handlerDeps({
      update: vi.fn(async () => ({ kind: "version_conflict" as const }))
    });
    const response = await createUpdateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 1,
          content: draftBody({
            avatar,
            category: null,
            description: "",
            knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "model-1",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: [] },
            starterPrompts: [],
            systemPrompt: ""
          })
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "assistant_version_conflict" });
  });

  it("maps an unavailable Skill dependency during an edit", async () => {
    const update = vi.fn(async () => ({ kind: "skills_not_available" as const }));
    const response = await createUpdateAssistantHandler(handlerDeps({ update }))(
      new Request("http://test/api/me/assistants/assistant-1", {
        body: JSON.stringify({
          expectedVersion: 3,
          content: draftBody({
            avatar,
            category: null,
            description: "",
            knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
            mcpServerIds: [],
            name: "Reviewer",
            providerModelId: "model-1",
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: [] },
            skillIds: ["skill-private"],
            starterPrompts: [],
            systemPrompt: ""
          })
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "assistant_skills_not_available" });
    expect(update).toHaveBeenCalledWith(
      "user-1",
      "assistant-1",
      3,
      expect.objectContaining({
        rows: expect.objectContaining({
          skills: { policy: "fixed", value: { links: [{ delivery: "always", skillId: "skill-private" }], mode: "auto" } }
        })
      })
    );
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

  it("returns an actionable conflict when included Skills do not reach the audience", async () => {
    const response = await createPublishAssistantHandler(handlerDeps({
      publish: vi.fn(async () => ({ kind: "skill_audience_mismatch" as const }))
    }))(
      new Request("http://test/api/me/assistants/assistant-1/publications", {
        body: JSON.stringify({ groupId: "group-1", scope: "group" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "assistant_skill_audience_mismatch",
      message: "Share every included Skill with this audience before publishing the Assistant."
    });
  });

  it("names the included Skills that do not reach the audience", async () => {
    const response = await createPublishAssistantHandler(handlerDeps({
      publish: vi.fn(async () => ({ kind: "skill_audience_mismatch" as const, skillNames: ["Private draft"] }))
    }))(
      new Request("http://test/api/me/assistants/assistant-1/publications", {
        body: JSON.stringify({ groupId: "group-1", scope: "group" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }),
      { params: { assistantId: "assistant-1" } }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "assistant_skill_audience_mismatch", skills: ["Private draft"] });
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

describe("live Assistant publication validation", () => {
  it("rejects a removed revision selector instead of silently changing its meaning", async () => {
    const deps = handlerDeps();
    const response = await createPublishAssistantHandler(deps)(new Request("http://localhost/api", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "group", groupId: "team", revisionNumber: 1 })
    }), { params: { assistantId: "assistant-1" } });
    expect(response.status).toBe(400);
    expect(deps.repository.publish).not.toHaveBeenCalled();
  });
});

describe("Assistants v2 wire emission", () => {
  const rowsDraft = {
    avatar,
    category: null,
    description: "",
    name: "Analyst",
    rows: {
      controls: { policy: "adjustable", value: {} },
      knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "off" } },
      skills: { policy: "fixed", value: { links: [], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "off" } }
    },
    starterPrompts: [],
    systemPrompt: "Analyse."
  };

  it("lists with Featured, empty deviations, recents and only a listed default Assistant", async () => {
    const featured = accessEntry({ featured: true, featuredOrder: 0, id: "assistant-featured" });
    const archived = accessEntry({ archived: true, id: "assistant-archived", owned: true });
    for (const [stored, expected] of [
      ["assistant-featured", "assistant-featured"],
      ["assistant-archived", null],
      ["assistant-hidden", null],
      [null, null]
    ] as const) {
      const deps = handlerDeps({
        listForUser: vi.fn(async () => [featured, archived]),
        loadDefaultAssistantId: vi.fn(async () => stored)
      });
      const body = await (await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"))).json();
      expect(body.recentAssistantIds).toEqual([]);
      expect(body.viewer).toEqual({ canPublishInstallation: false, defaultAssistantId: expected });
      expect(body.assistants[0]).toMatchObject({ featured: true, id: "assistant-featured", rowAvailability: {} });
      expect(decodeAssistantListResponse(body)).not.toBeNull();
    }
  });

  it("lists the Skill link count and Featured position to owners, consumers and administrators alike", async () => {
    const content = contentRow({
      skillIds: ["skill-visible", "hidden-skill"],
      skillSummaries: [{ id: "skill-visible", name: "Visible" }]
    });
    for (const [owned, role] of [[false, "user"], [true, "user"], [false, "admin"]] as const) {
      const deps = handlerDeps({
        listForUser: vi.fn(async () => [
          accessEntry({ content, featured: true, featuredOrder: 1, owned }),
          accessEntry({ id: "assistant-2", owned })
        ]),
        listPublishableGroups: vi.fn(async () => [{ id: "group-1", memberCount: 0, name: "Design" }])
      }, { role });
      const body = await (await createListAssistantsHandler(deps)(new Request("http://test/api/me/assistants"))).json();
      const label = `${role} owned=${owned}`;
      expect(body.assistants.map(({ featured, featuredOrder, skillLinkCount }: AssistantSummary) =>
        ({ featured, featuredOrder, skillLinkCount })), label).toEqual([
        { featured: true, featuredOrder: 1, skillLinkCount: 2 },
        { featured: false, featuredOrder: null, skillLinkCount: 0 }
      ]);
      expect(body.publishableGroups, label).toEqual([{ id: "group-1", memberCount: 0, name: "Design" }]);
      expect(JSON.stringify(body), label).not.toMatch(/hidden-skill|skill-visible|Visible/u);
      expect(decodeAssistantListResponse(body), label).not.toBeNull();
    }
  });

  it("redacts consumer rows to counts and keeps owner rows, answer rules and Featured position", async () => {
    const content = contentRow({
      answerRules: "Answer in bullet points.",
      knowledgeSelection: { baseIds: ["hidden-base"], mode: "explicit", sourceIds: ["hidden-source"], version: 1 },
      mcpServerIds: ["granted-server", "hidden-server"],
      providerModelId: "hidden-model",
      searchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search", "hidden-search"] },
      skillIds: ["skill-visible", "hidden-skill"],
      skillSummaries: [{ id: "skill-visible", name: "Visible" }]
    });
    const consumerDeps = handlerDeps({
      getDetail: vi.fn(async () => ({ ...accessEntry({ content }), publications: null })),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set(["granted-server"]))
    });
    const consumer = await (await createGetAssistantHandler(consumerDeps)(
      new Request("http://test/api/me/assistants/assistant-1"), { params: { assistantId: "assistant-1" } })).json();
    expect(consumer.assistant.content.answerRules).toBe("Answer in bullet points.");
    expect(consumer.assistant.content).not.toHaveProperty("developerPrompt");
    expect(consumer.assistant.content.rows).toEqual({
      controls: { policy: "fixed", value: { reasoningEffort: "high" } },
      knowledge: { policy: "fixed", value: { baseIds: [], hiddenCount: 2, mode: "explicit", sourceIds: [] } },
      model: { policy: "fixed", value: { mode: "model", modelId: null } },
      search: { policy: "fixed", value: { hiddenCount: 1, mode: "all_selected", optionIds: ["openai-native-web-search"] } },
      skills: { policy: "fixed", value: { hiddenCount: 1, links: [{ delivery: "always", skillId: "skill-visible" }], mode: "auto" } },
      tools: { policy: "fixed", value: { hiddenCount: 1, mode: "exact", serverIds: ["granted-server"] } }
    });
    expect(consumer.assistant).not.toHaveProperty("featuredOrder");
    expect(JSON.stringify(consumer)).not.toMatch(/hidden-(base|source|server|model|search|skill)/u);
    expect(decodeAssistantDetailResponse(consumer)).not.toBeNull();

    const ownerDeps = handlerDeps({
      getDetail: vi.fn(async () => ({
        ...accessEntry({ content: contentRow({ skillSummaries: [] }), featured: true, featuredOrder: 2, owned: true }),
        publications: []
      }))
    });
    const owner = await (await createGetAssistantHandler(ownerDeps)(
      new Request("http://test/api/me/assistants/assistant-1"), { params: { assistantId: "assistant-1" } })).json();
    expect(owner.assistant).toMatchObject({ featured: true, featuredOrder: 2, rowAvailability: {}, version: 3 });
    expect(owner.assistant.content.rows.model).toEqual({ policy: "fixed", value: { mode: "model", modelId: "model-1" } });
    expect(decodeAssistantDetailResponse(owner)).not.toBeNull();
  });

  const defaultRows: AssistantRows = {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  };

  it("creates an Assistant with every row at its new default and projects it as available", async () => {
    const created = accessEntry({
      content: contentRow({ mcpServerIds: [], providerModelId: null, rows: defaultRows,
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      owned: true
    });
    const create = vi.fn(async () => ({ assistantId: "assistant-1", kind: "ok" as const }));
    const getDetail = vi.fn(async () => ({ ...created, publications: [] }));
    const response = await createCreateAssistantHandler(handlerDeps({ create, getDetail }, { role: "admin" }))(
      new Request("http://test/api/me/assistants", {
        body: JSON.stringify({ ...rowsDraft, rows: defaultRows }), headers: { "content-type": "application/json" }, method: "POST"
      }));
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith("user-1", expect.objectContaining({ rows: defaultRows }));
    expect(getDetail).toHaveBeenCalledWith("user-1", "assistant-1", { isAdmin: true });
    const body = await response.json();
    expect(body.assistant).toMatchObject({ availability: { ok: true }, rowAvailability: {} });
    expect(body.assistant.content.rows).toEqual(defaultRows);
    expect(decodeAssistantDetailResponse(body)).not.toBeNull();
  });

  it("validates every concrete row value against the owner's catalog, whatever its policy", async () => {
    const create = vi.fn(async () => ({ assistantId: "assistant-1", kind: "ok" as const }));
    const post = (rows: unknown) => createCreateAssistantHandler(handlerDeps({ create }))(new Request("http://test/api/me/assistants", {
      body: JSON.stringify({ ...rowsDraft, rows }), headers: { "content-type": "application/json" }, method: "POST"
    }));
    const hiddenModel = await post({ ...defaultRows, model: { policy: "adjustable", value: { mode: "model", modelId: "hidden-model" } } });
    expect(hiddenModel.status).toBe(400);
    expect(await hiddenModel.json()).toEqual({ error: "assistant_model_not_available" });
    const hiddenSearch = await post({ ...defaultRows, search: { policy: "adjustable", value: { mode: "all_selected", optionIds: ["hidden-search"] } } });
    expect(await hiddenSearch.json()).toEqual({ error: "assistant_search_option_not_available" });
    const hiddenTools = await post({ ...defaultRows, tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["hidden-server"] } } });
    expect(await hiddenTools.json()).toEqual({ error: "assistant_tools_not_available" });
    const fixedInherit = await post({ ...defaultRows, tools: { policy: "fixed", value: { mode: "inherit" } } });
    expect(await fixedInherit.json()).toEqual({ error: "assistant_row_fixed_requires_value", row: "tools" });
    expect(create).not.toHaveBeenCalled();
  });

  it("makes an unusable adjustable model a row deviation and a fixed one a neutral unavailability", async () => {
    const entry = (policy: "adjustable" | "fixed", owned: boolean) => accessEntry({
      content: contentRow({
        modelDisplayName: "Orion",
        providerModelId: "hidden-model",
        rows: { ...defaultRows, model: { policy, value: { mode: "model", modelId: "hidden-model" } } }
      }),
      owned
    });
    const list = async (entries: AssistantAccessEntry[]) => {
      const body = await (await createListAssistantsHandler(handlerDeps({ listForUser: vi.fn(async () => entries) }))(
        new Request("http://test/api/me/assistants"))).json();
      expect(decodeAssistantListResponse(body)).not.toBeNull();
      return body.assistants;
    };
    const [adjustableConsumer, adjustableOwner] = await list([entry("adjustable", false), entry("adjustable", true)]);
    expect(adjustableConsumer).toMatchObject({ availability: { ok: true }, rowAvailability: { model: { reason: "model_access" } } });
    expect(adjustableConsumer.rowAvailability.model).not.toHaveProperty("dependencies");
    expect(adjustableOwner).toMatchObject({
      availability: { ok: true },
      rowAvailability: { model: { dependencies: [{ kind: "model", name: "Orion" }], reason: "model_access" } }
    });
    const [fixedConsumer, fixedOwner] = await list([entry("fixed", false), entry("fixed", true)]);
    expect(fixedConsumer).toMatchObject({ availability: { ok: false, reason: "model_access" }, rowAvailability: {} });
    expect(JSON.stringify(fixedConsumer)).not.toContain("Orion");
    expect(fixedOwner.availability).toEqual({ dependencies: [{ kind: "model", name: "Orion" }], ok: false, reason: "model_access" });
  });

  it("keeps unusable adjustable Search, tools and Knowledge out of availability; Skills and archive always count", async () => {
    const rows: AssistantRows = {
      ...defaultRows,
      knowledge: { policy: "adjustable", value: { baseIds: ["hidden-base"], mode: "explicit", sourceIds: [] } },
      search: { policy: "adjustable", value: { mode: "all_selected", optionIds: ["hidden-search"] } },
      tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["hidden-server"] } }
    };
    const adjustable = accessEntry({
      content: contentRow({ mcpServerIds: ["hidden-server"], providerModelId: null, rows,
        knowledgeSelection: { baseIds: ["hidden-base"], mode: "explicit", sourceIds: [], version: 1 } }),
      dependencyAvailability: { knowledge: "access_denied", skills: true }
    });
    const skillLinked = accessEntry({
      id: "assistant-2",
      content: contentRow({ id: "assistant-2", providerModelId: null, skillIds: ["skill-hidden"],
        rows: { ...defaultRows, skills: { policy: "adjustable", value: { links: [{ delivery: "on_demand", skillId: "skill-hidden" }], mode: "auto" } } } }),
      dependencyAvailability: { knowledge: "ready", skills: false }
    });
    const archived = accessEntry({ archived: true, id: "assistant-3", owned: true,
      content: contentRow({ id: "assistant-3", providerModelId: null, rows: defaultRows }) });
    const body = await (await createListAssistantsHandler(handlerDeps({
      listForUser: vi.fn(async () => [adjustable, skillLinked, archived])
    }))(new Request("http://test/api/me/assistants"))).json();
    expect(body.assistants[0]).toMatchObject({
      availability: { ok: true },
      rowAvailability: { knowledge: { reason: "knowledge_access" }, search: { reason: "search_access" }, tools: { reason: "tools_access" } }
    });
    expect(body.assistants[1].availability).toEqual({ ok: false, reason: "skills_access" });
    expect(body.assistants[2].availability).toEqual({ ok: false, reason: "archived" });
    expect(JSON.stringify(body)).not.toMatch(/hidden-(base|search|server|skill)/u);
    expect(decodeAssistantListResponse(body)).not.toBeNull();
  });

  it("lists recents only among listed, unarchived Assistants", async () => {
    const listed = accessEntry({ id: "assistant-listed" });
    const archived = accessEntry({ archived: true, id: "assistant-archived", owned: true });
    const loadRecentAssistantIds = vi.fn(async () => ["assistant-listed"]);
    const body = await (await createListAssistantsHandler(handlerDeps({
      listForUser: vi.fn(async () => [listed, archived]), loadRecentAssistantIds
    }))(new Request("http://test/api/me/assistants"))).json();
    expect(loadRecentAssistantIds).toHaveBeenCalledWith("user-1", ["assistant-listed"]);
    expect(body.recentAssistantIds).toEqual(["assistant-listed"]);
    expect(decodeAssistantListResponse(body)).not.toBeNull();
  });

  it("emits owner-only listing, Projects and chat counts and names the consumer's visible Knowledge", async () => {
    const listingRequest = {
      canRequest: false,
      canWithdraw: true,
      listed: false,
      request: { createdAt: "2026-09-28T00:00:00.000Z", definitionVersion: 3, id: "request-1", outdated: false,
        reviewNote: null, reviewedAt: null, state: "pending" as const }
    };
    const owner = await (await createGetAssistantHandler(handlerDeps({
      getDetail: vi.fn(async () => ({ ...accessEntry({ owned: true, content: contentRow({ skillSummaries: [] }) }),
        listingRequest, projects: { otherProjectCount: 1, projects: [{ id: "project-1", name: "Support" }] },
        publications: [], recentChatCount: 4 }))
    }))(new Request("http://test/api/me/assistants/assistant-1"), { params: { assistantId: "assistant-1" } })).json();
    expect(owner.assistant).toMatchObject({ listingRequest, projects: { otherProjectCount: 1 }, recentChatCount: 4 });
    expect(decodeAssistantDetailResponse(owner)).not.toBeNull();

    const knowledgeSelection = { baseIds: ["visible-base", "hidden-base"], mode: "explicit" as const, sourceIds: ["hidden-source"], version: 1 as const };
    const consumer = await (await createGetAssistantHandler(handlerDeps({
      getDetail: vi.fn(async () => ({ ...accessEntry({ content: contentRow({ knowledgeSelection }) }),
        publications: null, visibleKnowledge: { baseIds: ["visible-base"], sourceIds: [] } }))
    }))(new Request("http://test/api/me/assistants/assistant-1"), { params: { assistantId: "assistant-1" } })).json();
    expect(consumer.assistant.content.rows.knowledge).toEqual({
      policy: "fixed", value: { baseIds: ["visible-base"], hiddenCount: 2, mode: "explicit", sourceIds: [] }
    });
    expect(consumer.assistant.content.systemPrompt).toBe("You review code.");
    expect(consumer.assistant).not.toHaveProperty("listingRequest");
    expect(JSON.stringify(consumer)).not.toMatch(/hidden-(base|source)/u);
    expect(decodeAssistantDetailResponse(consumer)).not.toBeNull();
  });

  it("names the whole audience only to the owner and every reader's scope and update date", async () => {
    const audience = { everyone: true, groupNames: ["Design", "Support"] };
    const list = await (await createListAssistantsHandler(handlerDeps({
      listForUser: vi.fn(async () => [
        accessEntry({ audience, id: "assistant-owned", owned: true }),
        // The repository gives a consumer no audience; the handler drops one all the same.
        accessEntry({ audience, id: "assistant-shared" })
      ])
    }))(new Request("http://test/api/me/assistants"))).json();
    expect(list.assistants.map(({ audience: listed, id, scope }: AssistantSummary) => ({ audience: listed, id, scope }))).toEqual([
      { audience, id: "assistant-owned", scope: { kind: "owner" } },
      { audience: null, id: "assistant-shared", scope: { groupNames: ["Design"], kind: "group" } }
    ]);
    expect(decodeAssistantListResponse(list)).not.toBeNull();

    const detail = async (entry: AssistantAccessEntry) => (await createGetAssistantHandler(handlerDeps({
      getDetail: vi.fn(async () => ({ ...entry, publications: entry.owned ? [] : null }))
    }))(new Request("http://test/api/me/assistants/assistant-1"), { params: { assistantId: "assistant-1" } })).json();
    const owner = await detail(accessEntry({ audience, content: contentRow({ skillSummaries: [] }), owned: true }));
    expect(owner.assistant).toMatchObject({ audience, scope: { kind: "owner" }, updatedAt: "2026-08-06T00:00:00.000Z" });
    expect(decodeAssistantDetailResponse(owner)).not.toBeNull();
    const member = await detail(accessEntry({ audience, memberGroupNames: [], projectName: "Support" }));
    expect(member.assistant).toMatchObject({
      audience: null, scope: { kind: "project", projectName: "Support" }, updatedAt: "2026-08-06T00:00:00.000Z"
    });
    expect(JSON.stringify(member)).not.toContain("Design");
    expect(decodeAssistantDetailResponse(member)).not.toBeNull();
  });

  it("returns the copy with the report of downgraded rows", async () => {
    const report = { downgradedRows: ["model", "knowledge"] as AssistantRowKey[], droppedSkillCount: 2 };
    const deps = handlerDeps({
      duplicate: vi.fn(async () => ({ assistantId: "assistant-copy", kind: "ok" as const, report })),
      getDetail: vi.fn(async () => ({ ...accessEntry({ id: "assistant-copy", owned: true }), publications: [] }))
    });
    const response = await createDuplicateAssistantHandler(deps)(
      new Request("http://test/api/me/assistants/assistant-1/duplicate", { method: "POST" }),
      { params: { assistantId: "assistant-1" } }
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.report).toEqual(report);
    expect(decodeAssistantDuplicateResponse(body)).not.toBeNull();
  });
});
