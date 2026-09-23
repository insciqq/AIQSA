import { describe, expect, it } from "vitest";
import { providerSetupModels } from "./setupModels";
import { providerModelTemplateIds } from "../../../domain/providerTemplates";

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
