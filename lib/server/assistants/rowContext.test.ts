import { describe, expect, it } from "vitest";
import { defaultProviderModels } from "../../domain/catalog";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { assistantRowsFromLegacyFields, type AssistantRows } from "../../contracts/assistants";
import type { ChatAssistantOverrides } from "../../contracts/chats";
import { nextChatAssistantOverrides } from "../chats/assistantOverrides";
import { personalAssistantRowDefaults, projectAssistantRowDefaults, storedOverridesInEffect } from "./rowContext";

const key = "openai:gpt-5.5";

function catalogData(input: Partial<CatalogData["settings"]> & {
  allowed?: boolean;
  modelPolicy?: CatalogData["modelPolicy"];
} = {}): CatalogData {
  const { allowed = true, modelPolicy = null, ...settings } = input;
  return {
    entitlements: { modelKeys: new Set(allowed ? [key] : []), providerKeys: new Set(), searchStrategies: new Set() },
    modelPolicy,
    models: defaultProviderModels,
    searchStrategies: [],
    settings: {
      defaultControlValues: {},
      defaultProviderModelId: null,
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false,
      ...settings
    }
  };
}

describe("personal Assistant row defaults", () => {
  it("uses the organization default model and its reasoning default", () => {
    const { defaults, modelConnections, modelIds } = personalAssistantRowDefaults(catalogData({
      modelPolicy: { defaultProviderModelId: "gpt-5.5", reasoningEffort: "high" }
    }));

    expect(defaults.modelId).toBe("gpt-5.5");
    expect(modelConnections.get("gpt-5.5")).toBe("openai");
    expect(modelIds).toEqual(new Set(["gpt-5.5"]));
    expect(defaults.controlsForModel("gpt-5.5")).toEqual({ reasoningEffort: "high" });
  });

  it("reads the user's Chat defaults and saved values in chain vocabulary", () => {
    const { defaults } = personalAssistantRowDefaults(catalogData({
      defaultControlValues: { [key]: { maxOutputTokens: "1000", temperature: "0.5" } },
      defaultKnowledgePlan: { baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1 },
      defaultMcpMode: "load_all",
      defaultProviderModelId: "gpt-5.5"
    }));

    expect(defaults.modelId).toBe("gpt-5.5");
    expect(defaults.controlsForModel("gpt-5.5")).toEqual({ maxOutputTokens: 1000, temperature: 0.5 });
    expect(defaults.knowledge).toEqual({ baseIds: ["base-1"], mode: "explicit", sourceIds: [] });
    expect(defaults.tools).toEqual({ mode: "load_all" });
    expect(defaults.search).toEqual({ mode: "off" });
  });

  it("reads undecodable saved values and unusable models as none", () => {
    const { defaults, modelIds } = personalAssistantRowDefaults(catalogData({
      allowed: false,
      defaultControlValues: { [key]: { unknownControl: "1" } },
      defaultProviderModelId: "gpt-5.5"
    }));

    expect(modelIds.size).toBe(0);
    expect(defaults.modelId).toBe("");
    expect(defaults.controlsForModel("gpt-5.5")).toEqual({});
    expect(defaults.knowledge).toEqual({ mode: "none" });
    expect(defaults.tools).toEqual({ mode: "auto" });

    const invalid = personalAssistantRowDefaults(catalogData({
      defaultControlValues: { [key]: { unknownControl: "1" } },
      defaultProviderModelId: "gpt-5.5"
    }));
    expect(invalid.defaults.controlsForModel("gpt-5.5")).toEqual({});
  });
});

describe("Project Assistant row defaults", () => {
  it("reads the Project's own defaults and saved values in chain vocabulary", () => {
    const defaults = projectAssistantRowDefaults({
      assistantId: "assistant-1",
      controlValues: { maxOutputTokens: "2048", reasoningEffort: "low" },
      knowledgePlan: { baseIds: ["project-base"], mode: "explicit", sourceIds: ["project-document"], version: 1 },
      mcpMode: "load_all",
      providerModelId: "project-model",
      searchPlan: { mode: "all_selected", optionIds: ["project-search"] }
    });

    expect(defaults.modelId).toBe("project-model");
    // The Project's saved values apply to whichever model runs, as in an ordinary Project chat.
    expect(defaults.controlsForModel("project-model")).toEqual({ maxOutputTokens: 2048, reasoningEffort: "low" });
    expect(defaults.controlsForModel("other-model")).toEqual({ maxOutputTokens: 2048, reasoningEffort: "low" });
    expect(defaults.knowledge).toEqual({ baseIds: ["project-base"], mode: "explicit", sourceIds: ["project-document"] });
    expect(defaults.search).toEqual({ mode: "all_selected", optionIds: ["project-search"] });
    expect(defaults.tools).toEqual({ mode: "load_all" });
  });

  it("reads a Project without a default model, Search or saved values as none", () => {
    const defaults = projectAssistantRowDefaults({
      assistantId: null,
      controlValues: { unknownControl: "1" },
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpMode: "off",
      providerModelId: null,
      searchPlan: { mode: "all_selected", optionIds: [] }
    });

    expect(defaults.modelId).toBe("");
    expect(defaults.controlsForModel("any-model")).toEqual({});
    expect(defaults.knowledge).toEqual({ mode: "none" });
    expect(defaults.search).toEqual({ mode: "off" });
    expect(defaults.tools).toEqual({ mode: "off" });
  });
});

describe("stored overrides in effect", () => {
  const legacy = assistantRowsFromLegacyFields({
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [], providerModelId: "model-a", runControls: {},
    searchPlan: { mode: "all_selected", optionIds: [] }, skillIds: []
  });
  const rows = (modelPolicy: "adjustable" | "fixed"): AssistantRows => ({
    ...legacy, model: { policy: modelPolicy, value: { mode: "model", modelId: "model-a" } }
  });
  const available = { modelIds: new Set(["model-a", "model-b"]) };
  const stored = { controls: { temperature: 1.7 }, model: { mode: "model" as const, modelId: "model-b" } };

  it("keeps stored controls with the stored model they were set for", () => {
    expect(storedOverridesInEffect({ assistant: rows("adjustable"), available, requested: {}, stored })).toEqual(stored);
    const withoutModel = { controls: { temperature: 1.7 } };
    expect(storedOverridesInEffect({ assistant: rows("fixed"), available, requested: {}, stored: withoutModel }))
      .toEqual(withoutModel);
  });

  it.each([
    ["the request sets a model", rows("adjustable"), available, { model: { mode: "model" as const, modelId: "model-a" } }],
    ["the Model row is fixed", rows("fixed"), available, {}],
    ["the stored model left the catalog", rows("adjustable"), { modelIds: new Set(["model-a"]) }, {}]
  ])("leaves stored controls out when %s, as the admission write does", (_case, assistant, catalog, requested: ChatAssistantOverrides) => {
    const effective = storedOverridesInEffect({ assistant, available: catalog, requested, stored });
    expect(effective).toEqual({ model: stored.model });
    // The chain clears the model override (or replaces it), and the write drops the controls with it.
    expect(nextChatAssistantOverrides(stored, { model: requested.model ?? null })).not.toHaveProperty("controls");
  });

  it("keeps stored overrides when the request brings new controls", () => {
    const requested = { controls: { temperature: 0.2 }, model: { mode: "model" as const, modelId: "model-a" } };
    expect(storedOverridesInEffect({ assistant: rows("adjustable"), available, requested, stored })).toBe(stored);
  });
});
