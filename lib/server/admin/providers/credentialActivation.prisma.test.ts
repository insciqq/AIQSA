import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";

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
            capabilities: {},
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
  it("creates an enabled credential with one active version and adopts it as the connection default", async () => {
    await fixture(async ({ connectionId, db, repository }) => {
      const credentialId = randomUUID();
      const versionId = randomUUID();
      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
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
        credential: { id: first, kind: "new", label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "first-envelope",
        versionId: randomUUID()
      });
      await repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
        credential: { id: second, kind: "new", label: "Research team" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "second-envelope",
        versionId: randomUUID()
      });

      await expect(repository.activateCredentialCas({
        checkedAt: NOW,
        connectionId,
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
        credential: { id: randomUUID(), kind: "new", label: "Primary" },
        now: NOW,
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "duplicate-envelope",
        versionId: randomUUID()
      })).resolves.toBe("label_taken");
    });
  });
});
