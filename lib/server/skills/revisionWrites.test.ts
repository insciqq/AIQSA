import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../uploads/storage";
import { createSkillBundle } from "./bundle";
import { createSkillBundleService } from "./bundleService";
import { createPrismaSkillRepository } from "./prismaRepository";

const draft = { name: "workflow", description: "Synthetic workflow", instructions: "Revised instructions" };

function databaseError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("synthetic_database_conflict", { code, meta, clientVersion: "test" });
}

function transactionFixture(version = 1, latestRevision = 1) {
  return {
    $queryRaw: vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => [{
      ownerUserId: "owner", archivedAt: null, deletedAt: null, version, currentRevisionId: "current"
    }]),
    skillDefinition: {
      findMany: vi.fn(async () => [{
        id: "skill", version, currentRevisionId: "current", currentRevision: { bundleDigest: "previous" }
      }]),
      findUniqueOrThrow: vi.fn(async () => ({ currentRevision: { files: [], frontmatterJson: null } })),
      update: vi.fn(async () => ({ id: "skill" }))
    },
    skillRevision: {
      aggregate: vi.fn(async () => ({ _max: { revisionNumber: latestRevision } })),
      create: vi.fn(async (_input: unknown) => ({ id: `revision-${latestRevision + 1}` })),
      update: vi.fn(async () => ({ id: "revision" }))
    },
    skillRevisionFile: { createMany: vi.fn(async () => ({ count: 1 })) },
    attachmentDeletionJob: { createMany: vi.fn(async () => ({ count: 1 })) }
  };
}

type TransactionWrite = (tx: Prisma.TransactionClient) => Promise<unknown>;

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const adapter = {
    putObject: vi.fn<StorageAdapter["putObject"]>(async (input) => { objects.set(input.storageKey, input.body); }),
    getObject: vi.fn<StorageAdapter["getObject"]>(async (storageKey) => ({
      storageKey, body: objects.get(storageKey)!, contentType: "application/octet-stream"
    })),
    deleteObject: vi.fn<StorageAdapter["deleteObject"]>(async (storageKey) => { objects.delete(storageKey); })
  } satisfies StorageAdapter;
  return adapter;
}

describe("Skill revision write conflicts", () => {
  it("restarts allocation after a collision and acquires the shared lock before the definition", async () => {
    const first = transactionFixture();
    first.skillRevision.create.mockRejectedValueOnce(databaseError("P2002", { target: ["skillId", "revisionNumber"] }));
    const second = transactionFixture(1, 2);
    const transactions = [first, second];
    const transact = vi.fn(async (write: TransactionWrite) => write(transactions.shift()! as unknown as Prisma.TransactionClient));
    const repository = createPrismaSkillRepository({ $transaction: transact } as unknown as PrismaClient);

    await expect(repository.revise("owner", "skill", 1, draft)).resolves.toEqual({ kind: "ok", skillId: "skill" });
    expect(transact).toHaveBeenCalledTimes(2);
    expect(second.skillRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ revisionNumber: 3 })
    }));
    for (const tx of [first, second]) {
      expect(tx.$queryRaw.mock.calls[0]![0].join("")).toContain("pg_advisory_xact_lock");
      expect(tx.$queryRaw.mock.calls[0]![1]).toBe("skill-import:owner");
      expect(tx.$queryRaw.mock.calls[1]![0].join("")).toContain("FOR UPDATE");
    }
  });

  it("rechecks the requested version on retry instead of overwriting a concurrent edit", async () => {
    const first = transactionFixture();
    first.skillRevision.create.mockRejectedValueOnce(databaseError("P2034"));
    const second = transactionFixture(2, 2);
    const transactions = [first, second];
    const transact = vi.fn(async (write: TransactionWrite) => write(transactions.shift()! as unknown as Prisma.TransactionClient));
    const repository = createPrismaSkillRepository({ $transaction: transact } as unknown as PrismaClient);

    await expect(repository.revise("owner", "skill", 1, draft)).resolves.toEqual({ kind: "version_conflict" });
    expect(transact).toHaveBeenCalledTimes(2);
    expect(second.skillRevision.create).not.toHaveBeenCalled();
    expect(second.skillDefinition.update).not.toHaveBeenCalled();
  });

  it.each([
    { name: "serialization", code: "P2034" },
    { name: "raw serialization", code: "P2010", meta: { code: "40001" } },
    { name: "raw deadlock", code: "P2010", meta: { code: "40P01" } },
    { name: "revision fields", code: "P2002", meta: { target: ["skillId", "revisionNumber"] } },
    { name: "revision constraint", code: "P2002", meta: { target: "SkillRevision_skillId_revisionNumber_key" } }
  ])("returns a stable conflict after three $name failures", async ({ code, meta }) => {
    const tx = transactionFixture();
    tx.skillRevision.create.mockRejectedValue(databaseError(code, meta));
    const transact = vi.fn(async (write: TransactionWrite) => write(tx as unknown as Prisma.TransactionClient));
    const repository = createPrismaSkillRepository({ $transaction: transact } as unknown as PrismaClient);

    await expect(repository.revise("owner", "skill", 1, draft)).resolves.toEqual({ kind: "version_conflict" });
    expect(transact).toHaveBeenCalledTimes(3);
    expect(tx.skillDefinition.update).not.toHaveBeenCalled();
  });

  it("does not hide an unrelated uniqueness failure as a version conflict", async () => {
    const error = databaseError("P2002", { target: ["revisionId", "path"] });
    const tx = transactionFixture();
    tx.skillRevision.create.mockRejectedValue(error);
    const transact = vi.fn(async (write: TransactionWrite) => write(tx as unknown as Prisma.TransactionClient));
    const repository = createPrismaSkillRepository({ $transaction: transact } as unknown as PrismaClient);

    await expect(repository.revise("owner", "skill", 1, draft)).rejects.toBe(error);
    expect(transact).toHaveBeenCalledTimes(1);
  });

  it("retries import staging without replaying object storage and uses the same owner lock", async () => {
    const tx = transactionFixture();
    let attempts = 0;
    const transact = vi.fn(async (write: TransactionWrite) => {
      const result = await write(tx as unknown as Prisma.TransactionClient);
      if (++attempts === 1) throw databaseError("P2034");
      return result;
    });
    const storage = memoryStorage();
    const service = createSkillBundleService({ $transaction: transact } as unknown as PrismaClient, storage);
    const bundle = createSkillBundle(draft, [{ path: "asset.bin", bytes: Buffer.from([0, 255]) }]);

    const result = await service.importCandidates("owner", [{ name: bundle.name, bundle }], 0);
    expect(result.results).toEqual([{ name: draft.name, outcome: "updated", skillId: "skill" }]);
    expect(transact).toHaveBeenCalledTimes(3); // Two staging attempts, then guarded promotion.
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.getObject).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0]![1]).toBe("skill-import:owner");
    expect(tx.$queryRaw.mock.calls[1]![1]).toBe("skill-import:owner");
  });

  it("reports exhausted import conflicts per candidate and continues the remaining imports", async () => {
    const tx = transactionFixture();
    let attempts = 0;
    const transact = vi.fn(async (write: TransactionWrite) => {
      if (++attempts <= 3) throw databaseError("P2002", { target: ["skillId", "revisionNumber"] });
      return write(tx as unknown as Prisma.TransactionClient);
    });
    const storage = memoryStorage();
    const service = createSkillBundleService({ $transaction: transact } as unknown as PrismaClient, storage);
    const first = createSkillBundle(draft);
    const second = createSkillBundle({ ...draft, name: "other-workflow" });

    expect((await service.importCandidates("owner", [
      { name: first.name, bundle: first }, { name: second.name, bundle: second }
    ], 0)).results).toEqual([
      { name: first.name, outcome: "failed", error: { code: "skill_version_conflict" } },
      { name: second.name, outcome: "updated", skillId: "skill" }
    ]);
    expect(transact).toHaveBeenCalledTimes(5);
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
