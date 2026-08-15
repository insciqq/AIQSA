import { describe, expect, it } from "vitest";
import type { Catalog, CatalogModel } from "./types";
import {
  clampedNumber,
  coerceReasoningEffort,
  coerceReasoningMode,
  defaultParameterControls,
  fallbackCatalogModel
} from "./controlDefaults";

function model(input: Partial<CatalogModel> & Pick<CatalogModel, "modelId" | "provider">): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: false,
      toolCalling: false
    },
    contextWindow: 128000,
    defaultParams: {},
    displayName: input.modelId,
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
      reasoningEffort: {
        defaultValue: "none",
        options: ["none"],
        supported: false
      },
      reasoningMode: {
        defaultValue: "standard",
        options: ["standard"],
        supported: false
      },
      stream: { defaultValue: false, supported: false },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    searchStrategyIds: ["search-disabled"],
    ...input
  };
}

function catalog(models: CatalogModel[]): Catalog {
  return {
    defaults: {
      controlValues: {},
      hasPersonalModelDefault: true,
      modelId: "default-model",
      modelPreferenceSource: "personal",
      organizationModelDefault: null,
      organizationSearchPlan: { mode: "all_selected", optionIds: [] },
      personalModelDefault: { modelId: "default-model", provider: "openai" },
      provider: "openai",
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferenceSource: "personal",
      showCitations: true,
      showReasoningBlocks: false,
    },
    models,
    providers: [],
    searchStrategies: []
  };
}

describe("control defaults", () => {
  it("provides stable empty-selection controls", () => {
    expect(defaultParameterControls(null)).toEqual({
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 1024, maxValue: 1024 },
      reasoningEffort: {
        defaultValue: "none",
        options: ["none"],
        supported: false
      },
      reasoningMode: {
        defaultValue: "standard",
        options: ["standard"],
        supported: false
      },
      stream: { defaultValue: false, supported: false },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    });
  });

  it("returns the decoded model controls without cloning them", () => {
    const selected = model({ modelId: "gpt", provider: "openai" });
    expect(defaultParameterControls(selected)).toBe(selected.parameterControls);
  });

  it("coerces finite numeric drafts and reasoning options", () => {
    const controls = defaultParameterControls(
      model({
        modelId: "gpt",
        parameterControls: {
          ...model({ modelId: "base", provider: "openai" }).parameterControls,
          reasoningEffort: {
            defaultValue: "medium",
            options: ["low", "medium", "high"],
            supported: true
          },
          reasoningMode: {
            defaultValue: "standard",
            options: ["standard", "pro"],
            supported: true
          }
        },
        provider: "openai"
      })
    );

    expect(coerceReasoningEffort("high", controls)).toBe("high");
    expect(coerceReasoningEffort("unsupported", controls)).toBe("low");
    expect(coerceReasoningMode("pro", controls)).toBe("pro");
    expect(coerceReasoningMode("unsupported", controls)).toBe("standard");
    expect(clampedNumber("8", 4, 1, 6)).toBe(6);
    expect(clampedNumber("invalid", 4, 1, 6)).toBe(4);
    expect(clampedNumber("-2", 4, 1)).toBe(1);
  });

  it("selects preferred, default, non-fake, then first catalog models", () => {
    const fake = model({ modelId: "fake", provider: "fake" });
    const defaultModel = model({ modelId: "default-model", provider: "openai" });
    const preferred = model({ modelId: "preferred", provider: "openrouter" });
    const models = catalog([fake, defaultModel, preferred]);

    expect(
      fallbackCatalogModel(models, {
        modelId: "preferred",
        provider: "openrouter"
      })
    ).toBe(preferred);
    expect(fallbackCatalogModel(models)).toBe(defaultModel);
    expect(
      fallbackCatalogModel({
        ...models,
        defaults: { ...models.defaults, modelId: "missing", provider: "missing" },
        models: [fake, preferred]
      })
    ).toBe(preferred);
    expect(fallbackCatalogModel(catalog([fake]))).toBe(fake);
    expect(fallbackCatalogModel(null)).toBeUndefined();
  });
});
