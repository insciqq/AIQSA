import { describe, expect, it } from "vitest";
import { modelReleaseDate, modelReleaseDateKeys } from "./modelReleaseDates";
import { defaultProviderModels } from "./catalog";
import { providerModelTemplateIds } from "./providerTemplates";

describe("model release dates", () => {
  it("dates only real model templates with calendar dates", () => {
    expect(modelReleaseDateKeys.length).toBeGreaterThan(0);
    for (const key of modelReleaseDateKeys) {
      expect(Object.hasOwn(providerModelTemplateIds, key), key).toBe(true);
      expect(modelReleaseDate(key), key).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(new Date(`${modelReleaseDate(key)}T00:00:00Z`).toISOString().slice(0, 10), key).toBe(modelReleaseDate(key));
    }
  });

  it("dates every code-owned answer template so new models sort above old ones", () => {
    const undated = defaultProviderModels.filter((model) => model.provider !== "fake")
      .map((model) => `${model.provider}:${model.modelId}`).filter((key) => modelReleaseDate(key) === null);
    expect(undated).toEqual([]);
  });

  it("resolves codex-lb through the OpenAI model and leaves unknown templates undated", () => {
    expect(modelReleaseDate("openai:gpt-6-sol")).toBe("2026-09-22");
    expect(modelReleaseDate("codex-lb:gpt-6-sol")).toBe("2026-09-22");
    expect(modelReleaseDate("openrouter:~google/gemini-pro-latest")).toBe("2026-04-27");
    for (const key of [null, "", "codex-lb:gpt-image-2", "openai:gpt-image-2", "fake:fake-qsa",
      "openrouter:qwen/qwen3-embedding-8b", "constructor", "__proto__", "codex-lb:"]) {
      expect(modelReleaseDate(key), String(key)).toBeNull();
    }
  });
});
