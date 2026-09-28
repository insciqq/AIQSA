import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { imageModelConfiguration } from "../../domain/imageModels";
import { createPrismaImageGenerationService } from "../images/service";
import { imageGenerationTool } from "../tools/imageGeneration";
import type { ProviderRunRequest } from "../providers/types";
import type { StorageAdapter } from "../uploads/storage";
import type { loadInstallationImageProviderRole } from "./admission";
import { createImageModelRoleResolver, decodeAcceptedImageGenerationPlan, type AcceptedImageGenerationPlan } from "./imageModelRole";

const model = imageModelConfiguration("gemini-3-pro-image", { profile: "gemini" });
const authority = { connectionId: "connection", connectionVersion: 1, providerModelId: "model", modelVersion: 1,
  credentialId: "credential", credentialVersionId: "credential-version" };
const plan: AcceptedImageGenerationPlan = { version: 1, policyVersion: 1, authority, parameters: {}, snapshot: {
  version: 1, connectionId: authority.connectionId, providerModelId: authority.providerModelId,
  credentialId: authority.credentialId, credentialVersionId: authority.credentialVersionId,
  connectionDisplayName: "Fixture", modelDisplayName: "Fixture image", providerFamily: "gemini", model,
  connection: { apiRoot: "https://provider.example/v1beta", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 5000 }
} };

describe("Gemini image output admission", () => {
  it("advertises supported output and explains the distinction from PNG references", () => {
    const tool = imageGenerationTool(plan);
    expect(tool.inputSchema).toMatchObject({ properties: { parameters: { properties: {
      mime_type: { enum: ["image/jpeg"] }
    } } } });
    expect(tool.description).toContain("outputs JPEG only");
    expect(tool.description).toContain("PNG reference images are supported");
    expect(decodeAcceptedImageGenerationPlan(plan)).not.toBeNull();
    expect(decodeAcceptedImageGenerationPlan({ ...plan, parameters: { mime_type: "image/png" } })).toBeNull();
  });

  it("fails closed on unsupported saved role defaults and permits a corrected setting", async () => {
    const policy = { imageProviderModelId: "model", imageParamsJson: { mime_type: "image/png" }, version: 1 };
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => policy) } } as unknown as Parameters<typeof createImageModelRoleResolver>[0];
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async () => ({ configuration: model,
      authority, snapshot: plan.snapshot } as Awaited<ReturnType<typeof loadInstallationImageProviderRole>>));
    const resolver = createImageModelRoleResolver(db, loadRole);
    expect(await resolver.resolve()).toBeNull();
    policy.imageParamsJson.mime_type = "image/jpeg";
    expect(await resolver.resolve()).toMatchObject({ parameters: { mime_type: "image/jpeg" } });
  });

  it.each(["arguments", "accepted plan"])("rejects PNG in %s before a paid dispatch or storage mutation", async (from) => {
    const fetchFn = vi.fn<typeof fetch>();
    const db = { providerRunBinding: { findFirst: vi.fn(async () => ({ executionSnapshot: plan.snapshot })) } } as unknown as PrismaClient;
    const storage = { putObject: vi.fn() } as unknown as StorageAdapter;
    const service = createPrismaImageGenerationService(db, storage, { fetchFn });
    const parameters = { mime_type: "image/png" };
    await expect(service.execute({ id: "call", name: "generate_image", arguments: { prompt: "A blue circle", image_ids: [],
      ...(from === "arguments" ? { parameters } : {}) } }, {
      runId: "run", userId: "user", persistedToolCallId: "tool-call",
      request: { imagePlan: { ...plan, ...(from === "accepted plan" ? { parameters } : {}) } } as ProviderRunRequest
    })).rejects.toThrow("image_parameters_invalid");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
