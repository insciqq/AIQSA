import { describe, expect, it } from "vitest";
import type { CatalogWireModel } from "../../contracts/catalog";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import type { McpRunPlanRecord } from "../mcp/runPlan";
import type { AssistantRows, AssistantRunControls } from "../../contracts/assistants";
import type { SearchPlan } from "../../contracts/search";
import {
  assistantRowCatalogFailures,
  assistantRowsForCopier,
  emptyAssistantCatalogView,
  firstAssistantCatalogFailure,
  type AssistantCatalogView,
  type AssistantMcpRunnability
} from "./catalogValidation";

/** The flat configuration of the former editor, as concrete rows. */
function validateAssistantConfigurationAgainstCatalog(
  configuration: { mcpServerIds: string[]; providerModelId: string; runControls: AssistantRunControls; searchPlan: SearchPlan },
  view: AssistantCatalogView,
  options: { mcpRunnability: AssistantMcpRunnability }
) {
  return firstAssistantCatalogFailure(assistantRowCatalogFailures({
    controls: configuration.runControls,
    model: { mode: "model", modelId: configuration.providerModelId },
    search: configuration.searchPlan.optionIds.length > 0
      ? { mode: configuration.searchPlan.mode, optionIds: [...configuration.searchPlan.optionIds] }
      : { mode: "off" },
    tools: configuration.mcpServerIds.length > 0
      ? { mode: "exact", serverIds: configuration.mcpServerIds }
      : { mode: "off" }
  }, view, options));
}

function model(
  searchOptionCompatibility: CatalogWireModel["searchOptionCompatibility"] = {}
): CatalogWireModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true,
      text: true,
      toolCalling: true
    },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: "Assistant model",
    modelId: "model-1",
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4_096, maxValue: 128_000 },
      reasoningEffort: { defaultValue: "medium", options: [], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "connection-1",
    providerFamily: "openai_compatible",
    searchOptionCompatibility,
    searchStrategyIds: Object.keys(searchOptionCompatibility),
    upstreamModelId: "upstream-model-1"
  };
}

function record(
  serverId: string,
  toolCount: number,
  overrides: Partial<McpRunPlanRecord> = {}
): McpRunPlanRecord {
  return {
    credentialSources: [],
    enabled: true,
    errorCode: null,
    externalAccountLabel: null,
    fingerprint: `fingerprint-${serverId}`,
    generationId: `generation-${serverId}`,
    inventory: {
      tools: Array.from({ length: toolCount }, (_, index) => ({
        definitionHash: "0".repeat(64),
        description: null,
        inputSchema: { type: "object" },
        name: `tool-${index}`
      })),
      version: 1
    },
    inventoryUpdatedAt: new Date("2026-08-07T10:00:00.000Z"),
    namespace: serverId,
    readiness: "ready",
    revisionId: `revision-${serverId}`,
    serverId,
    serverName: serverId,
    ...overrides
  };
}

function configuration(overrides: {
  mcpServerIds?: string[];
  optionIds?: string[];
} = {}) {
  return {
    mcpServerIds: overrides.mcpServerIds ?? [],
    providerModelId: "model-1",
    runControls: {},
    searchPlan: {
      mode: "all_selected" as const,
      optionIds: overrides.optionIds ?? []
    }
  };
}

describe("Assistant catalog validation", () => {
  it("returns the exact invalid run-control field and model limit", () => {
    const catalogModel = model();
    const view = {
      accessibleMcpServerIds: new Set<string>(),
      entitledSearchOptionIds: new Set<string>(),
      mcpRunPlan: {
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map()
      },
      modelById: new Map([[catalogModel.modelId, catalogModel]])
    } satisfies AssistantCatalogView;

    expect(validateAssistantConfigurationAgainstCatalog(
      { ...configuration(), runControls: { maxOutputTokens: 128_001 } },
      view,
      { mcpRunnability: "accessible" }
    )).toEqual({
      control: "maxOutputTokens",
      kind: "run_controls",
      limit: 128_000
    });
  });

  it.each(["idle", "queued", "starting", "ready", "restarting"] as const)(
    "treats enabled %s MCP as startable before exact admission",
    (readiness) => {
      const selected = record("mcp-1", 1, { readiness });
      const view = {
        accessibleMcpServerIds: new Set([selected.serverId]),
        entitledSearchOptionIds: new Set<string>(),
        mcpRunPlan: {
          isGenerationLive: () => readiness === "ready",
          now: new Date("2026-08-07T10:00:00.000Z"),
          recordsByServerId: new Map([[selected.serverId, selected]])
        },
        modelById: new Map([["model-1", model()]])
      } satisfies AssistantCatalogView;

      expect(validateAssistantConfigurationAgainstCatalog(
        configuration({ mcpServerIds: [selected.serverId] }),
        view,
        { mcpRunnability: "startable" }
      )).toBeNull();
    }
  );

  it.each([
    "authorizing",
    "disabled",
    "needs_authorization",
    "needs_setup",
    "reauthorization_required",
    "unavailable"
  ] as const)(
    "rejects %s MCP from the startable availability projection",
    (readiness) => {
      const selected = record("mcp-1", 1, {
        enabled: readiness !== "disabled",
        readiness
      });
      const view = {
        accessibleMcpServerIds: new Set([selected.serverId]),
        entitledSearchOptionIds: new Set<string>(),
        mcpRunPlan: {
          isGenerationLive: () => false,
          now: new Date("2026-08-07T10:00:00.000Z"),
          recordsByServerId: new Map([[selected.serverId, selected]])
        },
        modelById: new Map([["model-1", model()]])
      } satisfies AssistantCatalogView;

      expect(validateAssistantConfigurationAgainstCatalog(
        configuration({ mcpServerIds: [selected.serverId] }),
        view,
        { mcpRunnability: "startable" }
      )).toBe("tools");
    }
  );

  it("keeps exact admission stricter than startable availability", () => {
    const selected = record("mcp-1", 1, {
      generationId: null,
      readiness: "idle"
    });
    const view = {
      accessibleMcpServerIds: new Set([selected.serverId]),
      entitledSearchOptionIds: new Set<string>(),
      mcpRunPlan: {
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map([[selected.serverId, selected]])
      },
      modelById: new Map([["model-1", model()]])
    } satisfies AssistantCatalogView;

    expect(validateAssistantConfigurationAgainstCatalog(
      configuration({ mcpServerIds: [selected.serverId] }),
      view,
      { mcpRunnability: "startable" }
    )).toBeNull();
    expect(validateAssistantConfigurationAgainstCatalog(
      configuration({ mcpServerIds: [selected.serverId] }),
      view,
      { mcpRunnability: "exact" }
    )).toBe("tools");
  });

  it("rejects Search plus MCP when the selected option has no client-tool-compatible route", () => {
    const catalogModel = model({
      "hosted-only": {
        clientToolCompatible: false,
        executionModes: ["model_choice"]
      }
    } as CatalogWireModel["searchOptionCompatibility"]);
    const view = {
      accessibleMcpServerIds: new Set(["mcp-1"]),
      entitledSearchOptionIds: new Set(["hosted-only"]),
      mcpRunPlan: {
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map()
      },
      modelById: new Map([[catalogModel.modelId, catalogModel]]),
    } satisfies AssistantCatalogView;

    expect(validateAssistantConfigurationAgainstCatalog(
      {
        ...configuration({ mcpServerIds: ["mcp-1"], optionIds: ["hosted-only"] }),
        searchPlan: { mode: "model_choice", optionIds: ["hosted-only"] }
      },
      view,
      { mcpRunnability: "accessible" }
    )).toBe("search");

  });

  it("rejects a multi-source model-choice plan without a complete route assignment", () => {
    const catalogModel = model({
      "hosted-a": {
        clientToolCompatible: false,
        executionModes: ["model_choice"]
      },
      "hosted-b": {
        clientToolCompatible: false,
        executionModes: ["model_choice"]
      }
    });
    const view = {
      accessibleMcpServerIds: new Set<string>(),
      entitledSearchOptionIds: new Set(["hosted-a", "hosted-b"]),
      mcpRunPlan: {
        isGenerationLive: () => false,
        now: new Date("2026-08-07T10:00:00.000Z"),
        recordsByServerId: new Map()
      },
      modelById: new Map([[catalogModel.modelId, catalogModel]])
    } satisfies AssistantCatalogView;

    expect(validateAssistantConfigurationAgainstCatalog(
      {
        ...configuration({ optionIds: ["hosted-a", "hosted-b"] }),
        searchPlan: {
          mode: "model_choice",
          optionIds: ["hosted-a", "hosted-b"]
        }
      },
      view,
      { mcpRunnability: "accessible" }
    )).toBe("search");

    const completeModel = model({
      "hosted-a": {
        clientToolCompatible: false,
        executionModes: ["model_choice"]
      },
      "client-b": {
        clientToolCompatible: true,
        executionModes: ["model_choice"]
      }
    });
    expect(validateAssistantConfigurationAgainstCatalog(
      {
        ...configuration({ optionIds: ["hosted-a", "client-b"] }),
        searchPlan: {
          mode: "model_choice",
          optionIds: ["hosted-a", "client-b"]
        }
      },
      {
        ...view,
        entitledSearchOptionIds: new Set(["hosted-a", "client-b"]),
        modelById: new Map([[completeModel.modelId, completeModel]])
      },
      { mcpRunnability: "accessible" }
    )).toBeNull();
  });

  it("rejects an exact MCP subset whose combined inventory exceeds run-plan limits", () => {
    const toolsPerServer = Math.floor(MCP_RUN_PLAN_LIMITS.maxTools / 2) + 1;
    const records = [
      record("mcp-a", toolsPerServer),
      record("mcp-b", toolsPerServer)
    ];
    const view = {
      accessibleMcpServerIds: new Set(records.map(({ serverId }) => serverId)),
      entitledSearchOptionIds: new Set<string>(),
      mcpRunPlan: {
        isGenerationLive: () => true,
        now: new Date("2026-08-07T10:01:00.000Z"),
        recordsByServerId: new Map(records.map((entry) => [entry.serverId, entry]))
      },
      modelById: new Map([["model-1", model()]]),
    } satisfies AssistantCatalogView;

    expect(validateAssistantConfigurationAgainstCatalog(
      configuration({ mcpServerIds: records.map(({ serverId }) => serverId) }),
      view,
      { mcpRunnability: "exact" }
    )).toBe("tools");
  });

  it("needs no catalog entry for inherit, Off and None and checks Search entitlement without a model", () => {
    const view = {
      accessibleMcpServerIds: new Set<string>(),
      entitledSearchOptionIds: new Set(["entitled"]),
      mcpRunPlan: { isGenerationLive: () => false, now: new Date("2026-08-07T10:00:00.000Z"), recordsByServerId: new Map() },
      modelById: new Map<string, CatalogWireModel>()
    } satisfies AssistantCatalogView;
    const options = { mcpRunnability: "startable" as const };
    expect(assistantRowCatalogFailures({
      controls: { temperature: 0.4 }, model: { mode: "inherit" }, search: { mode: "inherit" }, tools: { mode: "inherit" }
    }, view, options)).toEqual({});
    expect(assistantRowCatalogFailures({
      controls: {}, model: { mode: "inherit" }, search: { mode: "all_selected", optionIds: ["entitled"] }, tools: { mode: "off" }
    }, view, options)).toEqual({});
    expect(assistantRowCatalogFailures({
      controls: {}, model: { mode: "model", modelId: "hidden-model" },
      search: { mode: "all_selected", optionIds: ["entitled", "hidden"] },
      tools: { mode: "exact", serverIds: ["hidden-server"] }
    }, view, options)).toEqual({ model: true, search: true, tools: true });
  });
});

describe("Assistant rows for a copier", () => {
  const view = {
    accessibleMcpServerIds: new Set(["mcp-1"]),
    entitledSearchOptionIds: new Set(["web"]),
    mcpRunPlan: { isGenerationLive: () => false, now: new Date("2026-08-07T10:00:00.000Z"), recordsByServerId: new Map() },
    modelById: new Map([["model-1", model({ web: { clientToolCompatible: true, executionModes: ["all_selected"] } })]])
  } satisfies AssistantCatalogView;

  function rows(overrides: Partial<AssistantRows> = {}): AssistantRows {
    return {
      controls: { policy: "fixed", value: { temperature: 0.5 } },
      knowledge: { policy: "fixed", value: { baseIds: ["base-1"], mode: "explicit", sourceIds: [] } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "all_selected", optionIds: ["web"] } },
      skills: { policy: "fixed", value: { links: [
        { delivery: "always", skillId: "skill-usable" }, { delivery: "on_demand", skillId: "skill-private" }
      ], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } },
      ...overrides
    };
  }

  it("keeps every row the copier can use", () => {
    const source = rows({ skills: { policy: "fixed", value: { links: [{ delivery: "always", skillId: "skill-usable" }], mode: "off" } } });
    expect(assistantRowsForCopier(source, view, { knowledge: true, skillIds: new Set(["skill-usable"]) }))
      .toEqual({ report: { downgradedRows: [], droppedSkillCount: 0 }, rows: source });
  });

  it("downgrades unusable rows to adjustable inherit or None and drops unusable Skills", () => {
    const copied = assistantRowsForCopier(rows({
      model: { policy: "fixed", value: { mode: "model", modelId: "hidden-model" } },
      search: { policy: "fixed", value: { mode: "all_selected", optionIds: ["web", "hidden-search"] } }
    }), view, { knowledge: false, skillIds: new Set(["skill-usable"]) });
    expect(copied.report).toEqual({ downgradedRows: ["model", "controls", "search", "knowledge"], droppedSkillCount: 1 });
    expect(copied.rows).toEqual({
      controls: { policy: "adjustable", value: {} },
      knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "fixed", value: { links: [{ delivery: "always", skillId: "skill-usable" }], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } }
    });
  });

  it("copies for a copier without any catalog by downgrading every concrete row", () => {
    const empty = emptyAssistantCatalogView(new Date("2026-08-07T10:00:00.000Z"));
    const copied = assistantRowsForCopier(rows(), empty, { knowledge: false, skillIds: new Set() });
    expect(copied.report).toEqual({
      downgradedRows: ["model", "controls", "search", "tools", "knowledge"],
      droppedSkillCount: 2
    });
    expect(copied.rows.model).toEqual({ policy: "adjustable", value: { mode: "inherit" } });
    const inherit = rows({
      controls: { policy: "adjustable", value: {} },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    });
    expect(assistantRowsForCopier(inherit, empty, { knowledge: false, skillIds: new Set() }).report)
      .toEqual({ downgradedRows: ["knowledge"], droppedSkillCount: 0 });
  });

  it("resets tools before judging a Search plan that only fails next to MCP", () => {
    const hostedModel = model({ hosted: { clientToolCompatible: false, executionModes: ["all_selected"] } });
    const copied = assistantRowsForCopier(rows({
      search: { policy: "fixed", value: { mode: "all_selected", optionIds: ["hosted"] } },
      tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["hidden-server"] } }
    }), { ...view, entitledSearchOptionIds: new Set(["hosted"]), modelById: new Map([["model-1", hostedModel]]) },
    { knowledge: true, skillIds: new Set(["skill-usable", "skill-private"]) });
    expect(copied.report).toEqual({ downgradedRows: ["tools"], droppedSkillCount: 0 });
    expect(copied.rows.search).toEqual({ policy: "fixed", value: { mode: "all_selected", optionIds: ["hosted"] } });
  });
});
