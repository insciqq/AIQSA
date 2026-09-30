import { catalogModelTokenPricing } from "../../../domain/modelPrices";
import { describe, expect, it } from "vitest";
import { providerSetupModels } from "./setupModels";
import { providerModelTemplateIds } from "../../../domain/providerTemplates";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS } from "../../../contracts/adminProviderQuickSetup";
import { initialAdminModelPricing } from "./providerModelPricing";

describe("image setup candidates", () => {
  it("offers the four Gemini image candidates with stable unique identities", () => {
    const images = providerSetupModels("gemini").filter((model) => model.configuration.modelClass === "image");
    expect(images.map((model) => model.configuration.upstreamModelId)).toEqual([
      "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"
    ]);
    expect(images[0]?.modelId).toBe("00000000-0000-4000-8000-000000001233");
    expect(new Set(images.map((model) => model.modelId)).size).toBe(4);
    for (const model of images) expect(model.configuration).toMatchObject({
      adapterKind: "gemini_images_native", answerSelectable: false, image: { profile: "gemini" }
    });
    expect(new Set(Object.values(providerModelTemplateIds)).size).toBe(Object.keys(providerModelTemplateIds).length);
  });

  it("offers six independent OpenRouter candidates without changing Flash Image identity", () => {
    const images = providerSetupModels("openrouter").filter((model) => model.configuration.modelClass === "image");
    expect(images.map(({ configuration }) => configuration.upstreamModelId)).toEqual([
      "google/gemini-3.1-flash-image", "google/gemini-3.1-flash-lite-image", "google/gemini-3-pro-image",
      "google/gemini-2.5-flash-image", "openai/gpt-image-2.5-sunburst", "openai/gpt-image-2.5-flare"
    ]);
    expect(images[0]?.modelId).toBe("00000000-0000-4000-8000-000000001234");
    expect(new Set(images.map(({ modelId }) => modelId)).size).toBe(6);
    for (const model of images) expect(model.configuration).toMatchObject({ adapterKind: "openrouter_images", modelClass: "image",
      answerSelectable: false, image: { profile: "openrouter" }, openRouterRouting: { mode: "automatic", providers: [] } });
  });

  it("preserves the single OpenAI initial image candidate", () => {
    expect(providerSetupModels("openai").filter((model) => model.configuration.modelClass === "image")).toHaveLength(1);
  });
});


describe("codex-lb catalog candidates", () => {
  it("recognizes existing Codex endpoints and uses the compatible Responses protocol without native background state", () => {
    const endpoint = { apiRoot: "https://fixture.example.test/backend-api/codex" };
    const candidates = providerSetupModels("openai_compatible", endpoint);
    expect(providerSetupModels("openai_compatible", { ...endpoint, responsesRequestIsolationDetected: true })).toEqual(candidates);
    expect(candidates.find(model => model.modelId === "codex-lb:gpt-6-sol")?.configuration).toMatchObject({
      adapterKind: "openai_responses_compatible", modelClass: "answer", upstreamModelId: "gpt-6-sol"
    });
    for (const candidate of candidates.filter(model => model.configuration.modelClass === "answer")) {
      expect(candidate.configuration.capabilities.nativeBackground).not.toBe(true);
      expect(candidate.configuration.defaultParams).not.toHaveProperty("background");
    }
  });

  it("requires a verified catalog marker on generic endpoints and respects a negative detection", () => {
    const endpoint = { apiRoot: "https://fixture.example.test/v1" };
    expect(providerSetupModels("openai_compatible", endpoint)).toEqual([]);
    expect(providerSetupModels("openai_compatible", { ...endpoint, responsesRequestIsolationDetected: true }).length).toBeGreaterThan(0);
    expect(providerSetupModels("openai_compatible", {
      apiRoot: "https://fixture.example.test/backend-api/codex", responsesRequestIsolationDetected: false
    })).toEqual([]);
  });
});

describe("setup model tariffs", () => {
  it("copies the matching OpenAI tariff to Codex models and leaves helpers unknown", () => {
    for (const model of providerSetupModels("openai_compatible", { apiRoot: "https://example.test/backend-api/codex" })) {
      const expected = catalogModelTokenPricing(`openai:${model.configuration.upstreamModelId}`);
      expect(model.inputTokenPriceUsdPerMillion).toEqual(expected.inputTokenPriceUsdPerMillion);
      expect(model.outputTokenPriceUsdPerMillion).toEqual(expected.outputTokenPriceUsdPerMillion);
      if (model.configuration.modelClass === "answer") expect(model).toMatchObject(expected);
    }
    for (const model of providerSetupModels("openrouter").filter(model => model.configuration.modelClass !== "answer")) {
      expect(model.inputTokenPriceUsdPerMillion).toBeNull();
      expect(model.outputTokenPriceUsdPerMillion).toBeNull();
    }
  });
});

describe("setup candidates and the stored catalog identity", () => {
  // Add & check, Test & Save and setup additions copy candidate prices into rows without a
  // template key on codex-lb and on second connections; the stored rule must agree with them.
  const cases: Array<[name: string, family: string, endpoint: { apiRoot: string }]> = [
    ["codex-lb", "openai_compatible", { apiRoot: "https://example.test/backend-api/codex" }],
    ...ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.map((family): [string, string, { apiRoot: string }] => [family, family, { apiRoot: "https://example.test/v1" }])
  ];
  it.each(cases)("prices every %s answer candidate like the row it becomes", (_name, family, endpoint) => {
    const answers = providerSetupModels(family, endpoint).filter(model => model.configuration.modelClass === "answer");
    expect(answers.length).toBeGreaterThan(0);
    for (const candidate of answers) {
      const pricing = initialAdminModelPricing({ modelClass: "answer", modelId: candidate.configuration.upstreamModelId, templateKey: null },
        { family, activeConfig: endpoint, draftConfig: endpoint });
      expect(pricing?.source, candidate.modelId).toBe("catalog");
      for (const [field, value] of Object.entries(pricing?.prices ?? {})) {
        expect(candidate[field as keyof NonNullable<typeof pricing>["prices"]] ?? null, `${candidate.modelId} ${field}`)
          .toEqual(value === null ? null : Number(value));
      }
    }
  });
});
