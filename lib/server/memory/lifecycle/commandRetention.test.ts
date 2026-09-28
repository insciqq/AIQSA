import { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { createPrismaMemoryLifecycleRepository } from "./repository";

vi.mock("../persistence/transaction", async (original) => ({
  ...await original<typeof import("../persistence/transaction")>(),
  withLockedMemoryTransaction: (tx: unknown, userId: string, apply: (tx: unknown, settings: unknown) => Promise<unknown>) =>
    apply(tx, { userId, memoryGeneration: 1, memoryRevision: 2, settingsRevision: 3, useMemoryFacts: true }),
  advanceMemoryMutation: async () => undefined
}));
vi.mock("../persistence/authorizations", async (original) => ({
  ...await original<typeof import("../persistence/authorizations")>(),
  consumeMemoryMutationAuthorization: async () => undefined
}));
vi.mock("../persistence/deletion", async (original) => ({
  ...await original<typeof import("../persistence/deletion")>(),
  enqueueMemoryDeletion: async () => ({ id: "deletion" })
}));
vi.mock("../learning/extraction/repository", async (original) => ({
  ...await original<typeof import("../learning/extraction/repository")>(),
  invalidateMemoryFactExtractionStaging: async () => undefined
}));

it("erases private command checkpoints in the same reset cancellation write", async () => {
  const stopAfterCancellation = new Error("stop_after_cancellation");
  const updated = vi.fn(async () => ({ count: 1 }));
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    memoryOperationReceipt: { findUnique: vi.fn(async () => null) },
    memorySourceBarrier: { create: vi.fn(async () => ({ id: "barrier" })),
      findFirst: vi.fn(async () => ({ createdAt: new Date() })) },
    memoryFact: { count: vi.fn(async () => 0) },
    memorySearchEntry: { deleteMany: updated },
    memoryRecallRoundSegment: { updateMany: updated },
    memoryRecallRound: { updateMany: updated },
    memoryRecallChunk: { updateMany: updated },
    memoryToolEvent: { updateMany: updated },
    chatMemoryCheckpoint: { deleteMany: updated },
    memoryJob: { updateMany: vi.fn(async () => { throw stopAfterCancellation; }) }
  };
  const keyring = MemorySuppressionKeyring.parse(
    `current=fixture,fixture=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 31)).toString("base64")}`
  );
  const registry = new MemoryDeletionContributorRegistry({ operation: "FORGET_PURGE", requirements: [{ id: "fixture", version: "v1" }] });
  const repository = createPrismaMemoryLifecycleRepository(keyring, registry, tx as never);
  await expect(repository.deleteAllReusable("owner", {
    authorization: { action: "BULK_DELETE", authorizationId: "authorization", authorizedPayloadHash: "a".repeat(64) },
    expectedMemoryRevision: 2, expectedSettingsRevision: 3,
    idempotencyFingerprint: "operation", idempotencyPayloadHash: "b".repeat(64),
    now: new Date(), operation: "DELETE_ALL_REUSABLE", requestId: "request"
  })).rejects.toBe(stopAfterCancellation);
  expect(tx.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ commandIntent: Prisma.DbNull, commandResult: Prisma.DbNull, state: "CANCELLED" }),
    where: expect.objectContaining({ userId: "owner" })
  }));
});

it("erases private command checkpoints in the master-pause cancellation", async () => {
  const stopAfterCancellation = new Error("stop_after_pause");
  const tx = {
    userMemorySettings: { updateMany: vi.fn(async () => ({ count: 1 })) },
    memoryPauseInterval: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async (_query: Prisma.Sql) => { throw stopAfterCancellation; })
  };
  const repository = createPrismaMemorySettingsRepository(tx as never);
  await expect(repository.patch("owner", { expectedSettingsRevision: 3, expectedMemoryRevision: 2, useMemoryFacts: false }))
    .rejects.toBe(stopAfterCancellation);
  expect(tx.$executeRaw).toHaveBeenCalledOnce();
  const query = tx.$executeRaw.mock.calls[0]![0];
  expect(query.sql).toContain('"commandIntent" = NULL');
  expect(query.sql).toContain('"commandResult" = NULL');
  expect(query.sql).toContain('"state" = \'CANCELLED\'');
});
