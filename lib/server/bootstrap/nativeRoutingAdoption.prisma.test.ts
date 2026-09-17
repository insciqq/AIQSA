import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { adoptNativeOpenRouterRoutes } from "./nativeRoutingAdoption";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import type { AdminProviderDraftTester, AdminProviderDraftTesterInput } from "../admin/providers/tester";
import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";
import { createPrismaAdminProviderRepository } from "../admin/providers/prismaRepository";

const encryptionKey = Buffer.alloc(32, 41);
afterAll(() => prisma.$disconnect());

function evidence(input: Pick<AdminProviderDraftTesterInput, "model">): AdminProviderTestEvidence {
  return { method: "tiny_generation", detail: "ok", selectedProviders: input.model.openRouterRouting?.providers ?? [],
    upstreamModelId: input.model.upstreamModelId, embedding: { probeVersion: 1, document: true, query: true, dimensions: 1024 },
    compatibility: { probeVersion: 1, modelAccess: "verified", directPdf: "not_supported", streaming: "not_supported",
      structuredOutput: "not_supported", usage: "verified" } };
}

async function fixture(run: (context: {
  id: string; connectionId: string; keyIds: string[]; versionIds: string[];
  adopt(overrides?: { test?: AdminProviderDraftTester["test"]; nativeAvailable?: boolean }): ReturnType<typeof adoptNativeOpenRouterRoutes>;
  test: ReturnType<typeof vi.fn<AdminProviderDraftTester["test"]>>;
}) => Promise<void>, keyCount = 1, custom = false) {
  const connectionId = randomUUID(), id = randomUUID(), keyIds: string[] = [], versionIds: string[] = [];
  const configuration = normalizeProviderModelConfiguration({ modelClass: "embedding", adapterKind: "openai_embeddings_compatible", answerSelectable: false,
    upstreamModelId: "qwen/qwen3-embedding-8b", defaultParams: {},
    capabilities: { pdf: false, nativePdfInput: false, nativeSearch: false, vision: false, reasoning: false },
    embedding: { nativeDimension: 1024, targetDimension: 1024, supportsMrl: false, providerFamily: "openrouter", queryInstructionTemplate: null },
    openRouterRouting: { mode: custom ? "only_selected" : "automatic", providers: custom ? ["together"] : [] } });
  const connection = { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 300_000 };
  try {
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Native adoption fixture", family: "openrouter",
      enabled: true, activeConfig: connection, draftConfig: connection, activeVersion: 1, draftVersion: 1, activatedAt: new Date() } });
    for (let index = 0; index < keyCount; index += 1) {
      const credentialId = randomUUID(), versionId = randomUUID(); keyIds.push(credentialId); versionIds.push(versionId);
      await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: `Synthetic key ${index}`, enabled: true } });
      await prisma.providerCredentialVersion.create({ data: { id: versionId, credentialId, version: 1, testedAt: new Date(), activatedAt: new Date(),
        testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({
          credentialId, valueId: versionId, secret: "synthetic-native-key", key: encryptionKey }) } });
      await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: versionId, activatedAt: new Date() } });
    }
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: keyIds[0]! } });
    await prisma.providerModel.create({ data: { id, connectionId, displayName: "Native adoption fixture", provider: "openrouter", modelId: configuration.upstreamModelId,
      modelClass: "embedding", enabled: true, capabilities: configuration.capabilities as Prisma.InputJsonValue, defaultParams: {},
      activeConfig: configuration as Prisma.InputJsonValue, draftConfig: configuration as Prisma.InputJsonValue, activeVersion: 1, draftVersion: 1,
      activatedAt: new Date(), nativeRoutingAdoptionVersion: 0 } });
    for (let index = 0; index < keyCount; index += 1) await prisma.providerModelCredentialCheck.create({ data: {
      connectionId, providerModelId: id, connectionVersion: 1, modelVersion: 1, credentialId: keyIds[index]!, credentialVersionId: versionIds[index]!,
      status: "available", evidence: evidence({ model: configuration }) as unknown as Prisma.InputJsonValue, checkedAt: new Date()
    } });
    const test = vi.fn<AdminProviderDraftTester["test"]>(async (input) => {
      expect(typeof input.secret).toBe("function");
      expect(await (input.secret as () => Promise<string>)()).toBe("synthetic-native-key");
      return { status: "available", evidence: evidence(input) };
    });
    // The real repository, transactions and CAS races operate on PostgreSQL;
    // scope only the startup scan so another fixture's migration state is inert.
    const db = new Proxy(prisma, { get(target, key) {
      if (key === "providerModel") return new Proxy(target.providerModel, { get(delegate, method) {
        if (method === "findMany") return (args: Prisma.ProviderModelFindManyArgs) => delegate.findMany({ ...args,
          where: { AND: [args.where ?? {}, { id }] } });
        return Reflect.get(delegate, method);
      } });
      return Reflect.get(target, key);
    } }) as PrismaClient;
    const adopt = (overrides: { test?: AdminProviderDraftTester["test"]; nativeAvailable?: boolean } = {}) => adoptNativeOpenRouterRoutes({ db,
      encryptionKey: () => encryptionKey, tester: { test: overrides.test ?? test }, createDiscovery: () => ({
        listModels: async () => [], listEmbeddingModels: async () => [], listRerankModels: async () => [],
        listModelEndpoints: async () => overrides.nativeAvailable === false ? [] : [{ tag: "alibaba", providerName: "Alibaba", name: "Alibaba", supportedParameters: [] }]
      }) });
    await run({ id, connectionId, keyIds, versionIds, adopt, test });
  } finally {
    await prisma.providerModelCredentialCheck.deleteMany({ where: { providerModelId: id } });
    await prisma.providerModel.deleteMany({ where: { id } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId: { in: keyIds } } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
  }
}

describe("one-time native OpenRouter adoption", () => {
  it("publishes fresh proofs for every usable key atomically and never reruns after adoption", async () => {
    await fixture(async ({ id, adopt, test }) => {
      const before = await prisma.providerModelCredentialCheck.findMany({ where: { providerModelId: id }, orderBy: { id: "asc" } });
      expect(await adopt()).toMatchObject({ applied: 1 });
      expect(test).toHaveBeenCalledTimes(2);
      expect(await prisma.providerModel.findUnique({ where: { id } })).toMatchObject({ activeVersion: 2, draftVersion: 2,
        nativeRoutingAdoptionReason: "applied", activeConfig: { openRouterRouting: { mode: "only_selected", providers: ["alibaba"] } } });
      expect(await prisma.providerModelCredentialCheck.findMany({ where: { providerModelId: id, modelVersion: 1 }, orderBy: { id: "asc" } })).toEqual(before);
      expect(await prisma.providerModelCredentialCheck.count({ where: { providerModelId: id, modelVersion: 2, status: "available" } })).toBe(2);
      await adopt(); expect(test).toHaveBeenCalledTimes(2);
    }, 2);
  });

  it("leaves the working route when native discovery or a key probe fails", async () => {
    await fixture(async ({ id, adopt, test }) => {
      await adopt({ nativeAvailable: false });
      expect(test).not.toHaveBeenCalled();
      expect(await prisma.providerModel.findUnique({ where: { id } })).toMatchObject({ activeVersion: 1, nativeRoutingAdoptionReason: "native_unavailable" });
    });
    await fixture(async ({ id, adopt, test }) => {
      await adopt({ test: async (input) => {
        await test(input); throw new Error("crash-ambiguous synthetic provider failure");
      } });
      expect(await prisma.providerModel.findUnique({ where: { id } })).toMatchObject({ activeVersion: 1, nativeRoutingAdoptionReason: "verification_required" });
      await adopt(); expect(test).toHaveBeenCalledOnce();
    });
  });

  it("preserves custom routes without contacting a provider", async () => {
    await fixture(async ({ id, adopt, test }) => {
      await adopt(); expect(test).not.toHaveBeenCalled();
      expect(await prisma.providerModel.findUnique({ where: { id } })).toMatchObject({ activeVersion: 1,
        nativeRoutingAdoptionReason: "preserved", activeConfig: { openRouterRouting: { providers: ["together"] } } });
    }, 1, true);
  });

  it("protects an explicit Automatic edit made while the native check runs", async () => {
    await fixture(async ({ id, adopt, test }) => {
      await adopt({ test: async (input) => {
        const result = await test(input);
        const model = await prisma.providerModel.findUniqueOrThrow({ where: { id } });
        expect(await createPrismaAdminProviderRepository(prisma).updateModelDraft({ modelId: id, family: "openrouter", displayName: model.displayName,
          configuration: normalizeProviderModelConfiguration(model.activeConfig), expectedActiveVersion: model.activeVersion,
          expectedDraftVersion: model.draftVersion, expectedDisplayName: model.displayName, expectedUpdatedAt: model.updatedAt })).toBe("updated");
        return result;
      } });
      expect(await prisma.providerModel.findUnique({ where: { id } })).toMatchObject({ activeVersion: 1, draftVersion: 2,
        nativeRoutingAdoptionReason: "preserved", draftConfig: { openRouterRouting: { mode: "automatic" } } });
      await adopt(); expect(test).toHaveBeenCalledOnce();
    });
  });

  it("refuses publication after credential revocation", async () => {
    await fixture(async ({ id, versionIds, adopt, test }) => {
      await adopt({ test: async (input) => {
        const result = await test(input);
        await prisma.providerCredentialVersion.update({ where: { id: versionIds[0]! }, data: { revokedAt: new Date() } });
        return result;
      } });
      expect(await prisma.providerModel.findUnique({ where: { id } })).toMatchObject({ activeVersion: 1, nativeRoutingAdoptionReason: "verification_required" });
      expect(await prisma.providerModelCredentialCheck.count({ where: { providerModelId: id, modelVersion: 2 } })).toBe(0);
    });
  });

  it("claims one upgrade when two startup attempts overlap", async () => {
    await fixture(async ({ adopt, test }) => {
      const results = await Promise.all([adopt(), adopt()]);
      expect(results.reduce((sum, result) => sum + result.applied, 0)).toBe(1);
      expect(test).toHaveBeenCalledOnce();
    });
  });
});
