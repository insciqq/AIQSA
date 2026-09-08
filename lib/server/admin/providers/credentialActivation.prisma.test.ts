import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { normalizeProviderConnectionConfiguration, normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";

afterAll(() => prisma.$disconnect());

const NOW = new Date("2026-09-07T12:00:00.000Z");
const connectionConfiguration = {
  allowPrivateNetwork: false,
  apiRoot: "https://provider.example.test/v1",
  authenticationMode: "bearer",
  responseTimeoutMs: 300_000
};

/**
 * Every case runs inside one rolled-back transaction: nested service
 * transactions share it through the proxy, so no fixture escapes the
 * disposable database. A unique-constraint failure aborts the surrounding
 * Postgres transaction, so the conflict case owns its own fixture.
 */
async function fixture(run: (input: {
  connectionId: string;
  db: PrismaClient;
  repository: ReturnType<typeof createPrismaAdminProviderRepository>;
}) => Promise<void>) {
  const rolledBack = new Error("fixture_rollback");
  try {
    await prisma.$transaction(async (tx) => {
      const db = new Proxy(tx, { get(target, key) {
        if (key === "$transaction") {
          return (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(tx);
        }
        return Reflect.get(target, key);
      } }) as unknown as PrismaClient;
      const connectionId = randomUUID();
      await tx.providerConnection.create({
        data: {
          activatedAt: NOW,
          activeConfig: connectionConfiguration,
          activeVersion: 1,
          displayName: "Credential activation fixture",
          draftConfig: connectionConfiguration,
          draftVersion: 1,
          enabled: true,
          family: "openai_compatible",
          id: connectionId
        }
      });
      await tx.providerModel.create({
        data: {
          activeConfig: Prisma.DbNull,
          activeVersion: 0,
          capabilities: {},
          connectionId,
          defaultParams: {},
          displayName: "Fixture model",
          draftConfig: {
            adapterKind: "openai_responses_compatible",
            answerSelectable: true,
            capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
            defaultParams: {},
            modelClass: "answer",
            upstreamModelId: "fixture/model"
          },
          draftVersion: 3,
          enabled: true,
          id: randomUUID(),
          modelClass: "answer",
          modelId: "fixture/model",
          provider: "openai_compatible"
        }
      });
      await run({ connectionId, db, repository: createPrismaAdminProviderRepository(db) });
      throw rolledBack;
    });
  } catch (error) {
    if (error !== rolledBack) throw error;
  }
}

describe("scoped credential activation CAS", () => {
  it("makes a fresh connection and its accessible model usable in the same transaction as the first key", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      await db.providerConnection.update({
        data: { activeConfig: Prisma.DbNull, activeVersion: 0, activatedAt: null, enabled: false },
        where: { id: connectionId }
      });
      const model = await db.providerModel.findFirstOrThrow({ where: { connectionId } });
      await db.providerModel.update({ data: { enabled: false }, where: { id: model.id } });
      const credentialId = randomUUID();
      const versionId = randomUUID();
      const latestId = randomUUID();
      const latestConfiguration = {
        ...normalizeProviderModelConfiguration(model.draftConfig), upstreamModelId: "fixture/latest"
      };
      const write = {
        catalogAdditions: [{
          configuration: latestConfiguration, displayName: "Latest fixture model", id: latestId,
          inputTokenPriceMicros: 0, outputTokenPriceMicros: 0, templateKey: null
        }],
        bootstrap: {
          configuration: normalizeProviderConnectionConfiguration(connectionConfiguration),
          models: [{
            configuration: normalizeProviderModelConfiguration(model.draftConfig),
            draftVersion: model.draftVersion,
            enabled: true,
            expectedEnabled: false,
            id: model.id
          }]
        },
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 0,
        modelChecks: [{
          evidence: { detail: "ok" as const, method: "models_catalog" as const, selectedProviders: [], upstreamModelId: "fixture/model" },
          modelVersion: model.draftVersion,
          providerModelId: model.id,
          status: "available" as const
        }, {
          evidence: { detail: "ok" as const, method: "models_catalog" as const, selectedProviders: [], upstreamModelId: "fixture/latest" },
          modelVersion: 1, providerModelId: latestId, status: "available" as const
        }],
        credential: { id: credentialId, kind: "new" as const, label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "synthetic-envelope-not-dispatched",
        versionId
      };
      // A concurrent model edit must reject the whole key/bootstrap write.
      await expect(repository.activateCredentialCas({ ...write, bootstrap: {
        ...write.bootstrap, models: [{ ...write.bootstrap.models[0]!, draftVersion: model.draftVersion + 1 }]
      } })).resolves.toBe("stale");
      expect(await db.providerCredential.count({ where: { connectionId } })).toBe(0);
      await expect(repository.activateCredentialCas(write)).resolves.toBe("updated");
      const [connection] = (await repository.listConnections()).filter(({ id }) => id === connectionId);
      expect(connection).toMatchObject({ enabled: true, activeVersion: 1, defaultCredentialId: credentialId });
      expect(connection!.models.find(({ id }) => id === model.id)).toMatchObject({ enabled: true, activeVersion: model.draftVersion });
      expect(connection!.activeChecks.find(({ providerModelId }) => providerModelId === model.id)).toMatchObject({
        connectionVersion: 1, credentialVersionId: versionId, modelVersion: model.draftVersion, status: "available"
      });
      expect(await repository.loadActiveRefreshCandidate({ connectionId, credentialId, providerModelId: model.id })).not.toBeNull();
      expect(connection!.models.find(({ id }) => id === latestId)).toMatchObject({ enabled: true, activeVersion: 1 });
      expect(await repository.loadActiveRefreshCandidate({ connectionId, credentialId, providerModelId: latestId })).not.toBeNull();
    });
  });

  it("creates an enabled credential with one active version and adopts it as the connection default", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      const credentialId = randomUUID();
      const versionId = randomUUID();
      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { id: credentialId, kind: "new", label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 2, version: 1 },
        versionEnvelope: "synthetic-envelope-not-dispatched",
        versionId
      })).resolves.toBe("updated");

      const credential = await db.providerCredential.findUniqueOrThrow({
        include: { activeVersion: true },
        where: { id: credentialId }
      });
      expect(credential).toMatchObject({
        activatedAt: NOW,
        activeVersionId: versionId,
        draftSecretEnvelope: null,
        draftVersion: 1,
        enabled: true,
        label: "Primary",
        testedAt: NOW
      });
      expect(credential.activeVersion).toMatchObject({
        revokedAt: null,
        secretEnvelope: "synthetic-envelope-not-dispatched",
        version: 1
      });
      const connection = await db.providerConnection.findUniqueOrThrow({
        select: { activeVersion: true, defaultCredentialId: true, draftVersion: true },
        where: { id: connectionId }
      });
      expect(connection).toEqual({ activeVersion: 1, defaultCredentialId: credentialId, draftVersion: 1 });
      const model = await db.providerModel.findFirstOrThrow({
        select: { activeConfig: true, activeVersion: true, draftVersion: true },
        where: { connectionId }
      });
      expect(model).toEqual({ activeConfig: null, activeVersion: 0, draftVersion: 3 });
    });
  });

  it("rotates only the exact credential, keeps the existing default and rejects a stale draft version", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      const first = randomUUID();
      const second = randomUUID();
      await repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { id: first, kind: "new", label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "first-envelope",
        versionId: randomUUID()
      });
      await repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { id: second, kind: "new", label: "Research team" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "second-envelope",
        versionId: randomUUID()
      });

      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { expectedDraftVersion: 7, id: second, kind: "rotate" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "never-written",
        versionId: randomUUID()
      })).resolves.toBe("stale");
      await expect(db.providerCredentialVersion.count({ where: { credentialId: second } })).resolves.toBe(1);

      const rotatedVersionId = randomUUID();
      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { expectedDraftVersion: 1, id: second, kind: "rotate" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "rotated-envelope",
        versionId: rotatedVersionId
      })).resolves.toBe("updated");

      const rotated = await db.providerCredential.findUniqueOrThrow({
        include: { versions: { orderBy: { version: "asc" } } },
        where: { id: second }
      });
      expect(rotated).toMatchObject({ activeVersionId: rotatedVersionId, draftSecretEnvelope: null, draftVersion: 2 });
      expect(rotated.versions.map(({ revokedAt, version }) => ({ revokedAt, version }))).toEqual([
        { revokedAt: null, version: 1 },
        { revokedAt: null, version: 2 }
      ]);
      await expect(db.providerConnection.findUniqueOrThrow({
        select: { defaultCredentialId: true },
        where: { id: connectionId }
      })).resolves.toEqual({ defaultCredentialId: first });
      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { expectedDraftVersion: 1, id: randomUUID(), kind: "rotate" },
        now: NOW,
        testEvidence: {},
        versionEnvelope: "never-written",
        versionId: randomUUID()
      })).resolves.toBe("credential_not_found");
    });
  });

  it("reports a duplicate label instead of writing a second credential", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      await repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { id: randomUUID(), kind: "new", label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "first-envelope",
        versionId: randomUUID()
      });
      await expect(db.providerCredential.count({ where: { connectionId } })).resolves.toBe(1);
      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        modelChecks: [],
        credential: { id: randomUUID(), kind: "new", label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "duplicate-envelope",
        versionId: randomUUID()
      })).resolves.toBe("label_taken");
    });
  });
});

describe("credential publication preserves immediate answer access", () => {
  it("publishes catalog access with the key and refuses a changed connection or model", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      const model = await db.providerModel.findFirstOrThrow({ where: { connectionId } });
      await db.providerModel.update({ data: { activatedAt: NOW, activeConfig: model.draftConfig as Prisma.InputJsonValue, activeVersion: 3 }, where: { id: model.id } });
      const credentialId = randomUUID();
      const versionId = randomUUID();
      const write = {
        checkedAt: NOW,
        connectionId,
        expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1,
        credential: { id: credentialId, kind: "new" as const, label: "Catalog access" },
        modelChecks: [{
          evidence: { detail: "ok" as const, method: "models_catalog" as const, selectedProviders: [], upstreamModelId: "fixture/model" },
          modelVersion: 3,
          providerModelId: model.id,
          status: "available" as const
        }],
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "synthetic-envelope-not-dispatched",
        versionId
      };
      await expect(repository.activateCredentialCas({ ...write, expectedConnectionVersion: 2 })).resolves.toBe("stale");
      await expect(repository.activateCredentialCas({ ...write, modelChecks: [{ ...write.modelChecks[0]!, modelVersion: 2 }] })).resolves.toBe("stale");
      await expect(db.providerCredential.count({ where: { connectionId } })).resolves.toBe(0);
      await expect(repository.activateCredentialCas(write)).resolves.toBe("updated");
      const check = await db.providerModelCredentialCheck.findFirstOrThrow({ where: { credentialVersionId: versionId } });
      expect(check).toMatchObject({ connectionVersion: 1, credentialId, modelVersion: 3, providerModelId: model.id, status: "available" });
      expect(check.evidence).toEqual(write.modelChecks[0]!.evidence);
    });
  });

  it("commits endpoint and all replacement keys together, and a stale key leaves the prior settings intact", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      const ids = [randomUUID(), randomUUID()];
      for (const [index, id] of ids.entries()) {
        await repository.activateCredentialCas({
          checkedAt: NOW, connectionId, expectedConnectionDraftVersion: 1, expectedConnectionVersion: 1,
          credential: { id, kind: "new", label: `Settings key ${index}` }, modelChecks: [], now: NOW,
          testEvidence: {}, versionEnvelope: `old-${index}`, versionId: randomUUID()
        });
      }
      await db.providerCredential.update({ data: { enabled: false }, where: { id: ids[1] } });
      const credentials = await db.providerCredential.findMany({ where: { connectionId }, orderBy: { label: "asc" } });
      const replacementWrites = credentials.map((credential, index) => ({
        credentialId: credential.id, expectedDraftVersion: credential.draftVersion, expectedVersionId: credential.activeVersionId!,
        modelChecks: [], replacement: { envelope: `new-${index}`, versionId: randomUUID() }, testEvidence: {}
      }));
      const write = {
        configuration: { ...connectionConfiguration, authenticationMode: "bearer" as const, apiRoot: "https://new.example.test/v1" },
        connectionId, credentials: replacementWrites, displayName: "Changed", expectedActiveVersion: 1,
        expectedDraftVersion: 1, now: NOW, unassignedPolicy: "use_default" as const
      };
      await expect(repository.saveConnectionSettingsCas({ ...write, credentials: replacementWrites.map((entry, index) =>
        index === 1 ? { ...entry, expectedDraftVersion: 99 } : entry) })).resolves.toBe("stale");
      expect((await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } })).activeConfig).toEqual(connectionConfiguration);
      expect(await db.providerCredentialVersion.count({ where: { credentialId: { in: ids } } })).toBe(2);
      await expect(repository.saveConnectionSettingsCas(write)).resolves.toBe("updated");
      const changed = await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(changed).toMatchObject({ activeConfig: write.configuration, activeVersion: 2, displayName: "Changed" });
      expect(await db.providerCredentialVersion.count({ where: { credentialId: { in: ids } } })).toBe(4);
      expect((await db.providerCredential.findUniqueOrThrow({ where: { id: ids[1] } })).enabled).toBe(false);
    });
  });
});
