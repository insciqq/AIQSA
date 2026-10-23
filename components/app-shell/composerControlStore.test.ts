import { afterEach, describe, expect, it } from "vitest";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import { boundComposerAssistantFixture } from "@/tests/support/composerAssistantFixtures";
import { useComposerControlStore } from "./composerControlStore";

describe("composer control store", () => {
  afterEach(() => {
    resetComposerControlStoreForTest();
  });

  it("applies an Assistant state and later control defaults", () => {
    useComposerControlStore.getState().setMcpSelection({ mode: "load_all" });
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture(),
      controls: {
        searchPlanMode: "model_choice",
        selectedModelId: "gpt-5.6-sol",
        selectedProvider: "openai",
        selectedSearchOptionIds: ["perplexity-tool-search"],
        skillsMode: "off"
      }
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
      assistant: { id: "assistant-a", state: "bound" },
      backgroundMode: false,
      maxOutputTokens: "96",
      mcpSelection: { mode: "load_all" },
      skillsMode: "off",
      reasoningEffort: "high",
      reasoningMode: "pro",
      searchPlanMode: "model_choice",
      selectedModelId: "gpt-5.6-sol",
      selectedProvider: "openai",
      selectedSearchOptionIds: ["perplexity-tool-search"],
      streamMode: true,
      temperature: "0.4"
    });
  });

  it("keeps manual Skills editable while an Assistant is selected", () => {
    const first = {
      description: "Review carefully",
      id: "skill-review",
      name: "Reviewer",
      promptCharacterCount: 80
    };
    const second = {
      description: "Finish with actions",
      id: "skill-actions",
      name: "Action closer",
      promptCharacterCount: 60
    };
    useComposerControlStore.getState().setSelectedSkills([first]);
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture(),
      controls: {}
    });

    expect(useComposerControlStore.getState().selectedSkills).toEqual([first]);
    useComposerControlStore.getState().setSelectedSkills([second]);
    expect(useComposerControlStore.getState()).toMatchObject({
      assistant: { id: "assistant-a" },
      selectedSkills: [second]
    });

    useComposerControlStore.getState().clearAssistant();
    expect(useComposerControlStore.getState()).toMatchObject({
      assistant: null,
      selectedSkills: [second]
    });
  });

  it("changes MCP mode only on an explicit selection", () => {
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "auto" });

    useComposerControlStore.getState().setMcpSelection({ mode: "load_all" });
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });

    useComposerControlStore.getState().setMcpSelection({ mode: "off" });
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "off" });
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
      streamMode: false,
      temperature: "0.7"
    });
    expect(notifications).toBe(1);
  });

  it("updates provider/model/search selection and visibility toggles", () => {
    useComposerControlStore.getState().setSelectedProvider("openrouter");
    useComposerControlStore.getState().setSelectedModelId("x-ai/grok");
    useComposerControlStore.getState().setSelectedSearchPlan(
      ["perplexity-tool-search"],
      "all_selected"
    );
    useComposerControlStore.getState().setReasoningMode("pro");
    useComposerControlStore.getState().setShowCitations((visible) => !visible);
    useComposerControlStore.getState().setShowReasoningBlocks((visible) => !visible);

    expect(useComposerControlStore.getState()).toMatchObject({
      selectedModelId: "x-ai/grok",
      selectedProvider: "openrouter",
      selectedSearchOptionIds: ["perplexity-tool-search"],
      reasoningMode: "pro",
      showCitations: false,
      showReasoningBlocks: true,
    });
  });

  it("stores a multi-engine plan and clears it atomically", () => {
    useComposerControlStore
      .getState()
      .setSelectedSearchPlan(["codex-search", "perplexity-search"], "model_choice");

    expect(useComposerControlStore.getState()).toMatchObject({
      searchPlanMode: "model_choice",
      selectedSearchOptionIds: ["codex-search", "perplexity-search"]
    });

    useComposerControlStore.getState().setSelectedSearchPlan([], "all_selected");

    expect(useComposerControlStore.getState()).toMatchObject({
      searchPlanMode: "all_selected",
      selectedSearchOptionIds: []
    });
  });
});
