// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { imageModelConfiguration } from "../../../domain/imageModels";
import { testImageCapabilities } from "./imageCapabilityProbe";
import { capabilitySetupIncomplete, initiallyVerifiedModelConfiguration, reusableCapabilitySetupEvidence } from "./initialCapabilitySetup";
import type { AdminProviderDraftTesterInput } from "./tester";

const now = { retryDelayMs: 0 };

const input: AdminProviderDraftTesterInput = {
  connection: { apiRoot: "https://provider.test/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 5000 },
  connectionDisplayName: "Fixture", connectionId: "connection", credentialId: "key", credentialVersionIdentity: "revision",
  initialSetup: true, mode: "tiny_generation", model: imageModelConfiguration("gpt-image-2", { profile: "openai" }),
  modelDisplayName: "Image", providerFamily: "openai", providerModelId: "image", secret: "test"
};

describe("independent image capability probes", () => {
  it("retains editing after a repeated OpenRouter 400 and recovers generation through Retry", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
    const rejected = () => Response.json({ error: {
      code: "invalid_parameter", param: "resolution", message: "private upstream content" } }, { status: 400 });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected())
      .mockImplementation(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const openrouter = { ...input, providerFamily: "openrouter", model: imageModelConfiguration("google/gemini-3.1-flash-image", {
      profile: "openrouter", parameters: { resolution: { type: "enum" as const, values: ["1K", "2K", "4K"] } }
    }) };
    const first = await testImageCapabilities(openrouter, { ...now, createFetch: () => fetchFn });
    expect(first.status).toBe("available");
    expect(first.evidence.capabilitySetup).toMatchObject({ checks: { imageGeneration: "incomplete", imageEditing: "verified" },
      attempts: { imageGeneration: { attempts: 2, reason: "invalid_input", httpStatus: 400,
        imageFailure: { category: "invalid_parameter", parameter: "resolution" } } } });
    expect(initiallyVerifiedModelConfiguration(openrouter.model, first.evidence).capabilities).toMatchObject({ imageGeneration: false, imageEditing: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const recovered = await testImageCapabilities({ ...openrouter, reuseSetupEvidence: first.evidence }, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(recovered.evidence.imageEditing).toEqual(first.evidence.imageEditing);
    expect(recovered.evidence.capabilitySetup?.attempts?.imageGeneration).toEqual({ attempts: 1, status: "verified", reason: "verified" });
    expect(initiallyVerifiedModelConfiguration(openrouter.model, recovered.evidence).capabilities).toMatchObject({ imageGeneration: true, imageEditing: true });
    expect(JSON.stringify(recovered)).not.toContain("private");
    for (const [, init] of fetchFn.mock.calls) expect(JSON.parse(String(init!.body))).toMatchObject({ resolution: "1K", n: 1,
      provider: { data_collection: "deny", allow_fallbacks: true } });
  });
  it.each(["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"])(
    "checks %s generation and editing independently and retries only its failed capability", async (upstreamModelId) => {
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}, { status: 503 }))
        .mockResolvedValueOnce(Response.json({}, { status: 503 }))
        .mockImplementation(async () => Response.json({ status: "completed", steps: [{ type: "model_output",
          content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }] }));
      const gemini = { ...input, model: imageModelConfiguration(upstreamModelId, { profile: "gemini" }), providerFamily: "gemini" };
      const result = await testImageCapabilities(gemini, { ...now, createFetch: () => fetchFn });
      expect(result.evidence.capabilitySetup?.checks).toMatchObject({ imageGeneration: "incomplete", imageEditing: "verified" });
      expect(result.evidence.imageEditing).toMatchObject({ adapterKind: "gemini_images_native", upstreamModelId, verified: true });
      expect(initiallyVerifiedModelConfiguration(gemini.model, result.evidence).capabilities).toMatchObject({ imageGeneration: false, imageEditing: true });
      const edited = JSON.parse(String(fetchFn.mock.calls[2]![1]!.body));
      expect(edited).toMatchObject({ model: upstreamModelId, input: [expect.anything(), { type: "image", mime_type: "image/png", data: expect.any(String) }] });
      await testImageCapabilities({ ...gemini, reuseSetupEvidence: result.evidence }, { ...now, createFetch: () => fetchFn });
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });

  it("asks once more after a Gemini 400 and verifies the capability within the same setup", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}, { status: 400 }))
      .mockImplementation(async () => Response.json({ status: "completed", steps: [{ type: "model_output",
        content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }] }));
    const gemini = { ...input, model: imageModelConfiguration("gemini-nano-banana-2.1", { profile: "gemini" }), providerFamily: "gemini" };
    const result = await testImageCapabilities(gemini, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("available");
    expect(result.evidence.capabilitySetup).toMatchObject({ checks: { imageGeneration: "verified", imageEditing: "verified" },
      attempts: { imageGeneration: { attempts: 2, status: "verified", reason: "verified" },
        imageEditing: { attempts: 1, status: "verified", reason: "verified" } } });
    expect(capabilitySetupIncomplete(result.evidence)).toBe(false);
  });

  it.each([401, 403, 404])("never asks again after HTTP %i", async (status) => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({}, { status }));
    const result = await testImageCapabilities(input, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.evidence.capabilitySetup?.attempts?.imageGeneration).toMatchObject({ attempts: 1, httpStatus: status });
  });

  it("reports the paid usage of a refused Gemini answer and leaves that capability unverified", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    const refused = () => Response.json({ status: "blocked", finish_reason: "SAFETY",
      usage: { total_input_tokens: 7, total_output_tokens: 2, total_tokens: 9, cost: 0.04 } });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused())
      .mockImplementation(async () => Response.json({ status: "completed", steps: [{ type: "model_output",
        content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }] }));
    const onProviderUsage = vi.fn();
    const gemini = { ...input, model: imageModelConfiguration("gemini-3.1-flash-image", { profile: "gemini" }), providerFamily: "gemini",
      onProviderUsage };
    const result = await testImageCapabilities(gemini, { ...now, createFetch: () => fetchFn });
    // Both refused answers are paid and reported, then the edit.
    expect(onProviderUsage).toHaveBeenNthCalledWith(1, { usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 }, reportedCostUsd: 0.04 });
    expect(onProviderUsage).toHaveBeenNthCalledWith(2, { usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 }, reportedCostUsd: 0.04 });
    expect(onProviderUsage).toHaveBeenCalledTimes(3);
    expect(result.evidence.capabilitySetup).toMatchObject({ checks: { imageGeneration: "incomplete", imageEditing: "verified" },
      attempts: { imageGeneration: { attempts: 2, status: "incomplete", reason: "semantic_inconclusive" } } });
    expect(result.evidence.imageGeneration).toBeUndefined();
  });

  it("settles two unsupported routes without enabling the model or paying again on Retry", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({}, { status: 404 }));
    const result = await testImageCapabilities(input, { ...now, createFetch: () => fetchFn });
    expect(result.status).toBe("unavailable");
    expect(result.evidence.capabilitySetup?.checks).toEqual({ modelAccess: "unsupported", imageGeneration: "unsupported", imageEditing: "unsupported" });
    expect(capabilitySetupIncomplete(result.evidence)).toBe(false);
    const reusable = reusableCapabilitySetupEvidence(result.evidence, input.model);
    expect(reusable).toBeDefined();
    expect(initiallyVerifiedModelConfiguration(input.model, result.evidence).capabilities.imageGeneration).toBe(false);
    await testImageCapabilities({ ...input, reuseSetupEvidence: reusable }, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("awaits persistence before the next paid request and retains proofs on an inconclusive full refresh", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    const events: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async () => {
      events.push("request");
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    });
    const first = await testImageCapabilities({ ...input, onSetupCheckpoint: async () => {
      await Promise.resolve(); events.push("persisted");
    } }, { ...now, createFetch: () => fetchFn });
    expect(events).toEqual(["request", "persisted", "request", "persisted"]);
    fetchFn.mockImplementation(async () => Response.json({}, { status: 503 }));
    const refreshed = await testImageCapabilities({ ...input, initialSetup: false, priorEvidence: first.evidence }, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(refreshed.evidence).toMatchObject({ imageGeneration: first.evidence.imageGeneration, imageEditing: first.evidence.imageEditing,
      capabilitySetup: { activation: "preserve", checks: { imageGeneration: "verified", imageEditing: "verified" },
        attempts: { imageGeneration: { attempts: 2, reason: "http_error", httpStatus: 503 } } } });
  });

  it("still tests editing after generation fails, preserves checkpoints and never grants vision", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const checkpoint = vi.fn();
    const outcome = await testImageCapabilities({ ...input, onSetupCheckpoint: checkpoint }, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[2]![0]).toBe("https://provider.test/v1/images/edits");
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("available");
    expect(outcome.evidence.capabilitySetup?.checks).toMatchObject({ imageGeneration: "incomplete", imageEditing: "verified" });
    expect(initiallyVerifiedModelConfiguration(input.model, outcome.evidence).capabilities).toMatchObject({ imageGeneration: false, imageEditing: true, vision: false });
    fetchFn.mockResolvedValueOnce(Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    await testImageCapabilities({ ...input, reuseSetupEvidence: outcome.evidence }, { ...now, createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});
