// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { imageModelConfiguration } from "../../../domain/imageModels";
import { testImageCapabilities } from "./imageCapabilityProbe";
import { initiallyVerifiedModelConfiguration } from "./initialCapabilitySetup";
import type { AdminProviderDraftTesterInput } from "./tester";

const input: AdminProviderDraftTesterInput = {
  connection: { apiRoot: "https://provider.test/v1", allowPrivateNetwork: false, authenticationMode: "bearer", responseTimeoutMs: 5000 },
  connectionDisplayName: "Fixture", connectionId: "connection", credentialId: "key", credentialVersionIdentity: "revision",
  mode: "tiny_generation", model: imageModelConfiguration("gpt-image-2", { profile: "openai" }),
  modelDisplayName: "Image", providerFamily: "openai", providerModelId: "image", secret: "test"
};

describe("independent image capability probes", () => {
  it("still tests editing after generation fails, preserves checkpoints and never grants vision", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const checkpoint = vi.fn();
    const outcome = await testImageCapabilities({ ...input, onSetupCheckpoint: checkpoint }, { createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toBe("https://provider.test/v1/images/edits");
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("available");
    expect(outcome.evidence.capabilitySetup?.checks).toMatchObject({ imageGeneration: "incomplete", imageEditing: "verified" });
    expect(initiallyVerifiedModelConfiguration(input.model, outcome.evidence).capabilities).toMatchObject({ imageGeneration: false, imageEditing: true, vision: false });
    await testImageCapabilities({ ...input, reuseSetupEvidence: outcome.evidence }, { createFetch: () => fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
