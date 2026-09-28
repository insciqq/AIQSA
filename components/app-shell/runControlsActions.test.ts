import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useRunControlsActions } from "@/components/app-shell/runControlsActions";
import type { Catalog, CatalogModel, ModelParameterControls } from "@/components/app-shell/types";
import { normalizeOpenRouterParams } from "@/lib/domain/providerParams";
import type { SettingsMutationCoordinator } from "@/components/app-shell/settingsMutationCoordinator";
import { boundComposerAssistantFixture } from "@/tests/support/composerAssistantFixtures";

const initialComposerState = useComposerControlStore.getState();

afterEach(() => {
  useComposerControlStore.setState(initialComposerState, true);
});

function openRouterModel(
  reasoningEffort: ModelParameterControls["reasoningEffort"],
  defaultParams: Record<string, unknown>
): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: reasoningEffort.supported,
      streaming: true,
      toolCalling: true
    },
    contextWindow: null,
    defaultParams,
    displayName: "Router model",
    modelId: "vendor/model",
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
      reasoningEffort,
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "openrouter",
    providerFamily: "openrouter",
    searchStrategyIds: []
  };
}

function useComposerParamsForTest(model: CatalogModel, reasoningEffort: string): Record<string, unknown> {
  useComposerControlStore.setState({
    reasoningEffort,
    selectedModelId: model.modelId,
    selectedProvider: model.provider
  });
  const catalog = { models: [model] } as unknown as Catalog;
  return useRunControlsActions({
    catalog,
    currentModel: model,
    pendingControlDefaultsRef: { current: null },
    pendingControlDefaultsTimerRef: { current: null },
    resolveCatalog: () => catalog,
    settingsMutationCoordinatorRef: { current: null },
    setCatalog: () => undefined,
    setNotice: () => undefined,
    setSettingsNotice: () => undefined
  }).buildParams();
}

describe("composer OpenRouter reasoning params", () => {
  it("leaves reasoning unset for a model without the reasoning control", () => {
    const params = useComposerParamsForTest(
      openRouterModel({ defaultValue: "none", options: ["none"], supported: false }, {}),
      "none"
    );

    expect(params).not.toHaveProperty("reasoning");
    expect(normalizeOpenRouterParams(params).reasoning.effort).not.toBe("none");
  });

  it("keeps a chosen none as an explicit Off and a chosen effort as enabled", () => {
    const model = openRouterModel(
      { defaultValue: "high", options: ["none", "low", "high"], supported: true },
      { reasoning: { enabled: true, effort: "high" } }
    );
    const off = useComposerParamsForTest(model, "none");

    expect(off.reasoning).toEqual({ enabled: false, effort: "high" });
    expect(normalizeOpenRouterParams(off).reasoning).toMatchObject({ enabled: false, effort: "none" });
    expect(useComposerParamsForTest(model, "low").reasoning).toEqual({ enabled: true, effort: "low" });
  });
});

describe("parameter persistence with an Assistant", () => {
  function useParameterActionsForTest(assistantModelId: string) {
    const model = openRouterModel({ defaultValue: "high", options: ["none", "low", "high"], supported: true }, {});
    const assistant = boundComposerAssistantFixture();
    assistant.rows.model = { ...assistant.rows.model, assistantValue: { mode: "model", modelId: assistantModelId } };
    useComposerControlStore.setState({
      assistant,
      reasoningEffort: "high",
      selectedModelId: model.modelId,
      selectedProvider: model.provider,
      temperature: "0.3"
    });
    const catalog = { defaults: { controlValues: {} }, models: [model] } as unknown as Catalog;
    const enqueue = vi.fn(async () => true);
    const pendingControlDefaultsRef = { current: null as never };
    const actions = useRunControlsActions({
      catalog,
      currentModel: model,
      pendingControlDefaultsRef,
      pendingControlDefaultsTimerRef: { current: null },
      resolveCatalog: () => catalog,
      settingsMutationCoordinatorRef: {
        current: { configure: vi.fn(), enqueue, retry: vi.fn() } as unknown as SettingsMutationCoordinator
      },
      setCatalog: () => undefined,
      setNotice: () => undefined,
      setSettingsNotice: () => undefined
    });
    return { actions, enqueue, pendingControlDefaultsRef };
  }

  it("keeps parameter edits on the Assistant's own model out of the user's saved values", () => {
    const { actions, enqueue, pendingControlDefaultsRef } = useParameterActionsForTest("vendor/model");

    actions.changeReasoningEffort("low");
    actions.changeTemperature("0.9");
    actions.changeStreamMode(false);

    expect(enqueue).not.toHaveBeenCalled();
    expect(pendingControlDefaultsRef.current).toBeNull();
    const assistant = useComposerControlStore.getState().assistant;
    expect(assistant?.state === "bound" && assistant.rows.controls.origin).toBe("chat");
    expect(useComposerControlStore.getState()).toMatchObject({ reasoningEffort: "low", temperature: "0.9" });
  });

  it("refuses edits of fixed parameters without saving anything", () => {
    const { actions, enqueue } = useParameterActionsForTest("vendor/model");
    const assistant = useComposerControlStore.getState().assistant;
    if (assistant?.state !== "bound") throw new Error("expected a bound Assistant");
    assistant.rows.controls = { ...assistant.rows.controls, policy: "fixed" };
    useComposerControlStore.setState({ assistant: { ...assistant } });

    actions.changeReasoningEffort("low");

    expect(enqueue).not.toHaveBeenCalled();
    expect(useComposerControlStore.getState().reasoningEffort).toBe("high");
  });

  it("saves parameters as ordinary values for a model the user chose instead of the Assistant's", () => {
    const { actions, enqueue } = useParameterActionsForTest("assistant-model");

    actions.changeReasoningEffort("low");

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      controlValues: { "openrouter:vendor/model": expect.objectContaining({ reasoningEffort: "low" }) }
    }), expect.anything());
    const assistant = useComposerControlStore.getState().assistant;
    expect(assistant?.state === "bound" && assistant.rows.controls.origin).toBe("assistant");
  });
});
