import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_ROW_KEYS,
  type AssistantAvatarRecipe,
  type AssistantRowKey,
  type AssistantRows,
  type AssistantRunControls
} from "../../contracts/assistants";
import type { ModelParameterControls } from "../../contracts/catalog";
import {
  decodeChatAssistantProjection,
  decodeChatDetailResponse,
  type ChatAssistantOverrides,
  type ChatAssistantProjection
} from "../../contracts/chats";
import {
  loadPersonalAssistantRowContext,
  projectAssistantRowDefaults,
  type AssistantRowContextClient
} from "../assistants/rowContext";
import {
  assistantRunRowProvenance,
  materializeAssistantRowControls,
  type AssistantRowAvailableResources,
  type AssistantRowContextDefaults
} from "../assistants/rowResolution";
import type { AssistantRunMaterialization } from "../assistants/runMaterialization";
import { storedColumnsFromAssistantRows } from "../assistants/storedContent";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { admitChatAssistant, type ChatAssistantScope } from "../runs/assistantRunAdmission";
import {
  buildChatAssistantProjection,
  loadChatAssistantProjection,
  loadProjectChatAssistant,
  type ChatAssistantChainContext,
  type ChatAssistantDefinition,
  type ProjectChatAssistantLoader
} from "./assistantProjection";
import { serializeChatDetail } from "./handlers";

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

const parameterControls: ModelParameterControls = {
  background: { defaultValue: false, supported: true },
  maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
  reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
  stream: { defaultValue: false, supported: true },
  temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
};

/** model-b cannot reason and has no temperature. */
const plainControls: ModelParameterControls = {
  ...parameterControls,
  reasoningEffort: { defaultValue: "none", options: [], supported: false },
  temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
};

const SAVED: Readonly<Record<string, AssistantRunControls>> = {
  "model-a": { reasoningEffort: "low" },
  "model-default": { maxOutputTokens: 2048 }
};

const defaults: AssistantRowContextDefaults = {
  controlsForModel: (modelId) => ({ ...SAVED[modelId] }),
  knowledge: { mode: "all_my_knowledge" },
  modelId: "model-default",
  search: { mode: "all_selected", optionIds: ["web-default"] },
  tools: { mode: "auto" }
};

const available: AssistantRowAvailableResources = {
  allMyKnowledge: true,
  knowledgeBaseIds: new Set(["kb-1", "kb-2"]),
  knowledgeSourceIds: new Set(["src-1"]),
  mcpServerIds: new Set(["mcp-1", "mcp-2"]),
  modelIds: new Set(["model-a", "model-b", "model-default"]),
  searchOptionIds: new Set(["web-1", "web-2", "web-default"]),
  skillIds: new Set(["skill-1"])
};

function context(overrides: Partial<ChatAssistantChainContext> = {}): ChatAssistantChainContext {
  return {
    available,
    defaults,
    modelConnections: new Map([...available.modelIds].map((id) => [id, "connection-1"])),
    modelParameters: (modelId) => available.modelIds.has(modelId)
      ? {
          baseParams: {},
          controls: modelId === "model-b" ? plainControls : parameterControls,
          displayName: `Display ${modelId}`,
          parameterProvider: "openai"
        }
      : null,
    ...overrides
  };
}

/**
 * A Project chat's context: the Project's defaults and only the resources it
 * provides. model-b, web-2, mcp-2, kb-2, src-1 and "All my knowledge" are the
 * member's own and absent here.
 */
const projectAvailable: AssistantRowAvailableResources = {
  allMyKnowledge: false,
  knowledgeBaseIds: new Set(["kb-1"]),
  knowledgeSourceIds: new Set(),
  mcpServerIds: new Set(["mcp-1"]),
  modelIds: new Set(["model-a", "model-default"]),
  searchOptionIds: new Set(["web-1", "web-default"]),
  skillIds: new Set(["skill-1"])
};

function projectContext(): ChatAssistantChainContext {
  return context({
    available: projectAvailable,
    defaults: projectAssistantRowDefaults({
      assistantId: null,
      controlValues: { maxOutputTokens: "1024" },
      knowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 },
      mcpMode: "load_all",
      providerModelId: "model-default",
      searchPlan: { mode: "all_selected", optionIds: ["web-default"] }
    }),
    modelConnections: new Map([...projectAvailable.modelIds].map((id) => [id, "shared-connection"])),
    modelParameters: (modelId) => projectAvailable.modelIds.has(modelId)
      ? { baseParams: {}, controls: parameterControls, displayName: `Project ${modelId}`, parameterProvider: "openai" }
      : null
  });
}

type RowOverrides = Partial<{ [Key in AssistantRowKey]: Partial<AssistantRows[Key]> }>;

function rows(overrides: RowOverrides = {}): AssistantRows {
  const base: AssistantRows = {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "inherit" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  };
  return Object.fromEntries(ASSISTANT_ROW_KEYS.map((key) => [key, { ...base[key], ...overrides[key] }])) as AssistantRows;
}

function definition(overrides: Partial<ChatAssistantDefinition> = {}): ChatAssistantDefinition {
  return {
    archived: false,
    avatar,
    id: "assistant-1",
    modelDisplayName: "Retired model",
    name: "HR Helper",
    owned: false,
    ownerDisplayName: "Alex",
    rows: rows(),
    ...overrides
  };
}

function project(
  assistant: Partial<ChatAssistantDefinition> = {},
  stored: ChatAssistantOverrides = {},
  chainContext: ChatAssistantChainContext = context()
): Extract<ChatAssistantProjection, { state: "bound" }> {
  const projection = buildChatAssistantProjection({ context: chainContext, definition: definition(assistant), stored });
  // Every projection is a valid wire value.
  expect(decodeChatAssistantProjection(JSON.parse(JSON.stringify(projection)))).toEqual(projection);
  if (projection.state !== "bound") throw new Error("expected a bound projection");
  return projection;
}

describe("chat Assistant projection", () => {
  it("reports inherit rows with the user's defaults and the Assistant's own concrete values", () => {
    const projection = project({
      rows: rows({
        controls: { value: { reasoningEffort: "high" } },
        model: { policy: "fixed", value: { mode: "model", modelId: "model-a" } },
        search: { value: { mode: "off" } },
        skills: { value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "off" } },
        tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } }
      })
    });

    expect(projection).toMatchObject({
      availability: { ok: true },
      id: "assistant-1",
      name: "HR Helper",
      owned: false,
      ownerDisplayName: "Alex"
    });
    expect(projection.rows.model).toEqual({
      assistantValue: { mode: "model", modelId: "model-a" },
      deviation: null,
      policy: "fixed",
      provenance: "assistant",
      value: { mode: "model", modelId: "model-a" }
    });
    // The Assistant's controls over the user's saved values for its model.
    expect(projection.rows.controls).toMatchObject({ provenance: "assistant", value: { reasoningEffort: "high" } });
    expect(projection.rows.search).toMatchObject({ provenance: "assistant", value: { mode: "off" } });
    expect(projection.rows.tools).toMatchObject({ provenance: "assistant", value: { mode: "exact", serverIds: ["mcp-1"] } });
    expect(projection.rows.knowledge).toMatchObject({
      assistantValue: { mode: "inherit" },
      provenance: "default",
      value: { mode: "all_my_knowledge" }
    });
    expect(projection.rows.skills).toMatchObject({
      provenance: "assistant",
      value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "off" }
    });
  });

  it("reports rows changed for the chat and keeps the Assistant's value for Reset", () => {
    const projection = project({
      rows: rows({ model: { value: { mode: "model", modelId: "model-a" } } })
    }, {
      knowledge: { baseIds: ["kb-2"], mode: "explicit", sourceIds: [] },
      model: { mode: "model", modelId: "model-b" },
      search: { mode: "off" },
      skills: { mode: "off" },
      tools: { mode: "load_all" }
    });

    for (const key of ["knowledge", "model", "search", "skills", "tools"] as const) {
      expect(projection.rows[key].provenance).toBe("chat");
    }
    expect(projection.rows.model).toMatchObject({
      assistantValue: { mode: "model", modelId: "model-a" },
      value: { mode: "model", modelId: "model-b" }
    });
    expect(projection.rows.tools.value).toEqual({ mode: "load_all" });
    expect(projection.rows.knowledge.value).toEqual({ baseIds: ["kb-2"], mode: "explicit", sourceIds: [] });
    // Another model: the Assistant's controls do not apply, the user's saved ones (none) do.
    expect(projection.rows.controls).toMatchObject({ provenance: "default", value: {} });
  });

  it("ignores a stored override that admission would ignore, without changing the stored value", () => {
    const stored: ChatAssistantOverrides = {
      controls: { temperature: 0.4 },
      model: { mode: "model", modelId: "model-gone" },
      search: { mode: "off" }
    };
    const snapshot = structuredClone(stored);
    const projection = project({
      rows: rows({
        model: { value: { mode: "model", modelId: "model-a" } },
        search: { policy: "fixed", value: { mode: "all_selected", optionIds: ["web-1"] } }
      })
    }, stored);

    // A fixed row ignores the chat's value; a model that left the catalog falls
    // back to the Assistant's and takes its controls with it.
    expect(projection.rows.search).toMatchObject({ provenance: "assistant", value: { mode: "all_selected", optionIds: ["web-1"] } });
    expect(projection.rows.model).toMatchObject({ provenance: "assistant", value: { modelId: "model-a" } });
    expect(projection.rows.controls).toMatchObject({ provenance: "default", value: { reasoningEffort: "low" } });
    expect(stored).toEqual(snapshot);
  });

  it("drops stored chat controls the effective model does not support", () => {
    const projection = project({ rows: rows({ model: { value: { mode: "model", modelId: "model-b" } } }) }, {
      controls: { reasoningEffort: "high" }
    });
    expect(projection.rows.controls).toMatchObject({ provenance: "default", value: {} });
  });

  it("falls back for an unavailable adjustable value, naming it only to the owner", () => {
    const assistantRows = rows({
      model: { value: { mode: "model", modelId: "model-gone" } },
      tools: { value: { mode: "exact", serverIds: ["mcp-1", "mcp-hidden"] } }
    });
    const consumer = project({ rows: assistantRows });
    const owner = project({ owned: true, rows: assistantRows });

    expect(consumer.availability).toEqual({ ok: true });
    expect(consumer.rows.model).toEqual({
      assistantValue: { mode: "model", modelId: null },
      deviation: { reason: "model_access" },
      policy: "adjustable",
      provenance: "fallback",
      value: { mode: "model", modelId: "model-default" }
    });
    expect(consumer.rows.tools).toMatchObject({
      assistantValue: { hiddenCount: 1, mode: "exact", serverIds: ["mcp-1"] },
      deviation: { reason: "tools_access" },
      provenance: "fallback",
      value: { mode: "auto" }
    });
    expect(owner.rows.model.deviation).toEqual({
      dependencies: [{ kind: "model", name: "Retired model" }],
      reason: "model_access"
    });
    expect(owner.rows.tools.deviation).toEqual({
      dependencies: [{ kind: "mcp", name: "Required MCP tools" }],
      reason: "tools_access"
    });
    // Resources the viewer cannot use are counted, never identified, for owners too.
    for (const projection of [consumer, owner]) {
      expect(JSON.stringify(projection)).not.toMatch(/model-gone|mcp-hidden/u);
    }
  });

  it.each([
    ["model", { model: { policy: "fixed" as const, value: { mode: "model" as const, modelId: "model-gone" } } }, "model_access",
      [{ kind: "model", name: "Retired model" }]],
    ["search", { search: { policy: "fixed" as const, value: { mode: "all_selected" as const, optionIds: ["web-1", "web-gone"] } } },
      "search_access", [{ kind: "search", name: "Web search" }]],
    ["tools", { tools: { policy: "fixed" as const, value: { mode: "exact" as const, serverIds: ["mcp-gone"] } } }, "tools_access",
      [{ kind: "mcp", name: "Required MCP tools" }]],
    ["knowledge", { knowledge: { policy: "fixed" as const, value: { baseIds: ["kb-gone"], mode: "explicit" as const, sourceIds: [] } } },
      "knowledge_access", undefined],
    ["skills", { skills: { value: { links: [{ delivery: "on_demand" as const, skillId: "skill-gone" }], mode: "auto" as const } } },
      "skills_access", undefined]
  ] as const)("reports an unusable fixed %s row as an unavailable Assistant", (key, overrides, reason, dependencies) => {
    const consumer = project({ rows: rows(overrides as RowOverrides) });
    const owner = project({ owned: true, rows: rows(overrides as RowOverrides) });

    expect(consumer.availability).toEqual({ ok: false, reason });
    expect(owner.availability).toEqual({ ok: false, reason, ...(dependencies ? { dependencies } : {}) });
    // The blocked row keeps the Assistant's value, redacted; the others resolve normally.
    expect(consumer.rows[key].provenance).toBe("assistant");
    expect(consumer.rows[key].deviation).toBeNull();
    expect(JSON.stringify(consumer)).not.toMatch(/-gone/u);
    expect(consumer.rows.controls.provenance).toBe("default");
  });

  it("reports the archived state before any dependency", () => {
    const projection = project({
      archived: true,
      owned: true,
      rows: rows({ model: { policy: "fixed", value: { mode: "model", modelId: "model-gone" } } })
    });
    expect(projection.availability).toEqual({ ok: false, reason: "archived" });
  });

  it("reports a control of the Assistant that its model does not support", () => {
    const assistantRows = rows({
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-b" } }
    });
    expect(project({ rows: assistantRows }).availability).toEqual({ ok: false, reason: "model_access" });
    expect(project({ owned: true, rows: assistantRows }).availability).toEqual({
      dependencies: [{ kind: "model", name: "Display model-b" }],
      ok: false,
      reason: "model_access"
    });
  });

  it("reports a user without a usable default model with an empty model", () => {
    const projection = project({}, {}, context({ defaults: { ...defaults, modelId: "" } }));
    expect(projection.rows.model.value).toEqual({ mode: "model", modelId: null });
  });

  it("serializes into the chat detail wire", () => {
    const projection = project({ owned: true });
    const wire = JSON.parse(JSON.stringify({
      chat: serializeChatDetail({
        activeLeafMessageId: null,
        assistant: projection,
        assistantId: "assistant-1",
        contextStats: { approximateActiveBranchInputTokens: 0 },
        createdAt: "2026-09-28T00:00:00.000Z",
        defaultModelId: null,
        defaultProvider: null,
        folderId: null,
        id: "chat-1",
        messageCount: 0,
        messages: [],
        pageInfo: {
          activeLeafMessageId: null,
          beforeCursor: null,
          hasOlder: false,
          snapshotUpdatedAt: "2026-09-28T00:00:00.000Z"
        },
        pinned: false,
        title: "Chat",
        updatedAt: "2026-09-28T00:00:00.000Z",
        usageStats: null
      })
    }));
    expect(decodeChatDetailResponse(wire)?.assistant).toEqual(projection);
  });
});

/*
 * The projection and run admission must agree: for each combination below,
 * the provenance and effective value the projection reports are the ones
 * admission freezes for the next run (no request values), and an Assistant
 * the projection reports unavailable is one admission refuses.
 */
describe("chat Assistant projection and run admission", () => {
  function materialization(assistantRows: AssistantRows): AssistantRunMaterialization {
    return {
      assistantId: "assistant-1",
      definitionVersion: 1,
      identity: { avatar, name: "HR Helper" },
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      name: "HR Helper",
      provider: null,
      providerModelId: null,
      rows: assistantRows,
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: [],
      systemPrompt: "Help."
    };
  }

  async function admitted(
    assistantRows: AssistantRows,
    stored: ChatAssistantOverrides,
    scope: ChatAssistantScope = { kind: "personal" }
  ) {
    const chain = scope.kind === "project" ? projectContext() : context();
    const resolved = async () => ({ assistant: materialization(assistantRows), ok: true as const });
    const admission = await admitChatAssistant({
      assistants: scope.kind === "project"
        ? {
            resolveForProject: resolved,
            resolveForRun: async () => {
              throw new Error("a Project chat never resolves through the viewer's own access");
            }
          }
        : { resolveForRun: resolved },
      repository: scope.kind === "project"
        ? { loadProjectAssistantRowContext: async () => chain }
        : { loadAssistantRowContext: async () => chain }
    }, {
      body: {},
      scope,
      source: { assistantId: "assistant-1", bind: false, ok: true },
      storedOverrides: stored,
      userId: "user-1"
    });
    if (!admission.ok) return { refused: admission.code };
    const model = chain.modelParameters(admission.resolution.rows.model.value.modelId)!;
    const materialized = materializeAssistantRowControls(admission.resolution, {
      baseParams: model.baseParams,
      controls: model.controls,
      parameterProvider: model.parameterProvider
    });
    return materialized.ok ? { resolution: materialized.resolution } : { refused: materialized.code };
  }

  /** The projection equals what admission freezes, or both refuse the Assistant. */
  async function expectAgreement(
    assistantRows: AssistantRows,
    stored: ChatAssistantOverrides,
    scope: ChatAssistantScope = { kind: "personal" }
  ) {
    const admission = await admitted(assistantRows, stored, scope);
    const projection = project({ rows: assistantRows }, stored, scope.kind === "project" ? projectContext() : context());
    if ("refused" in admission) {
      expect(admission.refused).toMatch(/^assistant_(not_available|configuration_unavailable)$/u);
      expect(projection.availability.ok).toBe(false);
      return { projection, refused: admission.refused };
    }
    expect(projection.availability).toEqual({ ok: true });
    const provenance = assistantRunRowProvenance(admission.resolution);
    for (const key of ASSISTANT_ROW_KEYS) {
      expect(projection.rows[key].provenance, key).toBe(provenance[key]);
      expect(projection.rows[key].value, key).toEqual(admission.resolution.rows[key].value);
    }
    return { projection, refused: null };
  }

  const variants: ReadonlyArray<[string, RowOverrides, ChatAssistantOverrides]> = [];
  const mutable = variants as Array<[string, RowOverrides, ChatAssistantOverrides]>;
  const models = {
    available: { mode: "model", modelId: "model-a" },
    inherit: { mode: "inherit" },
    unavailable: { mode: "model", modelId: "model-gone" }
  } as const;
  const storedModels = {
    available: { model: { mode: "model", modelId: "model-b" } },
    none: {},
    unavailable: { model: { mode: "model", modelId: "model-gone" } },
    withControls: { controls: { temperature: 0.3 }, model: { mode: "model", modelId: "model-a" } }
  } as const;
  for (const [modelName, model] of Object.entries(models)) {
    for (const policy of ["fixed", "adjustable"] as const) {
      if (policy === "fixed" && model.mode === "inherit") continue;
      for (const [storedName, stored] of Object.entries(storedModels)) {
        for (const controls of [{}, { reasoningEffort: "high" }] as AssistantRunControls[]) {
          const controlsPolicy = policy === "fixed" && Object.keys(controls).length > 0 ? "fixed" : "adjustable";
          mutable.push([
            `model ${modelName} ${policy}, stored ${storedName}, controls ${JSON.stringify(controls)}`,
            { controls: { policy: controlsPolicy, value: controls }, model: { policy, value: model } },
            stored as ChatAssistantOverrides
          ]);
        }
      }
    }
  }
  const resourceRows: ReadonlyArray<[string, RowOverrides, ChatAssistantOverrides]> = [
    ["search plan", { search: { value: { mode: "model_choice", optionIds: ["web-1", "web-2"] } } }, { search: { mode: "off" } }],
    ["search unusable", { search: { value: { mode: "all_selected", optionIds: ["web-gone"] } } }, {}],
    ["search fixed unusable", { search: { policy: "fixed", value: { mode: "all_selected", optionIds: ["web-gone"] } } }, {}],
    ["search chat unusable", { search: { value: { mode: "off" } } }, { search: { mode: "all_selected", optionIds: ["web-gone"] } }],
    ["tools exact", { tools: { value: { mode: "exact", serverIds: ["mcp-2"] } } }, { tools: { mode: "off" } }],
    ["tools fixed", { tools: { policy: "fixed", value: { mode: "off" } } }, { tools: { mode: "load_all" } }],
    ["tools unusable", { tools: { value: { mode: "exact", serverIds: ["mcp-gone"] } } }, {}],
    ["knowledge explicit", { knowledge: { value: { baseIds: ["kb-1"], mode: "explicit", sourceIds: ["src-1"] } } },
      { knowledge: { mode: "none" } }],
    ["knowledge chat unusable", { knowledge: { value: { mode: "none" } } },
      { knowledge: { baseIds: ["kb-gone"], mode: "explicit", sourceIds: [] } }],
    ["knowledge fixed unusable", { knowledge: { policy: "fixed", value: { baseIds: ["kb-gone"], mode: "explicit", sourceIds: [] } } }, {}],
    ["skills", { skills: { value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "auto" } } }, { skills: { mode: "off" } }],
    ["skills fixed with chat mode", { skills: { policy: "fixed", value: { links: [], mode: "off" } } }, { skills: { mode: "auto" } }],
    ["skills unusable", { skills: { value: { links: [{ delivery: "always", skillId: "skill-gone" }], mode: "auto" } } }, {}],
    ["controls chat", { model: { value: { mode: "model", modelId: "model-a" } } }, { controls: { temperature: 1.5 } }],
    ["controls unsupported by the Assistant's model", {
      controls: { policy: "fixed", value: { reasoningEffort: "high" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-b" } }
    }, {}]
  ];
  mutable.push(...resourceRows);

  it("covers both admitted and refused Assistants", async () => {
    const outcomes = await Promise.all(variants.map(([, overrides, stored]) => admitted(rows(overrides), stored)));
    const refused = outcomes.filter((outcome) => "refused" in outcome).map((outcome) => (outcome as { refused: string }).refused);
    expect(new Set(refused)).toEqual(new Set(["assistant_configuration_unavailable", "assistant_not_available"]));
    expect(outcomes.length - refused.length).toBeGreaterThan(20);
  });

  it.each(variants)("agrees for %s", async (_name, overrides, stored) => {
    await expectAgreement(rows(overrides), stored);
  });

  /** Records the Knowledge and Skill ids the shared loader checks; every check finds nothing. */
  function idRecordingClient(definition: Record<string, unknown> | null = null) {
    const read: Record<"bases" | "skills" | "sources", string[]> = { bases: [], skills: [], sources: [] };
    const record = (key: keyof typeof read) => async (args: { where: { id: { in: string[] } } }) => {
      read[key].push(...args.where.id.in);
      return [];
    };
    const client: Record<string, unknown> = {
      assistantDefinition: { findUnique: async () => definition },
      knowledgeBase: { findMany: record("bases") },
      knowledgeSource: { findMany: record("sources") },
      mcpGrant: { findMany: async () => [] },
      skillDefinition: { findMany: record("skills") },
      userGroup: { findMany: async () => [] }
    };
    const sorted = () => Object.fromEntries(Object.entries(read).map(([key, ids]) => [key, [...ids].sort()]));
    return { client: client as unknown as AssistantRowContextClient, sorted };
  }

  /** The stored definition of `assistantRows`, owned by the viewer, so no publication check runs. */
  function ownedDefinitionColumns(assistantRows: AssistantRows): Record<string, unknown> {
    return {
      ...storedColumnsFromAssistantRows(assistantRows),
      archivedAt: null,
      avatar,
      id: "assistant-1",
      name: "HR Helper",
      owner: { displayName: "Alex" },
      ownerUserId: "user-1",
      providerModel: null
    };
  }

  const emptyCatalog: CatalogData = {
    entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
    models: [],
    searchStrategies: [],
    settings: { defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null, showCitations: true, showReasoningBlocks: false }
  };

  const idVariants: ReadonlyArray<[string, RowOverrides, ChatAssistantOverrides]> = [
    ...resourceRows,
    ["knowledge explicit with a stored selection", {
      knowledge: { value: { baseIds: ["kb-1", "kb-2"], mode: "explicit", sourceIds: ["src-1"] } },
      skills: { value: { links: [{ delivery: "always", skillId: "skill-1" }, { delivery: "on_demand", skillId: "skill-2" }], mode: "auto" } }
    }, { knowledge: { baseIds: ["kb-2", "kb-3"], mode: "explicit", sourceIds: ["src-2"] } }],
    ["knowledge fixed with a stored selection", {
      knowledge: { policy: "fixed", value: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [] } }
    }, { knowledge: { baseIds: ["kb-3"], mode: "explicit", sourceIds: [] } }]
  ];

  it.each(idVariants)("checks the same resource ids as admission for %s", async (_name, overrides, stored) => {
    const assistantRows = rows(overrides);
    const admission = idRecordingClient();
    await admitChatAssistant({
      assistants: { resolveForRun: async () => ({ assistant: materialization(assistantRows), ok: true as const }) },
      repository: {
        loadAssistantRowContext: (input) =>
          loadPersonalAssistantRowContext(admission.client, input, { loadCatalogData: async () => emptyCatalog })
      }
    }, {
      body: {},
      scope: { kind: "personal" },
      source: { assistantId: "assistant-1", bind: false, ok: true },
      storedOverrides: stored,
      userId: "user-1"
    });
    const projection = idRecordingClient(ownedDefinitionColumns(assistantRows));
    await expect(loadChatAssistantProjection(projection.client, {
      chat: { assistantId: "assistant-1", assistantOverrides: stored, projectId: null },
      userId: "user-1"
    }, { loadCatalogData: async () => emptyCatalog })).resolves.toMatchObject({ state: "bound" });
    expect(projection.sorted()).toEqual(admission.sorted());
  });

  it("checks each Knowledge id the rows and stored overrides name once, and every Skill link", async () => {
    const [, overrides, stored] = idVariants.find(([name]) => name === "knowledge explicit with a stored selection")!;
    const assistantRows = rows(overrides);
    const projection = idRecordingClient(ownedDefinitionColumns(assistantRows));
    await loadChatAssistantProjection(projection.client, {
      chat: { assistantId: "assistant-1", assistantOverrides: stored, projectId: null },
      userId: "user-1"
    }, { loadCatalogData: async () => emptyCatalog });
    expect(projection.sorted()).toEqual({
      bases: ["kb-1", "kb-2", "kb-3"],
      skills: ["skill-1", "skill-2"],
      sources: ["src-1", "src-2"]
    });
  });

  it("holds at most four reads in flight: the catalog, MCP, Knowledge and Skills, each one at a time", async () => {
    const [, overrides, stored] = idVariants.find(([name]) => name === "knowledge explicit with a stored selection")!;
    let inFlight = 0;
    let peak = 0;
    const reads: string[] = [];
    const read = (name: string, value: unknown) => async () => {
      reads.push(name);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    };
    const client = {
      accessGrant: { findMany: read("grants", []) },
      assistantDefinition: { findUnique: read("definition", ownedDefinitionColumns(rows(overrides))) },
      knowledgeBase: { findMany: read("bases", []) },
      knowledgeSource: { findMany: read("sources", []) },
      mcpGrant: { findMany: read("mcpGrants", []) },
      modelPolicy: { findUnique: read("modelPolicy", null) },
      providerModel: { findMany: read("models", []) },
      searchOption: { findMany: read("searchOptions", []) },
      searchPolicy: { findUnique: read("searchPolicy", null) },
      skillDefinition: { findMany: read("skills", []) },
      userGroup: { findMany: read("groups", []) },
      userSettings: { findUnique: read("settings", {
        defaultControlValues: {},
        defaultProviderModelId: null,
        defaultSearchPlan: null,
        showCitations: true,
        showReasoningBlocks: false
      }) }
    } as unknown as AssistantRowContextClient;
    await expect(loadChatAssistantProjection(client, {
      chat: { assistantId: "assistant-1", assistantOverrides: stored, projectId: null },
      userId: "user-1"
    })).resolves.toMatchObject({ state: "bound" });
    expect(peak).toBe(4);
    // The groups once, before the parallel reads; no user row and no default-Assistant check.
    expect(reads.filter((name) => name === "groups")).toHaveLength(1);
    expect(reads.slice(0, 2)).toEqual(["definition", "groups"]);
    expect(new Set(reads)).toEqual(new Set([
      "bases", "definition", "grants", "groups", "mcpGrants", "modelPolicy", "models",
      "searchOptions", "searchPolicy", "settings", "skills", "sources"
    ]));
  });

  const projectVariants: ReadonlyArray<[string, RowOverrides, ChatAssistantOverrides]> = [
    ...variants,
    ["stored All my knowledge", {}, { knowledge: { mode: "all_my_knowledge" } }],
    ["stored personal Knowledge base", {}, { knowledge: { baseIds: ["kb-2"], mode: "explicit", sourceIds: [] } }],
    ["stored personal Search source", {}, { search: { mode: "all_selected", optionIds: ["web-2"] } }],
    ["adjustable personal MCP server", { tools: { value: { mode: "exact", serverIds: ["mcp-2"] } } }, {}],
    ["fixed personal Knowledge base", { knowledge: { policy: "fixed", value: { baseIds: ["kb-2"], mode: "explicit", sourceIds: [] } } }, {}]
  ];

  it("covers both admitted and refused Assistants in a Project chat", async () => {
    const outcomes = await Promise.all(projectVariants.map(([, overrides, stored]) =>
      admitted(rows(overrides), stored, { kind: "project", projectId: "project-1" })));
    const refused = outcomes.filter((outcome) => "refused" in outcome);
    expect(refused.length).toBeGreaterThan(0);
    expect(outcomes.length - refused.length).toBeGreaterThan(20);
  });

  it.each(projectVariants)("agrees in a Project chat for %s", async (_name, overrides, stored) => {
    await expectAgreement(rows(overrides), stored, { kind: "project", projectId: "project-1" });
  });

  describe("Project chat Assistant projection", () => {
    const scope = { kind: "project", projectId: "project-1" } as const;

    it("projects a usable Assistant with the Project's defaults for inherit rows", async () => {
      const { projection } = await expectAgreement(rows({
        model: { policy: "fixed", value: { mode: "model", modelId: "model-a" } },
        tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } }
      }), {}, scope);
      expect(projection.availability).toEqual({ ok: true });
      expect(projection.rows.tools).toMatchObject({ provenance: "assistant", value: { mode: "exact", serverIds: ["mcp-1"] } });
      // Inherit means the Project's defaults, never the member's.
      expect(projection.rows.knowledge).toMatchObject({
        provenance: "default",
        value: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [] }
      });
      expect(projection.rows.search).toMatchObject({ provenance: "default", value: { mode: "all_selected", optionIds: ["web-default"] } });
      expect(projection.rows.controls).toMatchObject({ provenance: "default", value: { maxOutputTokens: 1024 } });
    });

    it("runs an adjustable row the Project lacks with the Project's default", async () => {
      const { projection } = await expectAgreement(rows({
        model: { value: { mode: "model", modelId: "model-b" } },
        search: { value: { mode: "all_selected", optionIds: ["web-2"] } }
      }), {}, scope);
      expect(projection.availability).toEqual({ ok: true });
      expect(projection.rows.model).toEqual({
        assistantValue: { mode: "model", modelId: null },
        deviation: { reason: "model_access" },
        policy: "adjustable",
        provenance: "fallback",
        value: { mode: "model", modelId: "model-default" }
      });
      expect(projection.rows.search).toMatchObject({
        assistantValue: { hiddenCount: 1, mode: "all_selected", optionIds: [] },
        deviation: { reason: "search_access" },
        provenance: "fallback",
        value: { mode: "all_selected", optionIds: ["web-default"] }
      });
      // The member's own resources are never identified in a Project chat.
      expect(JSON.stringify(projection)).not.toMatch(/model-b|web-2/u);
    });

    it("reports a fixed dependency the Project does not provide as an unavailable Assistant", async () => {
      const { projection, refused } = await expectAgreement(rows({
        tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-2"] } }
      }), {}, scope);
      expect(refused).toBe("assistant_not_available");
      expect(projection.availability).toEqual({ ok: false, reason: "tools_access" });
      expect(JSON.stringify(projection)).not.toContain("mcp-2");
    });

    /** A client that answers the Project read and fails on any other statement. */
    function projectClient() {
      const findUnique = vi.fn(async () => null);
      const client = new Proxy({ project: { findUnique } }, {
        get: (target, property) => {
          if (property in target) return target[property as keyof typeof target];
          throw new Error(`unexpected database access: ${String(property)}`);
        }
      }) as unknown as AssistantRowContextClient;
      return { client, findUnique };
    }

    it("projects the Assistant of a Project it cannot read as unavailable, reading only the Project", async () => {
      // The Project read carries the bound definitions; the binding is never read on its own.
      const { client, findUnique } = projectClient();
      await expect(loadChatAssistantProjection(client, {
        chat: { assistantId: "assistant-1", assistantOverrides: { tools: { mode: "off" } }, projectId: "project-1" },
        userId: "member-1"
      }, { loadProjectChatAssistant })).resolves.toEqual({ state: "unavailable" });
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "project-1" } }));
    });

    it("adds no statement for an unbound Project chat or the deletion marker", async () => {
      const { client, findUnique } = projectClient();
      await expect(loadChatAssistantProjection(client, {
        chat: { assistantId: null, assistantOverrides: null, projectId: "project-1" },
        userId: "member-1"
      }, { loadProjectChatAssistant })).resolves.toBeNull();
      await expect(loadChatAssistantProjection(client, {
        chat: { assistantId: null, assistantOverrides: { assistantDeleted: true }, projectId: "project-1" },
        userId: "member-1"
      }, { loadProjectChatAssistant })).resolves.toEqual({ state: "deleted" });
      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});

describe("chat Assistant projection loading", () => {
  /** Any database access fails the test: these chats must add no statement. */
  const noStatements = new Proxy({}, {
    get: (_target, property) => {
      throw new Error(`unexpected database access: ${String(property)}`);
    }
  }) as AssistantRowContextClient;

  it("adds no statement for a chat without a binding, the deletion marker or a Project chat", async () => {
    await expect(loadChatAssistantProjection(noStatements, {
      chat: { assistantId: null, assistantOverrides: null, projectId: null },
      userId: "user-1"
    })).resolves.toBeNull();
    await expect(loadChatAssistantProjection(noStatements, {
      chat: { assistantId: null, assistantOverrides: { assistantDeleted: true }, projectId: null },
      userId: "user-1"
    })).resolves.toEqual({ state: "deleted" });
    await expect(loadChatAssistantProjection(noStatements, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: "project-1" },
      userId: "user-1"
    })).resolves.toBeNull();
  });

  it("resolves a Project chat only through the Project loader", async () => {
    const loadProjectChatAssistant = vi.fn<ProjectChatAssistantLoader>(async () => ({
      context: context(),
      definition: definition()
    }));
    const projection = await loadChatAssistantProjection(noStatements, {
      chat: { assistantId: "assistant-1", assistantOverrides: { tools: { mode: "off" } }, projectId: "project-1" },
      userId: "user-1"
    }, { loadProjectChatAssistant });
    expect(loadProjectChatAssistant.mock.calls[0]?.[0]).toBe(noStatements);
    expect(loadProjectChatAssistant.mock.calls[0]?.[1]).toEqual({
      assistantId: "assistant-1",
      projectId: "project-1",
      stored: { tools: { mode: "off" } },
      userId: "user-1"
    });
    expect(projection).toMatchObject({ rows: { tools: { provenance: "chat" } }, state: "bound" });
    loadProjectChatAssistant.mockResolvedValueOnce(null);
    await expect(loadChatAssistantProjection(noStatements, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: "project-1" },
      userId: "user-1"
    }, { loadProjectChatAssistant })).resolves.toEqual({ state: "unavailable" });
    // Members see an archived Project Assistant as archived, and nothing else about it.
    loadProjectChatAssistant.mockResolvedValueOnce({ context: context(), definition: definition({ archived: true }) });
    await expect(loadChatAssistantProjection(noStatements, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: "project-1" },
      userId: "user-1"
    }, { loadProjectChatAssistant })).resolves.toEqual({ reason: "archived", state: "unavailable" });
  });

  const catalog: CatalogData = {
    entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
    models: [],
    searchStrategies: [],
    settings: {
      defaultControlValues: {},
      defaultProviderModelId: null,
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false
    }
  };

  function storedDefinition(overrides: Partial<{ archivedAt: Date | null; ownerUserId: string }> = {}) {
    return {
      archivedAt: null,
      avatar,
      controlsPolicy: "adjustable",
      id: "assistant-1",
      knowledgePolicy: "adjustable",
      knowledgeSelection: { mode: "inherit" },
      mcpMode: "off",
      mcpServerIds: [],
      modelPolicy: "adjustable",
      name: "HR Helper",
      owner: { displayName: "Alex" },
      ownerUserId: "owner-1",
      providerModel: null,
      providerModelId: null,
      runControls: {},
      searchPlan: { mode: "off" },
      searchPolicy: "adjustable",
      skillLinks: [],
      skillsMode: "auto",
      skillsPolicy: "adjustable",
      toolsPolicy: "adjustable",
      ...overrides
    };
  }

  function fakeClient(input: { available: boolean; definition: ReturnType<typeof storedDefinition> | null }) {
    const calls: string[] = [];
    const record = <T>(name: string, value: T) => async () => {
      calls.push(name);
      return value;
    };
    const client: Record<string, unknown> = {
      $queryRaw: record("availability", input.available ? [{ id: "assistant-1" }] : []),
      assistantDefinition: { findUnique: record("definition", input.definition) },
      mcpGrant: { findMany: record("mcpGrants", []) },
      userGroup: { findMany: record("groups", []) }
    };
    return { calls, client: client as unknown as AssistantRowContextClient };
  }

  it("resolves the definition as run admission does and reads the chain context once", async () => {
    const consumer = fakeClient({ available: true, definition: storedDefinition() });
    const loadCatalogData = vi.fn(async () => catalog);
    await expect(loadChatAssistantProjection(consumer.client, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: null },
      userId: "user-1"
    }, { loadCatalogData })).resolves.toMatchObject({ availability: { ok: true }, owned: false, state: "bound" });
    // The groups are read once, for MCP and Knowledge alike.
    expect(consumer.calls).toEqual(["definition", "availability", "groups", "mcpGrants"]);
    expect(loadCatalogData).toHaveBeenCalledTimes(1);

    const owner = fakeClient({ available: false, definition: storedDefinition({ archivedAt: new Date(), ownerUserId: "user-1" }) });
    await expect(loadChatAssistantProjection(owner.client, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: null },
      userId: "user-1"
    }, { loadCatalogData })).resolves.toMatchObject({ availability: { ok: false, reason: "archived" }, owned: true });
    // The owner needs no publication check.
    expect(owner.calls).toEqual(["definition", "groups", "mcpGrants"]);
  });

  it("tells a consumer who still has an Assistant only that its owner archived it", async () => {
    const consumer = fakeClient({ available: true, definition: storedDefinition({ archivedAt: new Date() }) });
    const loadCatalogData = vi.fn(async () => catalog);
    await expect(loadChatAssistantProjection(consumer.client, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: null },
      userId: "user-1"
    }, { loadCatalogData })).resolves.toEqual({ reason: "archived", state: "unavailable" });
    // No chain context is read for it.
    expect(consumer.calls).toEqual(["definition", "availability"]);
    expect(loadCatalogData).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null, true],
    ["no longer published", storedDefinition(), false],
    ["archived and no longer published", storedDefinition({ archivedAt: new Date() }), false]
  ] as const)("reports an Assistant the viewer cannot resolve (%s) without identity", async (_name, stored, isAvailable) => {
    const { client } = fakeClient({ available: isAvailable, definition: stored });
    await expect(loadChatAssistantProjection(client, {
      chat: { assistantId: "assistant-1", assistantOverrides: { tools: { mode: "off" } }, projectId: null },
      userId: "user-1"
    }, { loadCatalogData: async () => catalog })).resolves.toEqual({ state: "unavailable" });
  });

  it("reports a user without a settings row as unable to resolve the Assistant", async () => {
    const { client } = fakeClient({ available: true, definition: storedDefinition() });
    await expect(loadChatAssistantProjection(client, {
      chat: { assistantId: "assistant-1", assistantOverrides: null, projectId: null },
      userId: "user-1"
    }, { loadCatalogData: async () => null })).resolves.toEqual({ state: "unavailable" });
  });
});
