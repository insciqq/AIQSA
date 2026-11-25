import { describe, expect, it, vi } from "vitest";
import { createImageModelDiscovery, imageModelsFromCatalog } from "./imageModelDiscovery";

describe("image discovery", () => {
  it("separates raster output from vision-only and SVG-only models and bounds advertised controls", () => {
    const models = imageModelsFromCatalog({ data: [
      { id: "chat/vision", architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
      { id: "vector/only", architecture: { output_modalities: ["image"] }, supported_parameters: { output_format: { type: "enum", values: ["svg"] } } },
      { id: "raster/edit", architecture: { input_modalities: ["image"], output_modalities: ["image"] }, supported_parameters: {
        output_format: { type: "enum", values: ["png", "svg"] }, seed: { type: "boolean" }, url: { type: "enum", values: ["https://untrusted.test"] }
      } }
    ] }, "openrouter");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "raster/edit", editing: true, source: "catalog", image: { parameters: {
      output_format: { type: "enum", values: ["png"] }, seed: { type: "range", min: 0, max: 2_147_483_647 }
    } } });
    expect(models[0]!.image.parameters).not.toHaveProperty("url");
  });
  it("recognizes native Gemini image models, Nano Banana 2.1 included, and leaves answer models out", () => {
    expect(imageModelsFromCatalog({ models: [
      { name: "models/gemini-nano-banana-2.1", displayName: "Nano Banana 2.1" }, { name: "models/gemini-3.1-flash-image" },
      { name: "models/gemini-4-hydrogen" }, { name: "models/gemini-3.8-flash-tts" }
    ] }, "gemini").map(({ id }) => id)).toEqual(["gemini-nano-banana-2.1", "gemini-3.1-flash-image"]);
  });
  it("offers explicitly unverified gateway candidates only for an unambiguous codex-lb catalog", () => {
    const presets = imageModelsFromCatalog({ data: [{ id: "chat", owned_by: "codex-lb" }] }, "openai_compatible");
    expect(presets.map(({ id }) => id)).toEqual(
      ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"]);
    for (const preset of presets) expect(preset).toMatchObject({ source: "preset", editing: true, image: { profile: "codex_lb" } });
    // A model the gateway lists itself is kept once, from its listing.
    expect(imageModelsFromCatalog({ data: [{ id: "gpt-image-2.6-flare", owned_by: "codex-lb" }] }, "openai_compatible")
      .filter(({ id }) => id === "gpt-image-2.6-flare")).toEqual([expect.objectContaining({ source: "catalog", image: { profile: "codex_lb" } })]);
    expect(imageModelsFromCatalog({ data: [{ id: "chat", owned_by: "codex-lb" }, { id: "other", owned_by: "other" }] }, "openai_compatible")).toEqual([]);
  });
  it("does not call native Anthropic or DeepSeek image discovery", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const family of ["anthropic", "deepseek"]) expect(await createImageModelDiscovery({
      connection: { apiRoot: "https://provider.test/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 5000 }, family, secret: "test", fetchFn
    }).models()).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
