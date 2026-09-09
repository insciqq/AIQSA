import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { normalizeProviderConnectionConfiguration, normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import type { ProviderCredentialActivationWrite } from "./repositoryContract";
import { createAdminProviderService } from "./service";

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

describe("Responses isolation credential binding", () => {
  async function setup(db: PrismaClient, connectionId: string,
    repository: ReturnType<typeof createPrismaAdminProviderRepository>, pendingDraft = false) {
    const model = await db.providerModel.findFirstOrThrow({ where: { connectionId } });
    await db.providerModel.update({ data: { activeConfig: model.draftConfig as Prisma.InputJsonValue,
      activatedAt: NOW, activeVersion: model.draftVersion }, where: { id: model.id } });
    const credentials = [];
    for (const label of ["Primary", "Disabled"]) {
      const id = randomUUID();
      const versionId = randomUUID();
      await repository.activateCredentialCas({ checkedAt: NOW, connectionId, expectedConnectionDraftVersion: 1,
        expectedConnectionVersion: 1, credential: { id, kind: "new", label }, modelChecks: [], now: NOW,
        testEvidence: {}, versionEnvelope: `synthetic-${label}`, versionId });
      credentials.push({ credentialId: id, expectedDraftVersion: 1, expectedVersionId: versionId });
    }
    await db.providerCredential.update({ data: { enabled: false, draftSecretEnvelope: "pending-disabled-draft" },
      where: { id: credentials[1]!.credentialId } });
    const configuration = { ...normalizeProviderConnectionConfiguration(connectionConfiguration),
      responsesRequestIsolation: "auto" as const, responsesRequestIsolationDetected: true };
    const draft = { ...configuration, ...(pendingDraft ? { responseTimeoutMs: 120_000 } : {}) };
    await db.providerConnection.update({ data: { activeConfig: configuration, draftConfig: draft,
      draftVersion: pendingDraft ? 5 : 1 }, where: { id: connectionId } });
    const modelChecks = [{ modelVersion: model.draftVersion, providerModelId: model.id, status: "available" as const,
      evidence: { detail: "ok" as const, method: "models_catalog" as const, selectedProviders: [], upstreamModelId: "fixture/model" } }];
    const proof = { ...modelChecks[0]!.evidence, method: "tiny_generation" as const,
      pdfInput: { adapterKind: "openai_responses_compatible" as const, probeVersion: 1 as const,
        upstreamModelId: "fixture/model", verified: true as const } };
    await db.providerModelCredentialCheck.create({ data: { checkedAt: NOW, connectionId, connectionVersion: 1,
      credentialId: credentials[0]!.credentialId, credentialVersionId: credentials[0]!.expectedVersionId,
      modelVersion: model.draftVersion, providerModelId: model.id, status: "available", evidence: proof } });
    const write: ProviderCredentialActivationWrite = { checkedAt: NOW, connectionId,
      expectedConnectionVersion: 1, expectedConnectionDraftVersion: pendingDraft ? 5 : 1,
      credential: { id: randomUUID(), kind: "new", label: "Added key" }, modelChecks, now: NOW,
      testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
      versionEnvelope: "synthetic-new-version", versionId: randomUUID(),
      isolationRefresh: { configuration: { ...configuration, responsesRequestIsolationDetected: false },
        credentials: credentials.map((credential) => ({ ...credential, modelChecks })) }
    };
    return { configuration, credentials, draft, model, modelChecks, proof, write };
  }

  it.each([false, true])("publishes detection and catalog checks atomically, preserving pending draft=%s and prior proof", async (pendingDraft) => {
    await fixture(async ({ db, connectionId, repository }) => {
      const { credentials, draft, proof, write } = await setup(db, connectionId, repository, pendingDraft);
      await expect(repository.activateCredentialCas(write)).resolves.toBe("updated");
      const connection = await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } });
      const version = pendingDraft ? 6 : 2;
      expect(connection).toMatchObject({ activeVersion: version, draftVersion: version + (pendingDraft ? 1 : 0),
        activeConfig: { responsesRequestIsolation: "auto", responsesRequestIsolationDetected: false, responseTimeoutMs: 300_000 } });
      expect(connection.draftConfig).toEqual(pendingDraft ? draft : write.isolationRefresh!.configuration);
      const checks = await db.providerModelCredentialCheck.findMany({ where: { connectionId, connectionVersion: version } });
      expect(checks).toHaveLength(3);
      for (const check of checks) expect(check.evidence).toEqual(write.modelChecks[0]!.evidence);
      expect((await db.providerModelCredentialCheck.findFirstOrThrow({ where: { connectionId, connectionVersion: 1 } })).evidence).toEqual(proof);
      expect(await db.providerCredentialVersion.count({ where: { credentialId: { in: credentials.map(({ credentialId }) => credentialId) } } })).toBe(2);
      expect(await db.providerCredential.findUniqueOrThrow({ where: { id: credentials[1]!.credentialId } }))
        .toMatchObject({ enabled: false, draftSecretEnvelope: "pending-disabled-draft", activeVersionId: credentials[1]!.expectedVersionId });
    });
  });

  it("rotates a key without replacing the unchanged connection tuple or another key's proof", async () => {
    await fixture(async ({ db, connectionId, repository }) => {
      const { credentials, configuration, proof, write } = await setup(db, connectionId, repository);
      const disabled = credentials[1]!;
      await expect(repository.activateCredentialCas({ ...write,
        credential: { id: disabled.credentialId, expectedDraftVersion: 1, kind: "rotate" },
        isolationRefresh: { ...write.isolationRefresh!, configuration }
      })).resolves.toBe("updated");
      expect(await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } }))
        .toMatchObject({ activeVersion: 1, draftVersion: 1, activeConfig: configuration });
      const prior = await db.providerModelCredentialCheck.findFirstOrThrow({ where: { credentialId: credentials[0]!.credentialId } });
      expect(prior.evidence).toEqual(proof);
      expect(await db.providerCredential.findUniqueOrThrow({ where: { id: disabled.credentialId } }))
        .toMatchObject({ enabled: false, activeVersionId: write.versionId, draftVersion: 2 });
    });
  });

  it("rejects missing disabled keys and stale key/model/draft catalogs before writing", async () => {
    await fixture(async ({ db, connectionId, repository }) => {
      const { write } = await setup(db, connectionId, repository);
      const refresh = write.isolationRefresh!;
      const staleWrites: ProviderCredentialActivationWrite[] = [
        { ...write, isolationRefresh: undefined },
        { ...write, isolationRefresh: { ...refresh, credentials: refresh.credentials.slice(0, 1) } },
        { ...write, isolationRefresh: { ...refresh, credentials: [refresh.credentials[0]!, refresh.credentials[0]!] } },
        { ...write, expectedConnectionDraftVersion: 2 },
        ...["expectedDraftVersion", "expectedVersionId", "modelChecks"].map((field) => ({ ...write,
          isolationRefresh: { ...refresh, credentials: refresh.credentials.map((credential, index) => index === 0 ? credential : ({
            ...credential, ...(field === "expectedDraftVersion" ? { expectedDraftVersion: 99 } :
              field === "expectedVersionId" ? { expectedVersionId: randomUUID() } :
              { modelChecks: [{ ...credential.modelChecks[0]!, modelVersion: 99 }] })
          })) }
        }))
      ];
      for (const stale of staleWrites) await expect(repository.activateCredentialCas(stale)).resolves.toBe("stale");
      expect(await db.providerCredential.count({ where: { connectionId } })).toBe(2);
      expect(await db.providerCredentialVersion.count({ where: { credential: { connectionId } } })).toBe(2);
      await db.providerCredentialVersion.update({ data: { revokedAt: NOW }, where: { id: refresh.credentials[1]!.expectedVersionId } });
      await expect(repository.activateCredentialCas(write)).resolves.toBe("stale");
      expect((await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } })).activeVersion).toBe(1);
    });
  });

  it("activation detects all live keys while publishing only referenced keys and fresh catalog proof", async () => {
    await fixture(async ({ db, connectionId, repository }) => {
      const { credentials, model, proof } = await setup(db, connectionId, repository);
      const candidate = await repository.loadActivationCandidate(connectionId);
      expect(candidate!.credentials.map(({ id }) => id)).toEqual([credentials[0]!.credentialId]);
      expect(candidate!.catalogCredentials).toEqual(expect.arrayContaining(credentials));
      expect(candidate!.catalogCredentials).toHaveLength(2);
      await db.providerDraftCheck.create({ data: { checkedAt: NOW, connectionId, connectionDraftVersion: 1,
        credentialId: credentials[0]!.credentialId, credentialVersionId: credentials[0]!.expectedVersionId,
        credentialDraftVersion: null, modelDraftVersion: model.draftVersion, providerModelId: model.id,
        status: "available", fingerprint: "synthetic-old-configuration-proof", evidence: proof } });
      let catalogCalls = 0;
      const service = createAdminProviderService({ repository: { ...repository,
        async activateConnectionCas(write) {
          await expect(repository.activateConnectionCas({ ...write, isolationRefresh: {
            ...write.isolationRefresh!, credentials: write.isolationRefresh!.credentials.slice(0, 1)
          } })).resolves.toBe("stale");
          return repository.activateConnectionCas(write);
        }
      }, now: () => NOW,
        tester: { async test() { throw new Error("Capability proof requires a separate fresh probe"); } },
        credentialTester: { async test() { return { method: "models_catalog", modelIds: ["fixture/model"],
          responsesRequestIsolationDetected: ++catalogCalls === 1 }; } }
      });
      await expect(service.activateConnection({ connectionId, confirmUnavailable: true, enableConnection: true }))
        .resolves.toEqual({ activatedCredentialCount: 1, activatedModelCount: 1, connectionVersion: 2 });
      expect(catalogCalls).toBe(2);
      const checks = await db.providerModelCredentialCheck.findMany({ where: { connectionId, connectionVersion: 2 } });
      expect(checks).toHaveLength(2);
      expect(checks.every(({ evidence }) => (evidence as Record<string, unknown>).method === "models_catalog" &&
        !("pdfInput" in (evidence as Record<string, unknown>)))).toBe(true);
      expect(await db.providerCredential.findUniqueOrThrow({ where: { id: credentials[1]!.credentialId } }))
        .toMatchObject({ enabled: false, activeVersionId: credentials[1]!.expectedVersionId, draftSecretEnvelope: "pending-disabled-draft" });
      expect((await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } })).activeConfig)
        .toMatchObject({ responsesRequestIsolationDetected: false });
    });
  });

  it("rejects a catalog snapshot if another live key appeared without changing detection", async () => {
    await fixture(async ({ db, connectionId, repository }) => {
      const { configuration, write } = await setup(db, connectionId, repository);
      await expect(repository.activateCredentialCas({ ...write,
        credential: { id: randomUUID(), kind: "new", label: "Concurrent key" }, versionId: randomUUID(),
        isolationRefresh: { ...write.isolationRefresh!, configuration }
      })).resolves.toBe("updated");
      await expect(repository.activateCredentialCas(write)).resolves.toBe("stale");
      expect(await db.providerCredential.count({ where: { connectionId } })).toBe(3);
      expect((await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } })).activeVersion).toBe(1);
    });
  });
});
