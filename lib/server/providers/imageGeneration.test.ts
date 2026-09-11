// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createImageGenerationAdapter, validateGeneratedImage } from "./imageGeneration";
import { normalizeProviderModelConfiguration, type ProviderConnectionConfiguration, type ProviderModelConfiguration } from "./providerConfiguration";
import { normalizeImageGenerationParameters, type ImageProviderProfile } from "../../contracts/imageGeneration";
import { imageParametersFromCatalog } from "./imageModelDiscovery";

let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ae32c7" } }).png().toBuffer(); });
const connection: ProviderConnectionConfiguration = { apiRoot: "https://provider.example/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 5000 };
function model(profile: ImageProviderProfile): ProviderModelConfiguration {
  return {
    adapterKind: profile === "gemini" ? "gemini_images_native" : profile === "openrouter" ? "openrouter_images" : profile === "openai" ? "openai_images_native" : "openai_images_compatible",
    modelClass: "image", image: { profile }, upstreamModelId: profile === "gemini" ? "gemini-3.1-flash-image" : "gpt-image-2",
    answerSelectable: false, capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    defaultParams: {}, ...(profile === "openrouter" ? { openRouterRouting: { mode: "only_selected", providers: ["fixture"] } as const } : {})
  };
}
function response() { return Response.json({ data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 } }); }

describe("image adapters", () => {
  it.each([
    ["google/gemini-3.1-flash-image", ["512", "1K", "2K", "4K"], []],
    ["google/gemini-3.1-flash-lite-image", ["1K"], []],
    ["google/gemini-3-pro-image", ["1K", "2K", "4K"], []],
    ["google/gemini-2.5-flash-image", [], []],
    ["openai/gpt-image-2.5-sunburst", [], ["auto", "low", "medium", "high", "xhigh", "max"]],
    ["openai/gpt-image-2.5-flare", [], ["auto", "low", "medium", "high", "xhigh", "max"]]
  ] as const)("uses the %s endpoint descriptors for generation and editing", async (upstreamModelId, resolution, quality) => {
    const definitions = imageParametersFromCatalog({ ...(resolution.length ? { resolution: { type: "enum", values: [...resolution] } } : {}),
      ...(quality.length ? { quality: { type: "enum", values: [...quality] } } : {}), n: { type: "range", min: 1, max: 10 } });
    const image = { profile: "openrouter" as const, parameters: definitions };
    expect(() => normalizeImageGenerationParameters({ image_size: "1K" }, image, upstreamModelId)).toThrow();
    if (!(resolution as readonly string[]).includes("2K")) expect(() => normalizeImageGenerationParameters({ resolution: "2K" }, image, upstreamModelId)).toThrow();
    if (quality.length) expect(normalizeImageGenerationParameters({ quality: "max" }, image, upstreamModelId)).toEqual({ quality: "max" });
    const parameters = { ...(resolution.length ? { resolution: "1K" } : {}), ...(quality.length ? { quality: "low" } : {}) };
    const fetchFn = vi.fn<typeof fetch>(async () => response());
    const adapter = createImageGenerationAdapter({ connection, model: { ...model("openrouter"), upstreamModelId, image,
      openRouterRouting: { mode: "automatic", providers: [] } }, secret: "synthetic", fetchFn });
    await adapter.generate({ prompt: "A blue circle", parameters });
    await adapter.generate({ prompt: "Add a blue circle", parameters, images: [{ bytes: png, mimeType: "image/png" }] });
    for (const [url, init] of fetchFn.mock.calls) {
      expect(url).toBe("https://provider.example/v1/images");
      expect(JSON.parse(String(init!.body))).toMatchObject({ ...parameters, n: 1, model: upstreamModelId,
        provider: { data_collection: "deny", allow_fallbacks: true } });
    }
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)).input_references).toBeUndefined();
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body)).input_references).toHaveLength(1);
  });

  it("bounds rejected bodies and preserves the HTTP status without replay", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("private".repeat(5000), { status: 400 }));
    await expect(createImageGenerationAdapter({ connection, model: model("openrouter"), secret: "synthetic", fetchFn })
      .generate({ prompt: "A circle" })).rejects.toMatchObject({ message: "image_provider_http_error", httpStatus: 400,
        diagnostic: { category: "unknown" } });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("does not confer conversation capabilities on an image model", () => {
    expect(normalizeProviderModelConfiguration(model("openai")).modelClass).toBe("image");
    expect(() => normalizeProviderModelConfiguration({ ...model("openai"), answerSelectable: true })).toThrow();
    expect(() => normalizeProviderModelConfiguration({ ...model("openai"), modelClass: "answer" })).toThrow();
  });
  it("posts a fixed one-image request to the gateway's explicit /v1 route", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await createImageGenerationAdapter({ connection: { ...connection, apiRoot: "https://provider.example/backend-api/codex" }, model: model("codex_lb"), secret: "fixture-secret", fetchFn }).generate({ prompt: "A purple square", parameters: { size: "1024x1024", quality: "low" } });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://provider.example/v1/images/generations");
    expect(JSON.parse(String(init!.body))).toEqual({ model: "gpt-image-2", prompt: "A purple square", size: "1024x1024", quality: "low", n: 1 });
    expect(init!.headers).toMatchObject({ authorization: "Bearer fixture-secret" });
    expect(result).toMatchObject({ width: 32, height: 32, mimeType: "image/png", usage: { inputTokens: 12, costUsd: null } });
  });
  it("uses multipart edits containing real reference bytes without setting a wrong boundary", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createImageGenerationAdapter({ connection, model: model("openai"), secret: "fixture-secret", fetchFn }).generate({ prompt: "Make the square blue", images: [{ bytes: png, mimeType: "image/png" }] });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://provider.example/v1/images/edits");
    const form = init!.body as FormData;
    expect(form.get("prompt")).toBe("Make the square blue");
    expect(Buffer.from(await (form.get("image[]") as Blob).arrayBuffer())).toEqual(png);
    expect(init!.headers).not.toHaveProperty("content-type");
  });
  it.each(["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"])(
    "sends %s controls and omits thought images from the output", async (upstreamModelId) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "completed", steps: [
      { type: "thought", content: [{ type: "image", data: "private-draft" }] },
      { type: "model_output", content: [{ type: "image", data: png.toString("base64"), mime_type: "image/png" }] }
    ] }));
    const modern = upstreamModelId.startsWith("gemini-3");
    const thinking = upstreamModelId.startsWith("gemini-3.1-");
    const result = await createImageGenerationAdapter({ connection, model: { ...model("gemini"), upstreamModelId }, secret: "fixture-secret", fetchFn }).generate({ prompt: "Add a circle", images: [{ bytes: png, mimeType: "image/png" }], parameters: {
      ...(modern ? { image_size: "1K" } : {}), ...(thinking ? { thinking_level: "minimal" } : {})
    } });
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ model: upstreamModelId, store: false, stream: false,
      response_format: { type: "image", ...(modern ? { image_size: "1K" } : {}) },
      ...(thinking ? { generation_config: { thinking_level: "minimal" } } : {}) });
    if (!modern) expect(body.response_format.image_size).toBeUndefined();
    if (!thinking) expect(body.generation_config).toBeUndefined();
    expect(body.input[1].data).toBe(png.toString("base64"));
    expect(fetchFn.mock.calls[0]![1]!.headers).toMatchObject({ "x-goog-api-key": "fixture-secret" });
    expect(fetchFn.mock.calls[0]![1]!.headers).not.toHaveProperty("authorization");
    expect(result.bytes).toEqual(png);
    expect(result.usage.inputTokens).toBeNull();
  });
  it("preserves OpenRouter routing and privacy for generation and references", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createImageGenerationAdapter({ connection, model: model("openrouter"), secret: "fixture-secret", fetchFn }).generate({ prompt: "Add a circle", images: [{ bytes: png, mimeType: "image/png" }] });
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.provider).toEqual({ data_collection: "deny", allow_fallbacks: false, only: ["fixture"], order: ["fixture"] });
    expect(body.input_references[0].image_url.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });
  it("does not retry ambiguous paid requests or leak response text", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("private upstream detail fixture-secret", { status: 503 }));
    await expect(createImageGenerationAdapter({ connection, model: model("openai"), secret: "fixture-secret", fetchFn }).generate({ prompt: "A square" })).rejects.toMatchObject({ message: "image_provider_http_error", httpStatus: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("keeps a valid image when provider token counts cannot be stored", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: png.toString("base64") }],
      usage: { input_tokens: 2_147_483_648, output_tokens: -1, total_tokens: 3.5 }
    }));
    const result = await createImageGenerationAdapter({ connection, model: model("openai"), secret: "fixture-secret", fetchFn }).generate({ prompt: "A square" });
    expect(result.bytes).toEqual(png);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
  });
  it("validates outputs and refuses remote URLs, forged MIME or a corrupt raster", async () => {
    await expect(validateGeneratedImage(png, "image/jpeg")).rejects.toThrow("image_response_invalid");
    await expect(validateGeneratedImage(png.subarray(0, 32))).rejects.toThrow("image_response_invalid");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ url: "https://private.example/output" }] }));
    await expect(createImageGenerationAdapter({ connection, model: model("openai"), secret: "fixture-secret", fetchFn }).generate({ prompt: "A square" })).rejects.toThrow("image_response_invalid");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
