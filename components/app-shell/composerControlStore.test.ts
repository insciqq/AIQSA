import { afterEach, describe, expect, it } from "vitest";
import { resetComposerControlStoreForTest, useComposerControlStore } from "./composerControlStore";
import type { PromptPreset } from "./types";

describe("composer control store", () => {
  afterEach(() => {
    resetComposerControlStoreForTest();
  });

  it("applies prompt and control defaults", () => {
    const prompt: PromptPreset = {
      developerPrompt: "developer",
      id: "prompt-a",
      isDefault: false,
      name: "Prompt A",
      systemPrompt: "system"
    };

    useComposerControlStore.getState().applyPrompt(prompt);
    useComposerControlStore.getState().applyControlDefaults({
      backgroundMode: false,
      maxOutputTokens: "96",
      reasoningEffort: "high",
      reasoningMode: "pro",
      streamMode: true,
      temperature: "0.4"
    });

    expect(useComposerControlStore.getState()).toMatchObject({
      backgroundMode: false,
      developerPrompt: "developer",
      maxOutputTokens: "96",
      reasoningEffort: "high",
      reasoningMode: "pro",
      selectedPromptId: "prompt-a",
      streamMode: true,
      systemPrompt: "system",
      temperature: "0.4"
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
