import { describe, expect, it } from "vitest";
import type { AssistantRows } from "../../contracts/assistants";
import type { AssistantRowAvailableResources } from "../assistants/rowResolution";
import {
  projectAssistantAvailability,
  projectAssistantDependencies,
  projectAssistantEntryRows
} from "./assistantAvailability";

function rows(policy: "adjustable" | "fixed"): AssistantRows {
  return {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy, value: { baseIds: ["base-1"], mode: "explicit", sourceIds: ["document-1"] } },
    model: { policy, value: { mode: "model", modelId: "model-1" } },
    search: { policy, value: { mode: "all_selected", optionIds: ["search-1"] } },
    skills: { policy, value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "auto" } },
    tools: { policy, value: { mode: "exact", serverIds: ["mcp-1"] } }
  };
}

function provided(overrides: Partial<AssistantRowAvailableResources> = {}): AssistantRowAvailableResources {
  return {
    allMyKnowledge: false,
    knowledgeBaseIds: new Set(["base-1"]),
    knowledgeSourceIds: new Set(["document-1"]),
    mcpServerIds: new Set(["mcp-1"]),
    modelIds: new Set(["model-1"]),
    searchOptionIds: new Set(["search-1"]),
    skillIds: new Set(["skill-1"]),
    ...overrides
  };
}

const nothing = {
  knowledgeBaseIds: new Set<string>(),
  knowledgeSourceIds: new Set<string>(),
  mcpServerIds: new Set<string>(),
  modelIds: new Set<string>(),
  searchOptionIds: new Set<string>()
};

describe("Project Assistant dependencies", () => {
  it("counts the resources of fixed rows and every Skill link", () => {
    expect(projectAssistantDependencies(rows("fixed"))).toEqual({
      knowledgeBaseIds: ["base-1"],
      knowledgeSourceIds: ["document-1"],
      mcpServerIds: ["mcp-1"],
      modelId: "model-1",
      searchOptionIds: ["search-1"],
      skillIds: ["skill-1"]
    });
  });

  it("leaves adjustable and inherited rows out of the plan", () => {
    expect(projectAssistantDependencies(rows("adjustable"))).toEqual({
      knowledgeBaseIds: [],
      knowledgeSourceIds: [],
      mcpServerIds: [],
      modelId: null,
      searchOptionIds: [],
      skillIds: ["skill-1"]
    });
    const inherited: AssistantRows = {
      ...rows("adjustable"),
      knowledge: { policy: "adjustable", value: { mode: "inherit" } },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    };
    expect(projectAssistantDependencies(inherited)).toEqual({
      knowledgeBaseIds: [],
      knowledgeSourceIds: [],
      mcpServerIds: [],
      modelId: null,
      searchOptionIds: [],
      skillIds: []
    });
  });
});

describe("Project Assistant availability", () => {
  it("is available when the Project provides every fixed resource and Skill link", () => {
    expect(projectAssistantAvailability(rows("fixed"), provided())).toEqual({
      availability: { ok: true },
      rowAvailability: {}
    });
  });

  it("reports each missing fixed resource or Skill link neutrally", () => {
    const cases: Array<[Partial<AssistantRowAvailableResources>, string]> = [
      [{ modelIds: new Set() }, "model_access"],
      [{ searchOptionIds: new Set() }, "search_access"],
      [{ mcpServerIds: new Set() }, "tools_access"],
      [{ knowledgeSourceIds: new Set() }, "knowledge_access"],
      [{ skillIds: new Set() }, "skills_access"]
    ];
    for (const [missing, reason] of cases) {
      expect(projectAssistantAvailability(rows("fixed"), provided(missing))).toEqual({
        availability: { ok: false, reason },
        rowAvailability: {}
      });
    }
  });

  it("stays available when only adjustable resources are missing and names the rows that fall back", () => {
    expect(projectAssistantAvailability(rows("adjustable"), provided(nothing))).toEqual({
      availability: { ok: true },
      rowAvailability: {
        knowledge: { reason: "knowledge_access" },
        model: { reason: "model_access" },
        search: { reason: "search_access" },
        tools: { reason: "tools_access" }
      }
    });
    // Skill links are required whatever their policy.
    expect(projectAssistantAvailability(rows("adjustable"), provided({ ...nothing, skillIds: new Set() })))
      .toMatchObject({ availability: { ok: false, reason: "skills_access" } });
  });
});

describe("Project composer entry rows", () => {
  it("never identifies a personal model, MCP server or Knowledge base named by an adjustable row", () => {
    const personal: AssistantRows = {
      ...rows("adjustable"),
      knowledge: { policy: "adjustable", value: { baseIds: ["base-1", "personal-base"], mode: "explicit", sourceIds: ["personal-document"] } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "personal-model" } },
      search: { policy: "adjustable", value: { mode: "all_selected", optionIds: ["personal-search"] } },
      tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-1", "personal-mcp"] } }
    };
    const entry = projectAssistantEntryRows(personal, provided());

    expect(entry.rows.model.value).toEqual({ mode: "model", modelId: null });
    expect(entry.rows.tools.value).toEqual({ hiddenCount: 1, mode: "exact", serverIds: ["mcp-1"] });
    expect(entry.rows.knowledge.value).toEqual({ baseIds: ["base-1"], hiddenCount: 2, mode: "explicit", sourceIds: [] });
    expect(entry.rows.search.value).toEqual({ hiddenCount: 1, mode: "all_selected", optionIds: [] });
    expect(entry.flat).toMatchObject({
      knowledgeSelection: { baseIds: ["base-1"], mode: "explicit", sourceIds: [] },
      mcpServerIds: ["mcp-1"],
      providerModelId: null
    });
    expect(JSON.stringify(entry)).not.toMatch(/personal-/u);
    // Policies and the Project's own resources are kept as they are.
    expect(projectAssistantEntryRows(rows("fixed"), provided())).toEqual({
      flat: expect.objectContaining({ mcpServerIds: ["mcp-1"], providerModelId: "model-1" }),
      rows: rows("fixed")
    });
  });
});
