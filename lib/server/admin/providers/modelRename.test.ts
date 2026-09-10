import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { renameAdminProviderModel } from "@/components/admin/adminProvidersApi";
import { fixtureCheck, fixtureConnection, fixtureModel } from "@/components/admin/providers/providerFixtures";
import { createAdminProviderModelUpdateHandler } from "./handlers";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";

function harness({ count = 1, role = "admin", exists = true } = {}) {
  const model = fixtureModel({ connectionId: "provider", displayName: "Original model", enabled: false, id: "model" });
  let connection = fixtureConnection({
    activeChecks: [fixtureCheck({ credentialId: "key", providerModelId: model.id })],
    displayName: "Provider", id: model.connectionId, models: [model]
  });
  const updateMany = vi.fn(async ({ data }: { data: { displayName: string; updatedAt: Date } }) => {
    if (count === 1) connection = { ...connection, models: [{ ...model, displayName: data.displayName, updatedAt: data.updatedAt.toISOString() }] };
    return { count };
  });
  const repository = createPrismaAdminProviderRepository({ providerModel: {
    updateMany, findFirst: vi.fn(async () => exists ? { id: model.id } : null)
  } } as unknown as PrismaClient);
  const probe = vi.fn(async (): Promise<never> => { throw new Error("Provider must not be called for metadata"); });
  const service = createAdminProviderService({
    credentialTester: { test: probe }, tester: { test: probe },
    now: () => new Date(model.updatedAt),
    repository: { ...repository, listConnections: async () => [connection] }
  });
  const handler = createAdminProviderModelUpdateHandler({
    resolveAuth: async () => ({ expiresAt: new Date("2030-01-01T00:00:00.000Z"), id: "session", userId: "admin",
      user: { displayName: "Admin", email: "admin@example.test", id: "admin", role, status: "active" } }),
    service
  });
  const body = {
    displayName: "Renamed model", expectedActiveVersion: model.activeVersion,
    expectedDisplayName: model.displayName, expectedDraftVersion: model.draftVersion, expectedUpdatedAt: model.updatedAt
  };
  const requests: Request[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(url), "http://localhost"), init);
    requests.push(request.clone());
    return handler(request, { params: { connectionId: model.connectionId, modelId: model.id } });
  };
  return { body, connection: () => connection, fetcher, model, probe, requests, updateMany };
}

describe("model metadata save across browser API, handler, service and repository", () => {
  it("updates only name and monotonic metadata time without a credential, activation or provider calls", async () => {
    const f = harness();
    const before = f.connection();
    const result = await renameAdminProviderModel(f.model.connectionId, f.model.id, f.body, f.fetcher);
    expect(result).toEqual({ ok: true, data: { connectionId: f.model.connectionId, modelId: f.model.id,
      displayName: "Renamed model", draftVersion: f.model.draftVersion, saved: "name", publication: "not_requested", checks: "not_requested" } });
    expect(f.connection()).toEqual({ ...before, models: [{ ...f.model, displayName: "Renamed model",
      updatedAt: new Date(new Date(f.model.updatedAt).getTime() + 1).toISOString() }] });
    expect(f.updateMany).toHaveBeenCalledWith({
      data: { displayName: "Renamed model", updatedAt: new Date(new Date(f.model.updatedAt).getTime() + 1) },
      where: { activeVersion: f.model.activeVersion, connection: { family: { not: "fake" } }, connectionId: f.model.connectionId,
        displayName: f.model.displayName, draftVersion: f.model.draftVersion, id: f.model.id, updatedAt: new Date(f.model.updatedAt) }
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.method).toBe("PATCH");
    expect(f.requests[0]!.headers.get("accept")).toBeNull();
    expect(await f.requests[0]!.json()).toEqual({ ...f.body, action: "rename" });
    expect(f.probe).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(161), "bad\nname"])("rejects invalid names before mutation: %j", async (displayName) => {
    const f = harness();
    await expect(renameAdminProviderModel("provider", "model", { ...f.body, displayName }, f.fetcher))
      .resolves.toMatchObject({ ok: false, error: { code: "provider_name_invalid" } });
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
  });

  it.each([{ configuration: {} }, { activate: true }, { expectedUpdatedAt: "not-a-time" }, { expectedDraftVersion: -1 }])(
    "rejects execution fields and invalid guards on the metadata route: %j", async (patch) => {
      const f = harness();
      await expect(renameAdminProviderModel("provider", "model", { ...f.body, ...patch }, f.fetcher))
        .resolves.toMatchObject({ ok: false, error: { code: "provider_configuration_invalid" } });
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.probe).not.toHaveBeenCalled();
    }
  );

  it.each([
    { count: 0, role: "admin", exists: true, code: "provider_draft_stale" },
    { count: 0, role: "admin", exists: false, code: "provider_model_not_found" },
    { count: 1, role: "member", exists: true, code: "forbidden" }
  ])("rejects $code without contacting a provider", async ({ code, ...options }) => {
    const f = harness(options);
    const before = f.connection();
    await expect(renameAdminProviderModel("provider", "model", f.body, f.fetcher))
      .resolves.toMatchObject({ ok: false, error: { code } });
    expect(f.connection()).toEqual(before);
    expect(f.probe).not.toHaveBeenCalled();
  });
});
