import { afterEach, describe, expect, it } from "vitest";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useRunControlsActions } from "@/components/app-shell/runControlsActions";
import type { Catalog, CatalogModel, ModelParameterControls } from "@/components/app-shell/types";
import { normalizeOpenRouterParams } from "@/lib/domain/providerParams";

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
