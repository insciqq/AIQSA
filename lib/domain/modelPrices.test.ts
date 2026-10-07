import { describe, expect, it } from "vitest";
import { ADMIN_MODEL_PRICE_FIELDS, modelClassPriceFields } from "../contracts/adminProviderModelPrices";
import { defaultProviderModels } from "./catalog";
import { catalogModelPriceClass, catalogModelPrices, catalogModelTokenPricing } from "./modelPrices";

describe("catalog token tariffs", () => {
  it("prices every real answer template, including fractional Luna rates", () => {
    for (const model of defaultProviderModels.filter(model => model.provider !== "fake")) {
      expect(model.inputTokenPriceUsdPerMillion, model.modelId).toBeGreaterThan(0);
      expect(model.outputTokenPriceUsdPerMillion, model.modelId).toBeGreaterThan(0);
      expect(model).toMatchObject(catalogModelPrices[`${model.provider}:${model.modelId}`]!);
    }
    expect(catalogModelTokenPricing("openrouter:openai/gpt-6-luna")).toMatchObject({
      inputTokenPriceUsdPerMillion: 0.1, cachedInputTokenPriceUsdPerMillion: 0.01, outputTokenPriceUsdPerMillion: 0.5
    });
  });

  it("carries OpenRouter's published default DeepSeek tariffs and keeps codex-lb out of the key space", () => {
    expect(catalogModelTokenPricing("openrouter:deepseek/deepseek-v4-pro-0813")).toEqual({ inputTokenPriceUsdPerMillion: 0.66,
      cachedInputTokenPriceUsdPerMillion: 0.022, cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: 1.98,
      webSearchPriceUsdPerThousand: null });
    expect(catalogModelTokenPricing("openrouter:deepseek/deepseek-v4.1-flash")).toEqual({ inputTokenPriceUsdPerMillion: 0.0198,
      cachedInputTokenPriceUsdPerMillion: 0.00291, cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: 0.396,
      webSearchPriceUsdPerThousand: null });
    expect(Object.keys(catalogModelPrices).filter(key => !/^(openai|anthropic|gemini|deepseek|openrouter):/u.test(key))).toEqual([]);
  });

  it("prices the OpenAI embedding deployment by input tokens and scopes every tariff to one model class", () => {
    expect(catalogModelTokenPricing("openai:text-embedding-3-large")).toEqual({ inputTokenPriceUsdPerMillion: 0.13,
      cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null,
      webSearchPriceUsdPerThousand: null });
    expect(catalogModelPriceClass("openai:text-embedding-3-large")).toBe("embedding");
    expect(catalogModelPriceClass("openai:gpt-6-sol")).toBe("answer");
    for (const key of ["openai:unlisted", "constructor", "__proto__", ""]) expect(catalogModelPriceClass(key)).toBeNull();
    for (const [key, pricing] of Object.entries(catalogModelPrices)) {
      const modelClass = catalogModelPriceClass(key);
      expect(modelClass, key).not.toBeNull();
      expect(pricing.inputTokenPriceUsdPerMillion, key).toBeGreaterThan(0);
      const priced = ADMIN_MODEL_PRICE_FIELDS.filter(field => pricing[field] != null);
      expect(priced.filter(field => !modelClassPriceFields(modelClass!).includes(field)), key).toEqual([]);
    }
  });

  it("carries each family's published per-search fee on its answer tariffs only", () => {
    const fee = (key: string) => catalogModelTokenPricing(key).webSearchPriceUsdPerThousand;
    for (const key of Object.keys(catalogModelPrices)) {
      const [family] = key.split(":");
      const expected = catalogModelPriceClass(key) !== "answer" ? null
        : family === "openai" || family === "anthropic" ? 10 : family === "gemini" ? 14 : null;
      expect(fee(key), key).toBe(expected);
    }
    // DeepSeek publishes no search fee; OpenRouter reports each call's cost.
    expect(fee("deepseek:deepseek-v4-pro")).toBeNull();
    expect(fee("openrouter:perplexity/sonar-pro-search")).toBeNull();
    expect(fee("openai:text-embedding-3-large")).toBeNull();
    expect(fee("openai:unlisted")).toBeNull();
    expect(defaultProviderModels.find(model => model.provider === "anthropic")?.webSearchPriceUsdPerThousand).toBe(10);
  });
});
