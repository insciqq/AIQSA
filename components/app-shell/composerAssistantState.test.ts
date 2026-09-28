import { describe, expect, it } from "vitest";
import {
  composerAssistantFromDefinition,
  composerAssistantFromProjection,
  composerAssistantOverride,
  composerAssistantRowValue,
  composerAssistantSendBlockReason,
  type ComposerAssistantContext,
  type ComposerAssistantDefaults,
  type ComposerAssistantDefinition
} from "./composerAssistantState";
import { initialComposerControlSnapshot, type ComposerControlSnapshot } from "./composerControlStore";
import type { CatalogModel } from "./types";
import type { ChatAssistantProjection } from "@/lib/contracts/chats";
import { EMPTY_KNOWLEDGE_SELECTION } from "@/lib/contracts/knowledge";
import { assistantAvatarFixture, boundComposerAssistantFixture } from "@/tests/support/composerAssistantFixtures";

function catalogModel(modelId: string, provider: string): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: true,
      openRouterPerplexitySearch: false,
      reasoning: true,
      streaming: true,
      toolCalling: true
    },
    contextWindow: null,
    defaultParams: {},
    displayName: modelId,
    modelId,
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
      reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider,
    searchStrategyIds: ["web"]
  };
}

const assistantModel = catalogModel("assistant-model", "assistant-provider");
const defaultModel = catalogModel("default-model", "default-provider");

const context: ComposerAssistantContext = {
  controlDefaults: (model) => ({
    backgroundMode: false,
    maxOutputTokens: "4096",
    reasoningEffort: model.modelId === "default-model" ? "low" : "medium",
    reasoningMode: "standard",
    streamMode: true,
    temperature: "1"
  }),
  models: [assistantModel, defaultModel],
  skill: (skillId) => skillId === "skill-1" ? { instructionApproxTokens: 40, name: "Reviewer" } : null
};

const defaults: ComposerAssistantDefaults = {
  knowledge: { selection: EMPTY_KNOWLEDGE_SELECTION, source: "off" },
  model: { modelId: "default-model", provider: "default-provider" },
  search: { mode: "all_selected", optionIds: ["web"] },
  skillsMode: "auto",
  tools: { mode: "load_all" }
};

function definition(overrides: Partial<ComposerAssistantDefinition> = {}): ComposerAssistantDefinition {
  return {
    availability: { ok: true },
    avatar: assistantAvatarFixture,
    description: "Reviews code",
    id: "assistant-1",
    name: "Reviewer",
    owned: true,
    ownerDisplayName: "Owner",
    promptCharacterCount: 120,
    rowAvailability: {},
    rows: {
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      knowledge: { policy: "adjustable", value: { mode: "inherit" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "assistant-model" } },
      search: { policy: "adjustable", value: { mode: "off" } },
      skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "off" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["server-1"] } }
    },
    starterPrompts: ["Review this"],
    ...overrides
  };
}

describe("composer Assistant state", () => {
  it("resolves a chosen definition like admission: Assistant values, defaults for inherit", () => {
    const applied = composerAssistantFromDefinition(definition(), context, defaults);

    expect(applied?.controls).toEqual({
      backgroundMode: false,
      knowledgePlanSource: "off",
      knowledgeSelection: EMPTY_KNOWLEDGE_SELECTION,
      maxOutputTokens: "4096",
      mcpSelection: { mode: "exact", serverIds: ["server-1"] },
      reasoningEffort: "medium",
      reasoningMode: "standard",
      searchPlanMode: "all_selected",
      selectedKnowledgeBaseIds: [],
      selectedModelId: "assistant-model",
      selectedProvider: "assistant-provider",
      selectedSearchOptionIds: [],
      skillsMode: "off",
      streamMode: true,
      temperature: "0.2"
    });
    expect(applied?.assistant).toMatchObject({
      includedSkills: [{ id: "skill-1", instructionApproxTokens: 40, mode: "pinned", name: "Reviewer" }],
      rows: {
        controls: { origin: "assistant", policy: "fixed" },
        knowledge: { origin: "default", policy: "adjustable" },
        model: { origin: "assistant", policy: "fixed" },
        search: { origin: "assistant" },
        skills: { origin: "assistant" },
        tools: { origin: "assistant" }
      },
      starterPrompts: ["Review this"],
      unsyncedRows: []
    });
    expect(applied?.assistant.resets.search).toEqual({
      controls: { searchPlanMode: "all_selected", selectedSearchOptionIds: [] },
      origin: "assistant"
    });
  });

  it("uses the user's default for an adjustable value the user cannot use, never substituting a fixed one", () => {
    const fallback = composerAssistantFromDefinition(definition({
      rowAvailability: { model: { reason: "model_access" } },
      rows: {
        ...definition().rows,
        controls: { policy: "adjustable", value: { temperature: 0.2 } },
        model: { policy: "adjustable", value: { mode: "model", modelId: "hidden-model" } }
      }
    }), context, defaults);

    expect(fallback?.controls).toMatchObject({
      reasoningEffort: "low",
      selectedModelId: "default-model",
      temperature: "1"
    });
    expect(fallback?.assistant.rows).toMatchObject({
      controls: { origin: "default" },
      model: { deviation: { reason: "model_access" }, origin: "fallback" }
    });

    expect(composerAssistantFromDefinition(definition({
      rows: { ...definition().rows, model: { policy: "fixed", value: { mode: "model", modelId: "hidden-model" } } }
    }), context, defaults)).toBeNull();
  });

  it("restores a chat's Assistant exactly as the server projects it", () => {
    const projection: ChatAssistantProjection = {
      availability: { ok: true },
      avatar: assistantAvatarFixture,
      id: "assistant-1",
      name: "Reviewer",
      owned: false,
      ownerDisplayName: "Owner",
      rows: {
        controls: { assistantValue: {}, deviation: null, policy: "adjustable", provenance: "chat", value: { temperature: 1.4 } },
        knowledge: {
          assistantValue: { baseIds: [], hiddenCount: 2, mode: "explicit", sourceIds: [] },
          deviation: null,
          policy: "fixed",
          provenance: "assistant",
          value: { baseIds: [], hiddenCount: 2, mode: "explicit", sourceIds: [] }
        },
        model: {
          assistantValue: { mode: "model", modelId: "assistant-model" },
          deviation: null,
          policy: "adjustable",
          provenance: "chat",
          value: { mode: "model", modelId: "default-model" }
        },
        search: { assistantValue: { mode: "inherit" }, deviation: null, policy: "adjustable", provenance: "default", value: { mode: "model_choice", optionIds: ["web"] } },
        skills: { assistantValue: { links: [], mode: "auto" }, deviation: null, policy: "adjustable", provenance: "assistant", value: { links: [], mode: "auto" } },
        tools: { assistantValue: { mode: "off" }, deviation: null, policy: "adjustable", provenance: "chat", value: { mode: "auto" } }
      },
      state: "bound"
    };

    const restored = composerAssistantFromProjection(projection, context, { starterPrompts: ["Hi"] });

    expect(restored.controls).toMatchObject({
      knowledgePlanSource: "assistant",
      knowledgeSelection: { inheritedFrom: "assistant", mode: "inherited" },
      mcpSelection: { mode: "auto" },
      reasoningEffort: "low",
      searchPlanMode: "model_choice",
      selectedModelId: "default-model",
      selectedProvider: "default-provider",
      selectedSearchOptionIds: ["web"],
      skillsMode: "auto",
      temperature: "1.4"
    });
    expect(restored.assistant).toMatchObject({
      description: null,
      owned: false,
      rows: {
        controls: { origin: "chat" },
        knowledge: { origin: "assistant", policy: "fixed" },
        model: { origin: "chat" },
        search: { origin: "default" },
        tools: { origin: "chat" }
      },
      starterPrompts: ["Hi"],
      state: "bound"
    });
    // Rows changed for the chat return through a chat update, not locally.
    expect(restored.assistant.state === "bound" && Object.keys(restored.assistant.resets).sort())
      .toEqual(["knowledge", "search", "skills"]);

    expect(composerAssistantFromProjection({ state: "deleted" }, context)).toEqual({
      assistant: { state: "deleted" },
      controls: {}
    });
    expect(composerAssistantFromProjection({ reason: "archived", state: "unavailable" }, context)).toEqual({
      assistant: { reason: "archived", state: "unavailable" },
      controls: {}
    });
  });

  it("reads effective values and chat overrides from the composer fields", () => {
    const state: ComposerControlSnapshot = {
      ...initialComposerControlSnapshot,
      assistant: boundComposerAssistantFixture(),
      knowledgeSelection: { baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1 },
      mcpSelection: { mode: "exact", serverIds: ["server-1"] },
      selectedModelId: "assistant-model",
      selectedSearchOptionIds: ["search-disabled"],
      temperature: "0.4"
    };

    expect(composerAssistantRowValue(state, "search", assistantModel)).toEqual({ mode: "off" });
    expect(composerAssistantRowValue(state, "tools", assistantModel)).toEqual({ mode: "exact", serverIds: ["server-1"] });
    expect(composerAssistantOverride(state, "tools", assistantModel)).toBeNull();
    expect(composerAssistantOverride(state, "knowledge", assistantModel))
      .toEqual({ baseIds: ["base-1"], mode: "explicit", sourceIds: [] });
    expect(composerAssistantOverride(state, "controls", assistantModel)).toEqual({
      maxOutputTokens: Number(initialComposerControlSnapshot.maxOutputTokens),
      reasoningEffort: "medium",
      streamMode: false,
      temperature: 0.4
    });
  });

  it("blocks sending until the user chooses, for every state without a usable Assistant", () => {
    expect(composerAssistantSendBlockReason({ assistant: null })).toBeNull();
    expect(composerAssistantSendBlockReason({ assistant: boundComposerAssistantFixture() })).toBeNull();
    expect(composerAssistantSendBlockReason({ assistant: { state: "deleted" } })).toContain("was deleted");
    expect(composerAssistantSendBlockReason({ assistant: { state: "unavailable" } })).toContain("isn't available");
    expect(composerAssistantSendBlockReason({ assistant: { reason: "archived", state: "unavailable" } }))
      .toBe("This Assistant was archived by its owner. Choose another or continue without the Assistant.");
    expect(composerAssistantSendBlockReason({
      assistant: boundComposerAssistantFixture({ availability: { ok: false, reason: "archived" }, owned: false })
    })).toContain("archived by its owner");
    expect(composerAssistantSendBlockReason({
      assistant: boundComposerAssistantFixture({ availability: { ok: false, reason: "tools_access" } })
    })).toContain("isn't available");
  });
});
