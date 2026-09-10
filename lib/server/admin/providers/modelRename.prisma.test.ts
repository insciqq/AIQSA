import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { adminProviderModelConfiguration } from "./adminConfiguration";

afterAll(() => prisma.$disconnect());

const NOW = new Date("2026-09-10T10:00:00.000Z");
const configuration = {
  adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer",
  upstreamModelId: "fixture/model", defaultParams: { temperature: 0.5 },
  capabilities: { toolCalling: true, nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: false, vision: false }
};

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); } finally {
    await prisma.$transaction(async (tx) => {
      await tx.providerModel.delete({ where: { id: f.modelId } });
      await tx.providerCredentialVersion.delete({ where: { id: f.versionId } });
      await tx.providerCredential.delete({ where: { id: f.credentialId } });
      await tx.providerConnection.delete({ where: { id: f.connectionId } });
    });
  }
}

async function createFixture() {
  const connectionId = randomUUID(), modelId = randomUUID(), credentialId = randomUUID(), versionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    const config = { allowPrivateNetwork: false, apiRoot: "https://unreachable.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 5000 };
    await tx.providerConnection.create({ data: { id: connectionId, displayName: "Metadata fixture", family: "openai_compatible",
      activeConfig: config, draftConfig: config, activeVersion: 2, draftVersion: 2, activatedAt: NOW, enabled: true } });
    await tx.providerModel.create({ data: { id: modelId, connectionId, provider: "openai_compatible", modelId: "fixture/model",
      displayName: "Original name", activeConfig: configuration, draftConfig: configuration, activeVersion: 3, draftVersion: 4,
      capabilities: configuration.capabilities, defaultParams: configuration.defaultParams, activatedAt: NOW, enabled: false, updatedAt: NOW } });
    await tx.providerCredential.create({ data: { id: credentialId, connectionId, label: "Revoked key", enabled: false } });
    await tx.providerCredentialVersion.create({ data: { id: versionId, credentialId, version: 1,
      secretEnvelope: null, testEvidence: {}, testedAt: NOW, activatedAt: NOW, revokedAt: NOW } });
    await tx.providerModelCredentialCheck.create({ data: { connectionId, providerModelId: modelId, credentialId, credentialVersionId: versionId,
      connectionVersion: 2, modelVersion: 3, status: "available", checkedAt: NOW,
      evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "fixture/model" } } });
    await tx.providerDraftCheck.create({ data: { connectionId, providerModelId: modelId, credentialId, credentialVersionId: versionId,
      connectionDraftVersion: 2, modelDraftVersion: 4, fingerprint: randomUUID(), status: "available", checkedAt: NOW,
      evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "fixture/model" } } });
  });
  const repository = createPrismaAdminProviderRepository(prisma);
  const probe = vi.fn(async (): Promise<never> => { throw new Error("Metadata cannot contact provider"); });
  const service = createAdminProviderService({ repository, tester: { test: probe }, credentialTester: { test: probe }, now: () => NOW });
  const guard = { expectedActiveVersion: 3, expectedDraftVersion: 4, expectedDisplayName: "Original name", expectedUpdatedAt: NOW.toISOString() };
  const current = () => prisma.providerModel.findUniqueOrThrow({ where: { id: modelId } });
  return { connectionId, modelId, credentialId, versionId, repository, service, probe, guard, current };
}

describe("model metadata concurrency and evidence preservation", () => {
  it("renames without altering configuration versions, disablement, checks or credentials", async () => fixture(async (f) => {
    const before = await f.current();
    const active = await prisma.providerModelCredentialCheck.findMany({ where: { providerModelId: f.modelId } });
    const draft = await prisma.providerDraftCheck.findMany({ where: { providerModelId: f.modelId } });
    const connection = await prisma.providerConnection.findUniqueOrThrow({ where: { id: f.connectionId } });
    const credential = await prisma.providerCredential.findUniqueOrThrow({ where: { id: f.credentialId } });
    await f.service.renameModel({ ...f.guard, connectionId: f.connectionId, modelId: f.modelId, displayName: "New name" });
    expect(await f.current()).toEqual({ ...before, displayName: "New name", updatedAt: new Date(NOW.getTime() + 1) });
    expect(await prisma.providerModelCredentialCheck.findMany({ where: { providerModelId: f.modelId } })).toEqual(active);
    expect(await prisma.providerDraftCheck.findMany({ where: { providerModelId: f.modelId } })).toEqual(draft);
    expect(await prisma.providerConnection.findUniqueOrThrow({ where: { id: f.connectionId } })).toEqual(connection);
    expect(await prisma.providerCredential.findUniqueOrThrow({ where: { id: f.credentialId } })).toEqual(credential);
    expect(f.probe).not.toHaveBeenCalled();
  }));

  it("allows exactly one simultaneous rename from the same baseline", async () => fixture(async (f) => {
    const results = await Promise.allSettled(["First name", "Second name"].map((displayName) => f.service.renameModel({
      ...f.guard, connectionId: f.connectionId, modelId: f.modelId, displayName
    })));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({ reason: { code: "provider_draft_stale" } });
    expect(["First name", "Second name"]).toContain((await f.current()).displayName);
    expect(f.probe).not.toHaveBeenCalled();
  }));

  it("rejects stale metadata and config edits in either write order", async () => fixture(async (f) => {
    const request = { ...f.guard, connectionId: f.connectionId, modelId: f.modelId, displayName: "New name" };
    await expect(f.service.renameModel({ ...request, connectionId: randomUUID() }))
      .rejects.toMatchObject({ code: "provider_model_not_found" });
    await f.service.renameModel(request);
    await expect(f.service.updateModelDraft({ ...f.guard, modelId: f.modelId, displayName: "Stale config name",
      configuration: adminProviderModelConfiguration(configuration) })).rejects.toMatchObject({ code: "provider_draft_stale" });
    const renamed = await f.current();
    const guard = { ...f.guard, expectedDisplayName: renamed.displayName, expectedUpdatedAt: renamed.updatedAt.toISOString() };
    await f.service.updateModelDraft({ ...guard, modelId: f.modelId, displayName: renamed.displayName,
      configuration: adminProviderModelConfiguration({ ...configuration, defaultParams: { temperature: 0.7 } }) });
    await expect(f.service.renameModel({ ...request, ...guard, displayName: "Stale metadata name" }))
      .rejects.toMatchObject({ code: "provider_draft_stale" });
    const changed = await f.current();
    expect(changed.displayName).toBe("New name");
    expect(changed.draftVersion).toBe(5);
    expect(changed.activeVersion).toBe(3);
    expect(f.probe).not.toHaveBeenCalled();
  }));
});
