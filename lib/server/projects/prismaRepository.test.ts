import { describe, expect, it } from "vitest";
import type { ProjectDefaultsWire } from "../../contracts/projects";
import { projectDefaultsProjection } from "./prismaRepository";

const configuredDefaults: ProjectDefaultsWire = {
  assistantId: "assistant-1",
  controlValues: {},
  knowledgePlan: {
    baseIds: ["base-1"],
    mode: "explicit",
    sourceIds: ["document-1"],
    version: 1
  },
  mcpMode: "auto",
  providerModelId: "model-1",
  searchPlan: { mode: "all_selected", optionIds: ["search-1"] }
};

describe("Project detail projection", () => {
  it("reports only the kinds of configured defaults hidden by current authority", () => {
    expect(projectDefaultsProjection(configuredDefaults, {
      assistantIds: new Set(),
      hasMcp: false,
      knowledgeBaseIds: new Set(),
      knowledgeSourceIds: new Set(),
      modelIds: new Set(),
      searchIds: new Set()
    })).toEqual({
      defaults: {
        ...configuredDefaults,
        assistantId: null,
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        mcpMode: "off",
        providerModelId: null,
        searchPlan: { mode: "all_selected", optionIds: [] }
      },
      unavailableDefaults: ["assistant", "knowledge", "mcp", "model", "search"]
    });

    expect(projectDefaultsProjection(configuredDefaults, {
      assistantIds: new Set(["assistant-1"]),
      hasMcp: true,
      knowledgeBaseIds: new Set(["base-1"]),
      knowledgeSourceIds: new Set(["document-1"]),
      modelIds: new Set(["model-1"]),
      searchIds: new Set(["search-1"])
    })).toEqual({ defaults: configuredDefaults, unavailableDefaults: [] });
  });

  it("treats personal or inherited Knowledge modes as unusable Project defaults", () => {
    for (const knowledgePlan of [{
      baseIds: [],
      mode: "all_my_knowledge" as const,
      sourceIds: [],
      version: 1 as const
    }, {
      baseIds: [],
      inheritedFrom: "project" as const,
      mode: "inherited" as const,
      sourceIds: [],
      version: 1 as const
    }]) {
      expect(projectDefaultsProjection({
        ...configuredDefaults,
        assistantId: null,
        knowledgePlan,
        mcpMode: "off",
        providerModelId: null,
        searchPlan: { mode: "all_selected", optionIds: [] }
      }, {
        assistantIds: new Set(),
        hasMcp: false,
        knowledgeBaseIds: new Set(),
        knowledgeSourceIds: new Set(),
        modelIds: new Set(),
        searchIds: new Set()
      })).toEqual({
        defaults: {
          assistantId: null,
          controlValues: {},
          knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
          mcpMode: "off",
          providerModelId: null,
          searchPlan: { mode: "all_selected", optionIds: [] }
        },
        unavailableDefaults: ["knowledge"]
      });
    }
  });
});
