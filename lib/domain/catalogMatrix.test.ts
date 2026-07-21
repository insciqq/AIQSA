import { describe, expect, it } from "vitest";
import { defaultProviderModels, defaultSearchStrategies } from "./catalog";
import {
  availableSearchStrategiesForModel,
  buildCatalogModel,
  normalizeOpenRouterRoutePreferences,
  resolveSearchStrategyId
} from "./catalogMatrix";

describe("catalog capability matrix", () => {
  it("exposes native OpenAI web search and Perplexity as separate OpenAI strategies", () => {
    const model = defaultProviderModels.find((entry) => entry.provider === "openai" && entry.modelId === "gpt-5.5");

    expect(model).toBeDefined();
    expect(availableSearchStrategiesForModel(model!, defaultSearchStrategies).sort()).toEqual([
      "openai-native-web-search",
      "perplexity-tool-search",
      "search-disabled"
    ]);
  });

  it("keeps gpt-5.5 reasoning options aligned with accepted OpenAI effort values", () => {
    const model = defaultProviderModels.find((entry) => entry.provider === "openai" && entry.modelId === "gpt-5.5");

    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.parameterControls.reasoningEffort).toMatchObject({
      defaultValue: "medium",
      options: ["none", "low", "medium", "high", "xhigh"],
      supported: true
    });
    expect(model?.parameterControls.stream).toEqual({
      defaultValue: false,
      supported: true
    });
    expect(buildCatalogModel(model!, defaultSearchStrategies).capabilities.streaming).toBe(true);
  });

  it("publishes the GPT-5.6 family with its exact limits and model-specific reasoning controls", () => {
    const models = defaultProviderModels.filter(
      (entry) => entry.provider === "openai" && entry.modelId.startsWith("gpt-5.6-")
    );

    expect(models.map((model) => model.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna"
    ]);
    for (const model of models) {
      expect(model).toMatchObject({
        contextWindow: 1_050_000,
        defaultParams: {
          maxOutputTokens: 128_000,
          reasoning: {
            effort: "medium",
            mode: "standard"
          }
        },
        inputTokenPriceMicros: 0,
        outputTokenPriceMicros: 0,
        parameterControls: {
          maxOutputTokens: {
            defaultValue: 128_000,
            maxValue: 128_000
          },
          reasoningEffort: {
            defaultValue: "medium",
            options: ["none", "low", "medium", "high", "xhigh", "max"],
            supported: true
          },
          reasoningMode: {
            defaultValue: "standard",
            options: ["standard", "pro"],
            supported: true
          }
        }
      });
    }

    const gpt55 = defaultProviderModels.find(
      (entry) => entry.provider === "openai" && entry.modelId === "gpt-5.5"
    );
    expect(gpt55?.parameterControls.reasoningEffort.options).not.toContain("max");
    expect(gpt55?.parameterControls.reasoningMode).toBeUndefined();
  });

  it("distinguishes native PDF input from extracted PDF text in the catalog", () => {
    const openAI = defaultProviderModels.find((entry) => entry.provider === "openai" && entry.modelId === "gpt-5.5");
    const anthropic = defaultProviderModels.find((entry) => entry.provider === "anthropic");
    const openRouterClaude = defaultProviderModels.find((entry) => entry.modelId === "anthropic/claude-opus-4.8");
    const openRouterGemini = defaultProviderModels.find((entry) => entry.modelId === "google/gemini-3.5-flash");

    expect(buildCatalogModel(openAI!, defaultSearchStrategies).capabilities.documentInputMode).toBe("native_pdf");
    expect(buildCatalogModel(anthropic!, defaultSearchStrategies).capabilities.documentInputMode).toBe("native_pdf");
    expect(buildCatalogModel(openRouterClaude!, defaultSearchStrategies).capabilities.documentInputMode).toBe("native_pdf");
    expect(buildCatalogModel(openRouterGemini!, defaultSearchStrategies).capabilities.documentInputMode).toBe(
      "pdf_text_extraction"
    );
  });

  it("does not expose native Claude search for direct Anthropic models", () => {
    const model = defaultProviderModels.find((entry) => entry.provider === "anthropic");

    expect(model).toBeDefined();
    expect(availableSearchStrategiesForModel(model!, defaultSearchStrategies).sort()).toEqual(["search-disabled"]);
  });

  it("lets Claude-through-OpenRouter use Perplexity without native web search", () => {
    const model = defaultProviderModels.find((entry) => entry.modelId === "anthropic/claude-opus-4.8");
    const catalogModel = buildCatalogModel(model!, defaultSearchStrategies);

    expect(catalogModel.searchStrategyIds).toContain("perplexity-tool-search");
    expect(catalogModel.searchStrategyIds).not.toContain("openai-native-web-search");
  });

  it("resolves selected search strategy by saved default, disabled search, then fallback", () => {
    expect(
      resolveSearchStrategyId(
        {
          searchStrategyIds: ["perplexity-tool-search", "search-disabled"]
        },
        "perplexity-tool-search"
      )
    ).toBe("perplexity-tool-search");
    expect(
      resolveSearchStrategyId(
        {
          searchStrategyIds: ["perplexity-tool-search", "search-disabled"]
        },
        "openai-native-web-search"
      )
    ).toBe("search-disabled");
    expect(
      resolveSearchStrategyId(
        {
          searchStrategyIds: ["perplexity-tool-search", "search-disabled"]
        },
        "openai-native-web-search"
      )
    ).toBe("search-disabled");
    expect(
      resolveSearchStrategyId(
        {
          searchStrategyIds: ["perplexity-tool-search"]
        },
        "openai-native-web-search"
      )
    ).toBe("perplexity-tool-search");
  });

  it("keeps OpenRouter Gemini reasoning options on the model entry", () => {
    const flash = defaultProviderModels.find((entry) => entry.modelId === "google/gemini-3.5-flash");
    const pro = defaultProviderModels.find((entry) => entry.modelId === "~google/gemini-pro-latest");

    expect(flash?.parameterControls.reasoningEffort).toMatchObject({
      defaultValue: "medium",
      options: ["none", "minimal", "low", "medium", "high"],
      supported: true
    });
    expect(pro?.parameterControls.reasoningEffort).toMatchObject({
      defaultValue: "high",
      options: ["none", "minimal", "low", "medium", "high"],
      supported: true
    });
    expect(buildCatalogModel(flash!, defaultSearchStrategies).capabilities.background).toBe(false);
  });

  it("normalizes OpenRouter route-provider preferences", () => {
    expect(
      normalizeOpenRouterRoutePreferences({
        provider: {
          allow_fallbacks: false,
          dataCollection: "deny",
          order: ["Anthropic"],
          only: ["Anthropic"],
          require_parameters: true,
          sort: "latency",
          zdr: true
        }
      })
    ).toEqual({
      allowFallbacks: false,
      dataCollection: "deny",
      order: ["Anthropic"],
      only: ["Anthropic"],
      requireParameters: true,
      sort: "latency",
      zdr: true
    });
  });
});
