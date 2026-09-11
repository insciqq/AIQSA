import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../../prisma";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { providerSetupModels } from "./setupModels";
import { initialModelConfiguration } from "./initialCapabilitySetup";
import { createAdminProviderDraftTester } from "./tester";

const KEY = Buffer.alloc(32, 23);
afterAll(() => prisma.$disconnect());

async function fixture(run: (input: { connectionId: string; credentialId: string; credentialVersionId: string }) => Promise<void>) {
  const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID();
  const configuration = { allowPrivateNetwork: false, apiRoot: "https://openrouter.example.test/api/v1", authenticationMode: "bearer", responseTimeoutMs: 300_000 };
  try {
    await prisma.providerConnection.create({ data: { id: connectionId, family: "openrouter", displayName: "Synthetic catalog connection", enabled: true,
      activeVersion: 1, draftVersion: 1, activatedAt: new Date(), activeConfig: configuration, draftConfig: configuration } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Synthetic key", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(), testedAt: new Date(),
      secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: credentialVersionId, key: KEY, secret: "synthetic-key" }), testEvidence: {} } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    await run({ connectionId, credentialId, credentialVersionId });
  } finally {
    await prisma.$transaction(async (tx) => {
      await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
      await tx.providerDraftCheck.deleteMany({ where: { connectionId } });
      await tx.providerModel.deleteMany({ where: { connectionId } });
      await tx.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
      await tx.providerCredential.updateMany({ where: { id: credentialId }, data: { activeVersionId: null } });
      await tx.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await tx.providerCredential.deleteMany({ where: { id: credentialId } });
      await tx.providerConnection.deleteMany({ where: { id: connectionId } });
    });
  }
}

const presets = providerSetupModels("openrouter").filter(({ configuration }) => configuration.modelClass === "image");

describe("persisted catalog selection", () => {
  it("merges concurrent per-ID skips, restores one after repository restart, and fences stale settings", async () => {
    await fixture(async ({ connectionId }) => {
      const repository = createPrismaAdminProviderRepository(prisma);
      expect((await prisma.providerConnection.findUniqueOrThrow({ where: { id: connectionId } })).catalogSkippedIds).toEqual([]);
      const results = await Promise.all(presets.slice(0, 2).map(({ modelId }) => repository.updateCatalogSkips({ connectionId,
        connectionVersion: 1, modelIds: [modelId], skip: true })));
      expect(results).toEqual(["updated", "updated"]);
      const restarted = createPrismaAdminProviderRepository(prisma);
      const read = async () => (await restarted.listConnections()).find(({ id }) => id === connectionId)!;
      expect((await read()).catalogSkippedIds).toEqual(presets.slice(0, 2).map(({ modelId }) => modelId).sort());
      expect(await restarted.updateCatalogSkips({ connectionId, connectionVersion: 1, modelIds: [presets[0]!.modelId], skip: false })).toBe("updated");
      expect((await read()).catalogSkippedIds).toEqual([presets[1]!.modelId]);
      expect(await restarted.updateCatalogSkips({ connectionId, connectionVersion: 2, modelIds: [presets[2]!.modelId], skip: true })).toBe("stale");
      expect((await read()).activeVersion).toBe(1);
    });
  });

  it("deduplicates committed concurrent additions and rejects a selection skipped before insertion", async () => {
    await fixture(async ({ connectionId, credentialId, credentialVersionId }) => {
      const repository = createPrismaAdminProviderRepository(prisma);
      const candidate = presets[0]!;
      const write = { connectionId, credentialId, credentialVersionId, connectionVersion: 1, now: new Date(), catalogSelectionIds: [candidate.modelId] };
      const model = { configuration: initialModelConfiguration(candidate.configuration), displayName: candidate.displayName,
        inputTokenPriceMicros: 0, outputTokenPriceMicros: 0, templateKey: null };
      expect(await Promise.all([1, 2].map(() => repository.addSetupModelsCas({ ...write, models: [{ ...model, id: randomUUID() }] })))).toEqual(["updated", "updated"]);
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
      expect(await prisma.providerModelCredentialCheck.count({ where: { connectionId } })).toBe(1);
      await repository.updateCatalogSkips({ connectionId, connectionVersion: 1, modelIds: [presets[1]!.modelId], skip: true });
      expect(await repository.addSetupModelsCas({ ...write, catalogSelectionIds: [presets[1]!.modelId],
        models: [{ ...model, id: randomUUID(), configuration: initialModelConfiguration(presets[1]!.configuration) }] })).toBe("stale");
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
    });
  });

  it("checks only selected catalog-listed additions, preserves successful editing on retry, and leaves defaults alone", async () => {
    await fixture(async ({ connectionId, credentialId, credentialVersionId }) => {
      const before = await Promise.all([prisma.modelPolicy.findMany(), prisma.systemModelPolicy.findMany()]);
      const completeSetup = vi.fn();
      const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: "invalid_parameter", param: "resolution" } }, { status: 400 }))
        .mockImplementation(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
      const catalog = vi.fn(async () => ({ method: "models_catalog" as const, modelIds: [],
        modelIdsByClass: { image: [presets[0]!.configuration.upstreamModelId, presets[2]!.configuration.upstreamModelId, "upstream-only"] } }));
      const service = createAdminProviderService({ repository: createPrismaAdminProviderRepository(prisma), completeSetup,
        credentialTester: { test: catalog }, tester: createAdminProviderDraftTester({ createFetch: () => fetchFn }), encryptionKey: () => KEY });
      const add = async () => {
        expect(await service.addCatalogModels({ connectionId, credentialId, expectedConnectionVersion: 1, expectedCredentialVersionId: credentialVersionId,
          modelIds: presets.slice(0, 2).map(({ modelId }) => modelId) })).toEqual({ unavailableModelIds: [presets[1]!.modelId] });
        const run = (await service.listConnections()).find(({ id }) => id === connectionId)!.checkRun!;
        expect(run.catalogModelIds).toEqual([presets[0]!.modelId]);
        await vi.waitFor(() => expect(service.checkRun({ connectionId, runId: run.id }).state).toBe("completed"));
      };
      await add();
      const partial = await prisma.providerModel.findFirstOrThrow({ where: { connectionId }, include: { activeCredentialChecks: true } });
      expect(partial.activeConfig).toMatchObject({ capabilities: { imageGeneration: false, imageEditing: true } });
      const proof = partial.activeCredentialChecks.find((check) => check.modelVersion === partial.activeVersion)!.evidence;
      await add();
      const current = await prisma.providerModel.findFirstOrThrow({ where: { connectionId }, include: { activeCredentialChecks: true } });
      expect(current.id).toBe(partial.id);
      expect(current.activeConfig).toMatchObject({ capabilities: { imageGeneration: true, imageEditing: true } });
      expect(current.activeCredentialChecks.find((check) => check.modelVersion === current.activeVersion)!.evidence)
        .toMatchObject({ imageEditing: (proof as Record<string, unknown>).imageEditing });
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(catalog).toHaveBeenCalledTimes(2);
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
      expect(await prisma.providerCredentialVersion.count({ where: { credentialId } })).toBe(1);
      expect(await Promise.all([prisma.modelPolicy.findMany(), prisma.systemModelPolicy.findMany()])).toEqual(before);
      expect(completeSetup).not.toHaveBeenCalled();
    });
  });
});
