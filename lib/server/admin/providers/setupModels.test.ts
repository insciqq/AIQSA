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
