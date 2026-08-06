import { afterEach, describe, expect, it } from "vitest";
import {
  resetComposerControlStoreForTest,
  useComposerControlStore,
  type ComposerAssistantSelection
} from "./composerControlStore";

function assistantSelection(
  overrides: Partial<ComposerAssistantSelection> = {}
): ComposerAssistantSelection {
  return {
    avatar: {
      accents: [0],
      backgroundShape: "circle",
      foregroundShape: "diamond",
      kind: "generated",
      paletteId: "ocean",
      recipeVersion: 1,
      rotations: [0, 1]
    },
    description: "Focused helper",
    id: "assistant-a",
    name: "Assistant A",
    promptCharacterCount: 42,
    starterPrompts: ["Summarize this thread"],
    ...overrides
  };
}

describe("composer control store", () => {
  afterEach(() => {
    resetComposerControlStoreForTest();
  });

  it("applies assistant selection and control defaults", () => {
    useComposerControlStore.getState().applyAssistantSelection({
      assistant: assistantSelection(),
      controlDefaults: {
        backgroundMode: true,
        maxOutputTokens: "128",
        reasoningEffort: "low",
        reasoningMode: "standard",
        streamMode: false,
        temperature: "0.9"
      },
      modelId: "gpt-5.6-sol",
      provider: "openai",
      searchOptionIds: ["perplexity-tool-search"],
      searchPlanMode: "model_choice"
    });
    useComposerControlStore.getState().applyControlDefaults({
      backgroundMode: false,
      maxOutputTokens: "96",
      reasoningEffort: "high",
      reasoningMode: "pro",
      streamMode: true,
      temperature: "0.4"
    });

    expect(useComposerControlStore.getState()).toMatchObject({
      assistantRemovedNotice: false,
      backgroundMode: false,
      maxOutputTokens: "96",
      reasoningEffort: "high",
      reasoningMode: "pro",
      searchPlanMode: "model_choice",
      selectedAssistant: { id: "assistant-a", name: "Assistant A" },
      selectedModelId: "gpt-5.6-sol",
      selectedProvider: "openai",
      selectedSearchOptionIds: ["perplexity-tool-search"],
      selectedSearchStrategy: "perplexity-tool-search",
      streamMode: true,
      temperature: "0.4"
    });
  });

  it("drops the assistant identity on a user control change and restores the manual backup on removal", () => {
    useComposerControlStore.getState().setTemperature("0.2");
    useComposerControlStore.getState().applyAssistantSelection({
      assistant: assistantSelection(),
      controlDefaults: {
        backgroundMode: true,
        maxOutputTokens: "128",
        reasoningEffort: "low",
        reasoningMode: "standard",
        streamMode: false,
        temperature: "0.9"
      },
      modelId: "gpt-5.6-sol",
      provider: "openai",
      searchOptionIds: [],
      searchPlanMode: "all_selected"
    });

    useComposerControlStore.getState().setTemperature("0.5");

    expect(useComposerControlStore.getState()).toMatchObject({
      assistantManualBackup: null,
      assistantRemovedNotice: true,
      selectedAssistant: null,
      temperature: "0.5"
    });

    useComposerControlStore.getState().clearAssistantRemovedNotice();
    expect(useComposerControlStore.getState().assistantRemovedNotice).toBe(false);

    useComposerControlStore.getState().applyAssistantSelection({
      assistant: assistantSelection(),
      controlDefaults: {
        backgroundMode: true,
        maxOutputTokens: "128",
        reasoningEffort: "low",
        reasoningMode: "standard",
        streamMode: false,
        temperature: "0.9"
      },
      modelId: "gpt-5.6-sol",
      provider: "openai",
      searchOptionIds: [],
      searchPlanMode: "all_selected"
    });
    useComposerControlStore.getState().removeAssistant();

    expect(useComposerControlStore.getState()).toMatchObject({
      assistantManualBackup: null,
      assistantRemovedNotice: false,
      selectedAssistant: null,
      temperature: "0.5"
    });
  });

  it("clears an assistant silently on a system-origin model selection", () => {
    useComposerControlStore.getState().applyAssistantSelection({
      assistant: assistantSelection(),
      controlDefaults: {
        backgroundMode: true,
        maxOutputTokens: "128",
        reasoningEffort: "low",
        reasoningMode: "standard",
        streamMode: false,
        temperature: "0.9"
      },
      modelId: "gpt-5.6-sol",
      provider: "openai",
      searchOptionIds: [],
      searchPlanMode: "all_selected"
    });

    useComposerControlStore.getState().applyModelSelection(
      {
        controlDefaults: {
          backgroundMode: false,
          maxOutputTokens: "64000",
          reasoningEffort: "max",
          reasoningMode: "pro",
          streamMode: false,
          temperature: "0.7"
        },
        modelId: "claude-opus",
        provider: "anthropic"
      },
      "system"
    );

    expect(useComposerControlStore.getState()).toMatchObject({
      assistantRemovedNotice: false,
      selectedAssistant: null,
      selectedModelId: "claude-opus",
      selectedProvider: "anthropic"
    });
  });

  it("applies a model selection atomically", () => {
    let notifications = 0;
    const unsubscribe = useComposerControlStore.subscribe(() => {
      notifications += 1;
    });

    useComposerControlStore.getState().applyModelSelection({
      controlDefaults: {
        backgroundMode: false,
        maxOutputTokens: "64000",
        reasoningEffort: "max",
        reasoningMode: "pro",
        streamMode: false,
        temperature: "0.7"
      },
      modelId: "gpt-5.6-sol",
      provider: "openai"
    });
    unsubscribe();

    expect(useComposerControlStore.getState()).toMatchObject({
      backgroundMode: false,
      maxOutputTokens: "64000",
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: "gpt-5.6-sol",
      selectedProvider: "openai",
      selectedSearchStrategy: "openai-native-web-search",
      streamMode: false,
      temperature: "0.7"
    });
    expect(notifications).toBe(1);
  });

  it("updates provider/model/search selection and visibility toggles", () => {
    useComposerControlStore.getState().setSelectedProvider("openrouter");
    useComposerControlStore.getState().setSelectedModelId("x-ai/grok");
    useComposerControlStore.getState().setSelectedSearchStrategy("perplexity-tool-search");
    useComposerControlStore.getState().setReasoningMode("pro");
    useComposerControlStore.getState().setShowCitations((visible) => !visible);
    useComposerControlStore.getState().setShowReasoningBlocks((visible) => !visible);
    useComposerControlStore.getState().setShowToolActivity((visible) => !visible);

    expect(useComposerControlStore.getState()).toMatchObject({
      selectedModelId: "x-ai/grok",
      selectedProvider: "openrouter",
      selectedSearchOptionIds: ["perplexity-tool-search"],
      selectedSearchStrategy: "perplexity-tool-search",
      reasoningMode: "pro",
      showCitations: false,
      showReasoningBlocks: true,
      showToolActivity: false
    });
  });

  it("keeps the legacy singleton field synchronized with a multi-engine plan", () => {
    useComposerControlStore
      .getState()
      .setSelectedSearchPlan(["codex-search", "perplexity-search"], "model_choice");

    expect(useComposerControlStore.getState()).toMatchObject({
      searchPlanMode: "model_choice",
      selectedSearchOptionIds: ["codex-search", "perplexity-search"],
      selectedSearchStrategy: "codex-search"
    });

    useComposerControlStore.getState().setSelectedSearchStrategy("search-disabled");

    expect(useComposerControlStore.getState()).toMatchObject({
      searchPlanMode: "all_selected",
      selectedSearchOptionIds: [],
      selectedSearchStrategy: "search-disabled"
    });
  });
});
