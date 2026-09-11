import { describe, expect, it } from "vitest";
import { imageParameterDefinitions, normalizeImageGenerationParameters, normalizeImageModelConfiguration } from "./imageGeneration";

describe("image model controls", () => {
  it("limits Flash Lite image to 1K while retaining each Gemini model's controls", () => {
    const image = { profile: "gemini" as const };
    expect(normalizeImageGenerationParameters({ image_size: "1K", thinking_level: "minimal" }, image, "gemini-3.1-flash-lite-image"))
      .toEqual({ image_size: "1K", thinking_level: "minimal" });
    for (const image_size of ["2K", "4K"]) {
      expect(() => normalizeImageGenerationParameters({ image_size }, image, "gemini-3.1-flash-lite-image")).toThrow("image_parameters_invalid");
      for (const id of ["gemini-3.1-flash-image", "gemini-3-pro-image"]) {
        expect(normalizeImageGenerationParameters({ image_size }, image, id)).toEqual({ image_size });
      }
    }
    expect(imageParameterDefinitions(image, "gemini-2.5-flash-image")).not.toHaveProperty("image_size");
    expect(imageParameterDefinitions(image, "gemini-2.5-flash-image")).not.toHaveProperty("thinking_level");
  });

  it("keeps gateway restrictions and native model capabilities distinct", () => {
    expect(imageParameterDefinitions({ profile: "codex_lb" }, "gpt-image-2")).not.toHaveProperty("thinking_level");
    expect(() => normalizeImageGenerationParameters({ background: "transparent" }, { profile: "codex_lb" }, "gpt-image-2")).toThrow();
    expect(normalizeImageGenerationParameters({ background: "transparent" }, { profile: "openai" }, "gpt-image-2.5-sunburst")).toEqual({ background: "transparent" });
    expect(() => normalizeImageGenerationParameters({ input_fidelity: "high" }, { profile: "openai" }, "gpt-image-2")).toThrow();
    expect(() => normalizeImageGenerationParameters({ quality: "high" }, { profile: "gemini" }, "gemini-3.1-flash-image")).toThrow();
  });
  it("rejects arbitrary destination and generation overrides", () => {
    for (const value of [{ model: "other" }, { n: 100 }, { provider: {} }, { stream: true }, { size: "4096x4096" }, { size: "2049x1024" }]) {
      expect(() => normalizeImageGenerationParameters(value, { profile: "openai" }, "gpt-image-2")).toThrow("image_parameters_invalid");
    }
    expect(normalizeImageGenerationParameters({ size: "1536x1024", output_format: "webp", output_compression: 75 }, { profile: "openai" }, "gpt-image-2")).toHaveProperty("size", "1536x1024");
    expect(() => normalizeImageGenerationParameters({ output_format: "jpeg", background: "transparent" }, { profile: "openai" }, "gpt-image-1")).toThrow();
  });
  it("bounds routed metadata and exposes only advertised parameters", () => {
    const image = normalizeImageModelConfiguration({ profile: "openrouter", parameters: { resolution: { type: "enum", values: ["1K", "2K"] } } });
    expect(normalizeImageGenerationParameters({ resolution: "2K" }, image, "vendor/model")).toEqual({ resolution: "2K" });
    expect(() => normalizeImageGenerationParameters({ resolution: "4K" }, image, "vendor/model")).toThrow();
    expect(() => normalizeImageModelConfiguration({ profile: "openrouter", parameters: { provider: { type: "enum", values: ["other"] } } })).toThrow();
    expect(() => normalizeImageModelConfiguration({ profile: "openai", parameters: {} })).toThrow();
  });
});
