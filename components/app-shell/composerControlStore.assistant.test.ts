import { beforeEach, describe, expect, it } from "vitest";
import {
  resetComposerControlStoreForTest,
  useComposerControlStore,
  type ComposerAssistantSelection
} from "@/components/app-shell/composerControlStore";

const selection: ComposerAssistantSelection = {
  avatar: {
    accents: [2],
    backgroundShape: "square",
    foregroundShape: "circle",
    kind: "generated",
    paletteId: "pine",
    recipeVersion: 1,
    rotations: [1, 2]
  },
  description: "Reviews changes.",
  id: "assistant-1",
  name: "Code Reviewer",
  promptCharacterCount: 120,
  starterPrompts: ["Review a diff"]
};

function applySelection() {
  useComposerControlStore.getState().applyAssistantSelection({
    assistant: selection,
    controlDefaults: {
      backgroundMode: false,
      maxOutputTokens: "9000",
      reasoningEffort: "high",
      reasoningMode: "pro",
      streamMode: true,
      temperature: "0.3"
    },
    knowledgeBaseIds: ["knowledge-base-1"],
    modelId: "assistant-model",
    provider: "assistant-provider",
    searchOptionIds: ["openai-native-web-search"],
    searchPlanMode: "model_choice"
  });
}

describe("composer assistant strict identity", () => {
  beforeEach(() => {
    resetComposerControlStoreForTest();
  });

  it("applies one exact revision atomically and preserves the manual draft backup", () => {
    const before = useComposerControlStore.getState();
    expect(before.selectedAssistant).toBeNull();

    applySelection();

    const state = useComposerControlStore.getState();
    expect(state.selectedAssistant?.name).toBe("Code Reviewer");
    expect(state.selectedModelId).toBe("assistant-model");
    expect(state.knowledgePlanSource).toBe("assistant");
    expect(state.selectedKnowledgeBaseIds).toEqual(["knowledge-base-1"]);
    expect(state.reasoningEffort).toBe("high");
    expect(state.selectedSearchOptionIds).toEqual(["openai-native-web-search"]);
    expect(state.searchPlanMode).toBe("model_choice");
    expect(state.assistantManualBackup?.selectedModelId).toBe(before.selectedModelId);
    expect(state.assistantRemovedNotice).toBe(false);
  });

  it("removes the identity on a manual governed change, keeping the resolved values", () => {
    applySelection();
    useComposerControlStore.getState().setTemperature("0.9");

    const state = useComposerControlStore.getState();
    expect(state.selectedAssistant).toBeNull();
    expect(state.assistantRemovedNotice).toBe(true);
    expect(state.temperature).toBe("0.9");
    expect(state.selectedModelId).toBe("assistant-model");
    expect(state.assistantManualBackup).toBeNull();
  });

  it("drops the identity for every governed control, never for display toggles", () => {
    const governed: Array<() => void> = [
      () => useComposerControlStore.getState().setBackgroundMode(true),
      () => useComposerControlStore.getState().setMaxOutputTokens("64"),
      () => useComposerControlStore.getState().setReasoningEffort("low"),
      () => useComposerControlStore.getState().setReasoningMode("standard"),
      () => useComposerControlStore.getState().setSelectedKnowledgePlan(["knowledge-base-2"]),
      () => useComposerControlStore.getState().setSelectedModelId("other"),
      () => useComposerControlStore.getState().setSelectedSearchPlan([], "all_selected"),
      () => useComposerControlStore.getState().setStreamMode(false),
      () => useComposerControlStore.getState().setTemperature("1.5")
    ];
    for (const change of governed) {
      resetComposerControlStoreForTest();
      applySelection();
      change();
      expect(useComposerControlStore.getState().selectedAssistant).toBeNull();
      expect(useComposerControlStore.getState().assistantRemovedNotice).toBe(true);
      expect(useComposerControlStore.getState().knowledgePlanSource).toBe("explicit");
    }

    resetComposerControlStoreForTest();
    applySelection();
    useComposerControlStore.getState().setShowCitations(false);
    useComposerControlStore.getState().setShowReasoningBlocks(true);
    expect(useComposerControlStore.getState().selectedAssistant?.id).toBe("assistant-1");
  });

  it("restores the preserved ordinary manual draft on explicit removal", () => {
    const before = useComposerControlStore.getState();
    applySelection();
    useComposerControlStore.getState().removeAssistant();

    const state = useComposerControlStore.getState();
    expect(state.selectedAssistant).toBeNull();
    expect(state.assistantRemovedNotice).toBe(false);
    expect(state.selectedModelId).toBe(before.selectedModelId);
    expect(state.selectedProvider).toBe(before.selectedProvider);
    expect(state.temperature).toBe(before.temperature);
    expect(state.selectedSearchOptionIds).toEqual(before.selectedSearchOptionIds);
  });

  it("keeps the original manual backup when switching between assistants", () => {
    const before = useComposerControlStore.getState();
    applySelection();
    useComposerControlStore.getState().applyAssistantSelection({
      assistant: { ...selection, id: "assistant-2", name: "Second" },
      controlDefaults: {
        backgroundMode: true,
        maxOutputTokens: "100",
        reasoningEffort: "low",
        reasoningMode: "standard",
        streamMode: false,
        temperature: "1"
      },
      knowledgeBaseIds: [],
      modelId: "second-model",
      provider: "second-provider",
      searchOptionIds: [],
      searchPlanMode: "all_selected"
    });
    useComposerControlStore.getState().removeAssistant();

    expect(useComposerControlStore.getState().selectedModelId).toBe(before.selectedModelId);
  });

  it("clears silently for system rewrites such as chat activation", () => {
    applySelection();
    useComposerControlStore.getState().applyModelSelection(
      {
        controlDefaults: {
          backgroundMode: false,
          maxOutputTokens: "2000",
          reasoningEffort: "medium",
          reasoningMode: "standard",
          streamMode: false,
          temperature: "1"
        },
        modelId: "chat-model",
        provider: "chat-provider"
      },
      "system"
    );

    const state = useComposerControlStore.getState();
    expect(state.selectedAssistant).toBeNull();
    expect(state.assistantRemovedNotice).toBe(false);
    expect(state.selectedModelId).toBe("chat-model");
  });
});
