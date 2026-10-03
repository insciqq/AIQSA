import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MemoryDeletionClaim } from "../coordinator/types";
import { ACCOUNT_MEMORY_DELETION_TARGET_TYPE } from "./contract";
import { createPrismaAccountMemoryDeletionHandler } from "./handler";
import { createAccountMemoryDeletionHook } from "./integration";

const now = new Date("2026-09-28T10:00:00Z");
const claim: MemoryDeletionClaim = {
  admissionAuthorizationId: null, admittedActiveLeafMessageId: null,
  admittedChatSourceRevision: null, alsoForgetOriginMemories: null,
  attemptCount: 1, claimToken: "claim", id: "deletion",
  leaseExpiresAt: new Date(now.getTime() + 30_000), memoryGeneration: 2,
  operation: "ACCOUNT_MEMORY_DELETE", recoveredLease: false, resumedFromBlocked: false,
  targetId: "owner", targetType: ACCOUNT_MEMORY_DELETION_TARGET_TYPE, userId: "owner"
};

describe("account deletion command retention", () => {
  it("clears private checkpoints while admitting the durable deletion obligation", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ memoryGeneration: 1, ownerStatus: "disabled" }]),
      memoryIndexGeneration: { updateMany },
      userMemorySettings: { update: vi.fn(async () => ({})) },
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
      memoryExecutionBinding: { updateMany },
      memoryDeletionOutbox: { findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "deletion", state: "PENDING" })) }
    };
    const hook = createAccountMemoryDeletionHook({ kick: vi.fn() });
    expect(await hook.advance(tx as never, { now, userId: "owner" })).toEqual({
      admitted: true, deletionPending: true, readyForUserDeletion: false
    });
    expect(tx.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandIntent: Prisma.DbNull, commandResult: Prisma.DbNull,
        state: "CANCELLED", leaseToken: null }),
      where: expect.objectContaining({ userId: "owner" })
    }));
    expect(tx.memoryDeletionOutbox.create).toHaveBeenCalledOnce();
  });

  it("also clears checkpoints in the deletion worker's cancellation write", async () => {
    const stopAfterCancellation = new Error("stop_after_cancellation");
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ activeIndexGenerationId: null, decayEnabled: false,
        embeddingProviderModelId: null, learnAutomatically: false, memoryRevision: 3,
        ownerStatus: "disabled", referenceChatHistory: false, useMemoryFacts: false }]),
      chat: { count: vi.fn(async () => 0) }, modelRun: { count: vi.fn(async () => 0) },
      attachment: { count: vi.fn(async () => 0) }, sharedChatSnapshot: { count: vi.fn(async () => 0) },
      memoryJob: { updateMany: vi.fn(async () => { throw stopAfterCancellation; }) }
    };
    const result = await createPrismaAccountMemoryDeletionHandler().execute(claim, {
      now: () => now, signal: new AbortController().signal
    });
    await expect(result.apply!(tx as never, claim)).rejects.toBe(stopAfterCancellation);
    expect(tx.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandIntent: Prisma.DbNull, commandResult: Prisma.DbNull,
        state: "CANCELLED", leaseToken: null }),
      where: expect.objectContaining({ userId: "owner" })
    }));
  });
});
