import { describe, expect, it, vi } from "vitest";
import { createAdminProviderCatalogHandler, createAdminProviderModelCreateHandler, createAdminProviderModelUpdateHandler } from "./handlers";
import { createAdminProviderService, AdminProviderServiceError } from "./service";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { adminProviderModelConfiguration } from "./adminConfiguration";
import { createAdminProviderModel, getAdminProviderConnections, updateAdminProviderModel } from "@/components/admin/adminProvidersApi";
import { fixtureCheck, fixtureConnection, fixtureModel } from "@/components/admin/providers/providerFixtures";
import type { PrismaClient } from "@prisma/client";
import type { AdminProviderRepository } from "./repositoryContract";
import type { AdminProviderService } from "./service";

const auth = async () => ({ expiresAt: new Date("2030-01-01"), id: "session", userId: "admin",
  user: { id: "admin", displayName: "Admin", email: "admin@example.test", role: "admin", status: "active" } });

function harness() {
  const original = fixtureModel({ connectionId: "provider", id: "model", displayName: "Before" });
  let model = original;
  const history = Array.from({ length: 600 }, (_, index) => fixtureCheck({ providerModelId: model.id,
    credentialId: `historical-${index}`, credentialVersionId: `version-${index}` }));
  const connection = () => fixtureConnection({ id: "provider", displayName: "Provider", models: [model], activeChecks: history });
  const repository = { ...createPrismaAdminProviderRepository({} as PrismaClient),
    listConnections: vi.fn(async () => [connection()]),
    loadModelActivationCandidate: vi.fn<AdminProviderRepository["loadModelActivationCandidate"]>(async () => null),
    activateModelCas: vi.fn<AdminProviderRepository["activateModelCas"]>(async () => "updated"),
    updateModelDraft: vi.fn<AdminProviderRepository["updateModelDraft"]>(async (input) => {
      model = { ...model, displayName: input.displayName, draftVersion: model.draftVersion + 1,
        draftConfig: adminProviderModelConfiguration(input.configuration), updatedAt: "2026-09-10T10:00:00.000Z" };
      return "updated" as const;
    }),
    createModel: vi.fn<AdminProviderRepository["createModel"]>(async (input) => {
      model = { ...model, id: input.id, displayName: input.displayName, draftVersion: 1,
        draftConfig: adminProviderModelConfiguration(input.configuration) };
      return "created" as const;
    }) };
  const probe = vi.fn(async (): Promise<never> => { throw new Error("No provider replay"); });
  const service = createAdminProviderService({ repository, idFactory: () => "created-model", tester: { test: probe }, credentialTester: { test: probe } });
  const activateModel = vi.fn<AdminProviderService["activateModel"]>(async (value) => {
    value.onActivated?.();
    return { check: "checked" };
  });
  const deps = { resolveAuth: auth, service: { ...service, activateModel } };
  const patch = createAdminProviderModelUpdateHandler(deps);
  const post = createAdminProviderModelCreateHandler(deps);
  const get = createAdminProviderCatalogHandler(deps);
  const requests: string[] = [];
  let terminalBytes = 0;
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(new URL(String(url), "http://localhost"), init);
    requests.push(request.method);
    const response = request.method === "GET" ? await get(request) : request.method === "POST"
      ? await post(request, { params: { connectionId: "provider" } })
      : await patch(request, { params: { connectionId: "provider", modelId: "model" } });
    if (request.method === "GET") return response;
    const data = new Uint8Array(await response.arrayBuffer());
    terminalBytes = data.byteLength;
    return new Response(new ReadableStream({ start(controller) {
      // Exercise the real producer with every UTF-8 byte split at a transport boundary.
      for (const byte of data) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { status: response.status, headers: response.headers });
  };
  const body = { action: "update", activate: true, displayName: "Модель сохранена", configuration: original.draftConfig,
    expectedActiveVersion: original.activeVersion, expectedDraftVersion: original.draftVersion,
    expectedDisplayName: original.displayName, expectedUpdatedAt: original.updatedAt };
  return { service, activateModel, body, connection, fetcher, model: () => model, probe, repository, requests, terminalBytes: () => terminalBytes };
}

describe("bounded model save producer and browser reader", () => {
  it("finishes against a catalog larger than the former 69,304-character failure with a small receipt and canonical refresh", async () => {
    const f = harness();
    expect(JSON.stringify({ connections: [f.connection()] }).length).toBeGreaterThan(69_304);
    const result = await updateAdminProviderModel("provider", "model", f.body, f.fetcher, undefined, vi.fn());
    expect(result).toEqual({ ok: true, data: { connectionId: "provider", modelId: "model", displayName: "Модель сохранена",
      draftVersion: 2, saved: "configuration", publication: "active", checks: "checked" } });
    expect(f.terminalBytes()).toBeLessThan(1024);
    expect(await getAdminProviderConnections(f.fetcher)).toMatchObject({ ok: true, data: [{ models: [{ displayName: "Модель сохранена" }] }] });
    expect(f.requests).toEqual(["PATCH", "GET"]);
    expect(f.repository.updateModelDraft).toHaveBeenCalledOnce();
    expect(f.activateModel).toHaveBeenCalledOnce();
    expect(f.probe).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a non-2xx error separate from confirmed draft persistence (published: %s)", async (published) => {
    const f = harness();
    f.activateModel.mockImplementation(async (value) => {
      if (published) value.onActivated?.();
      throw new AdminProviderServiceError("provider_refresh_failed");
    });
    const result = await updateAdminProviderModel("provider", "model", f.body, f.fetcher, undefined, vi.fn());
    expect(result).toMatchObject({ ok: false, status: 502, error: { code: "provider_refresh_failed" }, receipt: {
      modelId: "model", displayName: "Модель сохранена", draftVersion: 2, saved: "configuration",
      publication: published ? "active" : "draft", checks: published ? "unknown" : "not_requested"
    } });
    expect(f.model().displayName).toBe("Модель сохранена");
    expect(f.repository.updateModelDraft).toHaveBeenCalledOnce();
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("does not activate a newer concurrent draft or claim the captured write was published", async () => {
    const f = harness();
    f.repository.loadModelActivationCandidate.mockResolvedValue({ connection: { id: "provider", family: "openai",
      activeVersion: 1, draftVersion: 1, draftConfiguration: {}, defaultCredential: null },
      model: { id: "model", displayName: "Concurrent", activeVersion: 1, draftVersion: 3, configuration: f.body.configuration } });
    f.activateModel.mockImplementation(f.service.activateModel);
    expect(await updateAdminProviderModel("provider", "model", f.body, f.fetcher, undefined, vi.fn()))
      .toMatchObject({ ok: false, status: 409, error: { code: "provider_draft_stale" }, receipt: {
        draftVersion: 2, displayName: "Модель сохранена", publication: "draft", checks: "not_requested"
      } });
    expect(f.repository.activateModelCas).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("returns the written model ID on create and never derives the receipt from a later catalog", async () => {
    const f = harness();
    f.activateModel.mockImplementation(async (value) => {
      value.onActivated?.();
      f.model().displayName = "Concurrent later rename";
      return { check: "failed" };
    });
    expect(await createAdminProviderModel("provider", { displayName: "Created", configuration: f.body.configuration, activate: true }, f.fetcher, undefined, vi.fn()))
      .toMatchObject({ ok: true, data: { modelId: "created-model", displayName: "Created", saved: "configuration", checks: "failed" } });
    expect(f.repository.listConnections).not.toHaveBeenCalled();
    expect(f.repository.createModel).toHaveBeenCalledOnce();
  });
});
