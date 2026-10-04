import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { imageModelConfiguration } from "../../domain/imageModels";
import { createPrismaImageGenerationService } from "../images/service";
import { imageGenerationTool } from "../tools/imageGeneration";
import type { ProviderRunRequest } from "../providers/types";
import type { StorageAdapter } from "../uploads/storage";
import { ProviderAdmissionError, type loadInstallationImageProviderRole } from "./admission";
import {
  createImageModelRoleResolver, decodeAcceptedImageGenerationPlan, sameAcceptedImageGenerationPlan, type AcceptedImageGenerationPlan
} from "./imageModelRole";

const model = imageModelConfiguration("gemini-3-pro-image", { profile: "gemini" });
const authority = { connectionId: "connection", connectionVersion: 1, providerModelId: "model", modelVersion: 1,
  credentialId: "credential", credentialVersionId: "credential-version" };
const plan: AcceptedImageGenerationPlan = { version: 1, policyVersion: 1, authority, parameters: {}, snapshot: {
  version: 1, connectionId: authority.connectionId, providerModelId: authority.providerModelId,
  credentialId: authority.credentialId, credentialVersionId: authority.credentialVersionId,
  connectionDisplayName: "Fixture", modelDisplayName: "Fixture image", providerFamily: "gemini", model,
  connection: { apiRoot: "https://provider.example/v1beta", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 5000 }
} };

type Role = Awaited<ReturnType<typeof loadInstallationImageProviderRole>>;
const openAi = imageModelConfiguration("gpt-image-2", { profile: "openai" });

/** Each published model loads its own role; nothing else is ever loaded. */
function roleFor(providerModelId: string, configuration = openAi): Role {
  const binding = { ...authority, providerModelId };
  return { configuration: { ...configuration, defaultParams: { quality: "medium", size: "1024x1024" } }, authority: binding,
    snapshot: { ...plan.snapshot, providerModelId, providerFamily: "openai", model: configuration } } as unknown as Role;
}

function database(input: {
  policy: { version: number; imagePublication: { providerModelId: string; paramsJson: unknown } | null } | null;
  settings?: { imagePublication: { providerModelId: string; paramsJson: unknown } | null } | null;
  model?: Record<string, unknown> | null;
}) {
  return {
    systemModelPolicy: { findUnique: vi.fn(async () => input.policy) },
    userSettings: { findUnique: vi.fn(async () => input.settings ?? null) },
    providerModel: { findUnique: vi.fn(async () => input.model ?? null) }
  };
}

const asDb = (value: ReturnType<typeof database>) => value as unknown as Parameters<typeof createImageModelRoleResolver>[0];
const published = (providerModelId: string, paramsJson: unknown = {}) => ({ providerModelId, paramsJson });

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
    const paramsJson = { mime_type: "image/png" };
    const db = database({ policy: { version: 1, imagePublication: published("model", paramsJson) } });
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async () => ({ configuration: model,
      authority, snapshot: plan.snapshot } as Role));
    const resolver = createImageModelRoleResolver(asDb(db), loadRole);
    expect(await resolver.resolve()).toBeNull();
    expect(await resolver.resolveFor({ kind: "project" })).toEqual({ ok: false, reason: "parameters_invalid",
      providerModelId: "model", source: "organization" });
    paramsJson.mime_type = "image/jpeg";
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

describe("published image model resolution", () => {
  it("keeps the no-argument path on the administrator default with its parameters over the model defaults", async () => {
    const db = database({ policy: { version: 4, imagePublication: published("default", { quality: "low" }) } });
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async (_db, input) => roleFor(input.providerModelId));
    const resolved = await createImageModelRoleResolver(asDb(db), loadRole).resolve();
    expect(resolved).toMatchObject({ version: 1, policyVersion: 4, authority: { providerModelId: "default" },
      parameters: { quality: "low", size: "1024x1024" } });
    expect(db.userSettings.findUnique).not.toHaveBeenCalled();
    expect(decodeAcceptedImageGenerationPlan(resolved)).toEqual(resolved);
  });

  it("uses the personal choice for personal runs and follows the default without one", async () => {
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async (_db, input) => roleFor(input.providerModelId));
    const chosen = database({ policy: { version: 2, imagePublication: published("default") },
      settings: { imagePublication: published("chosen", { quality: "high" }) } });
    expect(await createImageModelRoleResolver(asDb(chosen), loadRole).resolveFor({ kind: "personal", userId: "user" })).toMatchObject({
      ok: true, providerModelId: "chosen", source: "personal",
      plan: { policyVersion: 2, authority: { providerModelId: "chosen" }, parameters: { quality: "high", size: "1024x1024" } }
    });
    expect(chosen.userSettings.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user" } }));
    const following = database({ policy: { version: 2, imagePublication: published("default") }, settings: { imagePublication: null } });
    expect(await createImageModelRoleResolver(asDb(following), loadRole).resolveFor({ kind: "personal", userId: "user" }))
      .toMatchObject({ ok: true, providerModelId: "default", source: "organization" });
  });

  it("resolves Project runs on the administrator default without reading personal preferences", async () => {
    const db = database({ policy: { version: 2, imagePublication: published("default") },
      settings: { imagePublication: published("chosen") } });
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async (_db, input) => roleFor(input.providerModelId));
    expect(await createImageModelRoleResolver(asDb(db), loadRole).resolveFor({ kind: "project" }))
      .toMatchObject({ ok: true, providerModelId: "default", source: "organization" });
    expect(db.userSettings.findUnique).not.toHaveBeenCalled();
    expect(loadRole).toHaveBeenCalledExactlyOnceWith(expect.anything(), { providerModelId: "default" });
  });

  it.each([
    ["credential_revoked", { enabled: true, activeVersion: 1, activatedAt: new Date(), modelClass: "image",
      connection: { enabled: true, activeVersion: 1, activatedAt: new Date() } }, "credential_unavailable"],
    ["model_not_available", { enabled: true, activeVersion: 1, activatedAt: new Date(), modelClass: "image",
      connection: { enabled: true, activeVersion: 1, activatedAt: new Date() } }, "verification_required"],
    ["model_not_available", { enabled: false, activeVersion: 1, activatedAt: new Date(), modelClass: "image",
      connection: { enabled: true, activeVersion: 1, activatedAt: new Date() } }, "model_unavailable"],
    ["model_not_available", { enabled: true, activeVersion: 1, activatedAt: new Date(), modelClass: "image",
      connection: { enabled: false, activeVersion: 1, activatedAt: new Date() } }, "model_unavailable"],
    ["model_not_available", null, "model_unavailable"]
  ] as const)("names %s as %s and never substitutes another published model", async (code, row, reason) => {
    const db = database({ policy: { version: 3, imagePublication: published("default") },
      settings: { imagePublication: published("chosen") }, model: row as Record<string, unknown> | null });
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async (_db, input) => {
      if (input.providerModelId === "chosen") throw new ProviderAdmissionError(code);
      return roleFor(input.providerModelId);
    });
    expect(await createImageModelRoleResolver(asDb(db), loadRole).resolveFor({ kind: "personal", userId: "user" }))
      .toEqual({ ok: false, reason, providerModelId: "chosen", source: "personal" });
    expect(loadRole).toHaveBeenCalledExactlyOnceWith(expect.anything(), { providerModelId: "chosen" });
  });

  it("reports an unconfigured role without a model", async () => {
    const loadRole = vi.fn<typeof loadInstallationImageProviderRole>();
    for (const policy of [null, { version: 1, imagePublication: null }]) {
      const resolver = createImageModelRoleResolver(asDb(database({ policy })), loadRole);
      expect(await resolver.resolveFor({ kind: "personal", userId: "user" }))
        .toEqual({ ok: false, reason: "not_configured", providerModelId: null, source: "organization" });
      expect(await resolver.resolve()).toBeNull();
    }
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("fences the model, authority revision, policy version and parameters of an accepted plan", () => {
    expect(sameAcceptedImageGenerationPlan(plan, structuredClone(plan))).toBe(true);
    expect(sameAcceptedImageGenerationPlan({ ...plan, parameters: { aspect_ratio: "1:1", mime_type: "image/jpeg" } },
      { ...plan, parameters: { mime_type: "image/jpeg", aspect_ratio: "1:1" } })).toBe(true);
    for (const changed of [
      { ...plan, policyVersion: 2 },
      { ...plan, parameters: { aspect_ratio: "16:9" } },
      { ...plan, authority: { ...authority, providerModelId: "other" } },
      { ...plan, authority: { ...authority, credentialVersionId: "rotated" } },
      { ...plan, authority: { ...authority, modelVersion: 2 } }
    ]) expect(sameAcceptedImageGenerationPlan(changed, plan)).toBe(false);
  });
});
