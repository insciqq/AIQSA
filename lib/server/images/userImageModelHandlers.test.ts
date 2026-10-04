import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { imageModelConfiguration } from "../../domain/imageModels";
import { decodeUserImageModelSettings } from "../../contracts/imageModels";
import { ProviderAdmissionError, type loadInstallationImageProviderRole } from "../providerRuntime/admission";
import { createUserImageModelHandlers } from "./userImageModelHandlers";
import { createUserImageModelService, UserImageModelError } from "./userImageModels";

const settings = { models: [{ id: "image-1", displayName: "GPT Image 2", providerName: "OpenAI", generation: true, editing: true, unavailableReason: null }],
  organizationDefaultId: "image-1", selectedId: null, effective: { id: "image-1", source: "organization" as const } };

function handlerFixture(status = "active") {
  const service = { read: vi.fn().mockResolvedValue(settings), select: vi.fn().mockResolvedValue(settings) };
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "user-1", user: { id: "user-1", status } });
  return { service, resolveAuth, handlers: createUserImageModelHandlers({ resolveAuth: resolveAuth as never, service }) };
}

const patch = (body: unknown) => new Request("http://localhost/api/me/image-models", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

describe("personal image model API", () => {
  it("authenticates before reading, never caches and binds every save to the signed-in user", async () => {
    const fixture = handlerFixture();
    fixture.resolveAuth.mockResolvedValueOnce(null);
    expect((await fixture.handlers.GET(new Request("http://localhost/api/me/image-models"))).status).toBe(401);
    const response = await fixture.handlers.GET(new Request("http://localhost/api/me/image-models"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(decodeUserImageModelSettings((await response.json()).imageModel)).toEqual(settings);
    expect(fixture.service.read).toHaveBeenCalledExactlyOnceWith("user-1");
    expect((await fixture.handlers.PATCH(patch({ providerModelId: "image-1" }))).status).toBe(200);
    expect((await fixture.handlers.PATCH(patch({ providerModelId: null }))).status).toBe(200);
    expect(fixture.service.select.mock.calls).toEqual([["user-1", "image-1"], ["user-1", null]]);
  });

  it("refuses inactive accounts, browser-supplied owners and parameters", async () => {
    const inactive = handlerFixture("disabled");
    expect((await inactive.handlers.PATCH(patch({ providerModelId: "image-1" }))).status).toBe(403);
    const fixture = handlerFixture();
    for (const body of [{ providerModelId: "image-1", userId: "user-2" }, { providerModelId: "image-1", parameters: { quality: "high" } },
      { providerModelId: "" }, {}, []]) {
      const response = await fixture.handlers.PATCH(patch(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "image_model_input_invalid" });
    }
    expect(fixture.service.select).not.toHaveBeenCalled();
    expect(inactive.service.select).not.toHaveBeenCalled();
  });

  it("answers an unpublished choice as a conflict and hides other failures", async () => {
    const fixture = handlerFixture();
    fixture.service.select.mockRejectedValueOnce(new UserImageModelError("image_model_not_published"));
    const conflict = await fixture.handlers.PATCH(patch({ providerModelId: "withdrawn" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "image_model_not_published" });
    fixture.service.read.mockRejectedValueOnce(new Error("private database detail"));
    const failure = await fixture.handlers.GET(new Request("http://localhost/api/me/image-models"));
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("private");
  });
});

const configuration = imageModelConfiguration("gpt-image-2", { profile: "openai" });

function serviceFixture(selectedId: string | null = null, defaultId: string | null = "image-1") {
  const tx = {
    publishedImageModel: { findUnique: vi.fn(async ({ where }: { where: { providerModelId: string } }) =>
      ["image-1", "image-2"].includes(where.providerModelId) ? { providerModelId: where.providerModelId } : null) },
    systemModelPolicy: { findUnique: vi.fn().mockResolvedValue({ imageProviderModelId: defaultId }) },
    userSettings: { upsert: vi.fn() }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<void>) => operation(tx)),
    systemModelPolicy: { findUnique: vi.fn().mockResolvedValue({ version: 6, imageProviderModelId: defaultId }) },
    userSettings: { findUnique: vi.fn().mockResolvedValue({ imageProviderModelId: selectedId }) },
    publishedImageModel: { findMany: vi.fn().mockResolvedValue([
      { providerModelId: "image-1", paramsJson: { quality: "low" }, providerModel: { displayName: "GPT Image 2", connection: { displayName: "OpenAI" } } },
      { providerModelId: "image-2", paramsJson: {}, providerModel: { displayName: "Second", connection: { displayName: "Gateway" } } }
    ]) },
    providerModel: { findUnique: vi.fn().mockResolvedValue(null) }
  };
  const loadRole = vi.fn<typeof loadInstallationImageProviderRole>(async (_db, input) => {
    if (input.providerModelId === "image-2") throw new ProviderAdmissionError("credential_revoked");
    return { configuration, authority: { providerModelId: input.providerModelId },
      snapshot: { model: { ...configuration, capabilities: { ...configuration.capabilities, imageEditing: false } } } } as never;
  });
  return { prisma, tx, loadRole, service: createUserImageModelService(prisma as unknown as PrismaClient, loadRole) };
}

describe("personal image model service", () => {
  it("lists every published model with its own usability and the effective choice", async () => {
    const following = serviceFixture();
    expect(await following.service.read("user-1")).toEqual({
      models: [
        { id: "image-1", displayName: "GPT Image 2", providerName: "OpenAI", generation: true, editing: false, unavailableReason: null },
        { id: "image-2", displayName: "Second", providerName: "Gateway", generation: false, editing: false, unavailableReason: "credential_unavailable" }
      ],
      organizationDefaultId: "image-1", selectedId: null, effective: { id: "image-1", source: "organization" }
    });
    expect(following.prisma.userSettings.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
    const chosen = serviceFixture("image-2");
    expect(await chosen.service.read("user-1")).toMatchObject({ selectedId: "image-2", effective: { id: "image-2", source: "personal" } });
  });

  it("saves only a published model and maps a concurrent withdrawal to the same refusal", async () => {
    const fixture = serviceFixture();
    await fixture.service.select("user-1", "image-2");
    expect(fixture.tx.userSettings.upsert).toHaveBeenCalledWith({ where: { userId: "user-1" },
      create: { userId: "user-1", imageProviderModelId: "image-2" }, update: { imageProviderModelId: "image-2" } });
    await fixture.service.select("user-1", null);
    expect(fixture.tx.publishedImageModel.findUnique).toHaveBeenCalledOnce();
    await expect(fixture.service.select("user-1", "unpublished")).rejects.toMatchObject({ code: "image_model_not_published" });
    expect(fixture.tx.userSettings.upsert).toHaveBeenCalledTimes(2);
    fixture.tx.userSettings.upsert.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("foreign key", { code: "P2003", clientVersion: "test" }));
    await expect(fixture.service.select("user-1", "image-1")).rejects.toMatchObject({ code: "image_model_not_published" });
  });

  it("shows image generation as not set up without an administrator default, whatever was left published or chosen", async () => {
    // A previous release cleared the default without withdrawing publications.
    const off = serviceFixture("image-2", null);
    expect(await off.service.read("user-1")).toEqual({ models: [], organizationDefaultId: null, selectedId: null, effective: null });
    expect(off.loadRole).not.toHaveBeenCalled();
    await expect(off.service.select("user-1", "image-2")).rejects.toMatchObject({ code: "image_model_not_published" });
    expect(off.tx.userSettings.upsert).not.toHaveBeenCalled();
    // Following the default stays possible and is what the next default applies to.
    await off.service.select("user-1", null);
    expect(off.tx.userSettings.upsert).toHaveBeenCalledWith({ where: { userId: "user-1" },
      create: { userId: "user-1", imageProviderModelId: null }, update: { imageProviderModelId: null } });
  });
});
