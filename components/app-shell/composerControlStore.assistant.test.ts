import { beforeEach, describe, expect, it } from "vitest";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import {
  boundComposerAssistantFixture,
  composerAssistantRowsFixture
} from "@/tests/support/composerAssistantFixtures";
import {
  assistantGovernsControls,
  useComposerControlStore,
  type ComposerBoundAssistant
} from "@/components/app-shell/composerControlStore";
import { inheritedKnowledgeSelection } from "@/lib/contracts/knowledge";
import type { AssistantRowKey, AssistantRowPolicy } from "@/lib/contracts/assistants";

const assistantControls = {
  backgroundMode: false,
  maxOutputTokens: "9000",
  reasoningEffort: "high",
  reasoningMode: "pro",
  streamMode: true,
  temperature: "0.3"
};

const savedOtherModelControls = {
  backgroundMode: true,
  maxOutputTokens: "2000",
  reasoningEffort: "low",
  reasoningMode: "standard",
  streamMode: false,
  temperature: "1"
};

function applyAssistant(
  policies: Partial<Record<AssistantRowKey, AssistantRowPolicy>> = {},
  overrides: Partial<ComposerBoundAssistant> = {}
) {
  useComposerControlStore.getState().applyAssistantState({
    assistant: boundComposerAssistantFixture({
      resets: {
        controls: { controls: { ...assistantControls }, origin: "assistant" },
        model: {
          controls: { selectedModelId: "assistant-model", selectedProvider: "assistant-provider" },
          origin: "assistant"
        },
        search: { controls: { searchPlanMode: "all_selected", selectedSearchOptionIds: [] }, origin: "assistant" }
      },
      rows: composerAssistantRowsFixture(policies),
      ...overrides
    }),
    controls: {
      ...assistantControls,
      knowledgePlanSource: "off",
      mcpSelection: { mode: "exact", serverIds: ["server-1"] },
      searchPlanMode: "all_selected",
      selectedModelId: "assistant-model",
      selectedProvider: "assistant-provider",
      selectedSearchOptionIds: [],
      skillsMode: "auto"
    }
  });
}

function bound(): ComposerBoundAssistant {
  const assistant = useComposerControlStore.getState().assistant;
  if (assistant?.state !== "bound") throw new Error("expected a bound Assistant");
  return assistant;
}

function origins(): Record<AssistantRowKey, string> {
  return Object.fromEntries(Object.entries(bound().rows).map(([key, row]) => [key, row.origin])) as
    Record<AssistantRowKey, string>;
}

const changes: Record<AssistantRowKey, () => void> = {
  controls: () => useComposerControlStore.getState().setTemperature("0.9"),
  knowledge: () => useComposerControlStore.getState().setSelectedKnowledgePlan(["base-2"]),
  model: () => useComposerControlStore.getState().applyModelSelection({
    controlDefaults: savedOtherModelControls,
    modelId: "other-model",
    provider: "other-provider"
  }),
  search: () => useComposerControlStore.getState().setSelectedSearchPlan(["web"], "all_selected"),
  skills: () => useComposerControlStore.getState().setSkillsMode("off"),
  tools: () => useComposerControlStore.getState().setMcpSelection({ mode: "off" })
};

describe("composer Assistant rows", () => {
  beforeEach(() => {
    resetComposerControlStoreForTest();
  });

  it("applies an Assistant and its row values atomically", () => {
    let notifications = 0;
    const unsubscribe = useComposerControlStore.subscribe(() => {
      notifications += 1;
    });
    applyAssistant();
    unsubscribe();

    expect(notifications).toBe(1);
    expect(useComposerControlStore.getState()).toMatchObject({
      assistant: { id: "assistant-a", state: "bound" },
      mcpSelection: { mode: "exact", serverIds: ["server-1"] },
      selectedModelId: "assistant-model",
      temperature: "0.3"
    });
  });

  it("keeps the Assistant and marks only the changed adjustable row as changed for the chat", () => {
    for (const [key, change] of Object.entries(changes) as [AssistantRowKey, () => void][]) {
      resetComposerControlStoreForTest();
      applyAssistant();
      change();

      const expected = Object.fromEntries(Object.keys(changes).map((row) => [row, row === key ? "chat" : "assistant"]));
      // A model change hands the parameters to the chosen model.
      if (key === "model") expected.controls = "default";
      expect(origins(), key).toEqual(expected);
      expect(bound().unsyncedRows, key).toEqual([key]);
      expect(bound().id, key).toBe("assistant-a");
    }
  });

  it("refuses a change of a fixed row without any side effect", () => {
    for (const [key, change] of Object.entries(changes) as [AssistantRowKey, () => void][]) {
      resetComposerControlStoreForTest();
      applyAssistant({ [key]: "fixed", ...(key === "controls" ? { model: "fixed" } : {}) });
      const before = JSON.stringify(useComposerControlStore.getState());
      change();

      expect(JSON.stringify(useComposerControlStore.getState()), key).toBe(before);
    }
  });

  it("treats an unchanged value as no change", () => {
    applyAssistant();
    useComposerControlStore.getState().setTemperature("0.3");
    useComposerControlStore.getState().setSelectedSearchPlan([], "all_selected");

    expect(origins()).toMatchObject({ controls: "assistant", search: "assistant" });
    expect(bound().unsyncedRows).toEqual([]);
  });

  it("governs parameters only while the effective model is the Assistant's model", () => {
    applyAssistant();
    expect(assistantGovernsControls(useComposerControlStore.getState())).toBe(true);

    changes.model();
    expect(assistantGovernsControls(useComposerControlStore.getState())).toBe(false);
    useComposerControlStore.getState().setTemperature("1.4");

    expect(useComposerControlStore.getState().temperature).toBe("1.4");
    expect(origins()).toMatchObject({ controls: "default", model: "chat" });
    expect(bound().unsyncedRows).toEqual(["model"]);
  });

  it("drops a controls override when the model changes and brings the Assistant's parameters back with its model", () => {
    applyAssistant();
    useComposerControlStore.getState().setTemperature("0.9");
    expect(origins().controls).toBe("chat");

    changes.model();
    expect(useComposerControlStore.getState()).toMatchObject(savedOtherModelControls);
    expect(origins().controls).toBe("default");

    useComposerControlStore.getState().applyModelSelection({
      controlDefaults: savedOtherModelControls,
      modelId: "assistant-model",
      provider: "assistant-provider"
    });
    expect(useComposerControlStore.getState()).toMatchObject({ ...savedOtherModelControls, temperature: "0.3" });
    expect(origins()).toMatchObject({ controls: "assistant", model: "chat" });
  });

  it("resets a changed row to its baseline and a model reset takes the parameters with it", () => {
    applyAssistant();
    useComposerControlStore.getState().setTemperature("0.9");
    changes.model();
    changes.search();

    expect(useComposerControlStore.getState().resetAssistantRow("model")).toBe(true);
    expect(useComposerControlStore.getState()).toMatchObject({
      ...assistantControls,
      selectedModelId: "assistant-model",
      selectedProvider: "assistant-provider"
    });
    expect(origins()).toMatchObject({ controls: "assistant", model: "assistant", search: "chat" });
    expect(bound().unsyncedRows).toEqual(["search"]);

    expect(useComposerControlStore.getState().resetAssistantRow("tools")).toBe(false);
  });

  it("hands unsynced rows over once", () => {
    applyAssistant();
    changes.search();
    changes.skills();

    expect(useComposerControlStore.getState().takeUnsyncedAssistantRows()).toEqual(["search", "skills"]);
    expect(useComposerControlStore.getState().takeUnsyncedAssistantRows()).toEqual([]);
    expect(origins()).toMatchObject({ search: "chat", skills: "chat" });
  });

  it("never drops the Assistant on system rewrites or display toggles", () => {
    applyAssistant();
    useComposerControlStore.getState().applyModelSelection({
      controlDefaults: savedOtherModelControls,
      modelId: "chat-model",
      provider: "chat-provider"
    }, "system");
    useComposerControlStore.getState().setSelectedSearchPlan(["web"], "model_choice", "system");
    useComposerControlStore.getState().setShowCitations(false);
    useComposerControlStore.getState().setShowReasoningBlocks(true);

    expect(bound().id).toBe("assistant-a");
    expect(bound().unsyncedRows).toEqual([]);
    expect(origins()).toMatchObject({ model: "assistant", search: "assistant" });
  });

  it("returns values only an Assistant can express to ordinary values on removal", () => {
    applyAssistant();
    useComposerControlStore.setState({
      knowledgePlanSource: "assistant",
      knowledgeSelection: inheritedKnowledgeSelection("assistant")
    });
    useComposerControlStore.getState().clearAssistant({ mcpSelection: { mode: "load_all" }, skillsMode: "off" });

    expect(useComposerControlStore.getState()).toMatchObject({
      assistant: null,
      knowledgePlanSource: "off",
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [] },
      mcpSelection: { mode: "load_all" },
      skillsMode: "off"
    });
  });

  it("keeps unavailable and deleted bindings without identity", () => {
    useComposerControlStore.getState().applyAssistantState({ assistant: { state: "deleted" }, controls: {} });
    useComposerControlStore.getState().setTemperature("0.7");

    expect(useComposerControlStore.getState()).toMatchObject({ assistant: { state: "deleted" }, temperature: "0.7" });
  });
});
