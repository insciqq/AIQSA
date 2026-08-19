import { Prisma } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import { ACCOUNT_MEMORY_DELETION_TARGET_TYPE } from "./contract";
import { inspectAccountMemoryDeletionResiduals } from "./handler";

export type AccountMemoryDeletionAdvance = Readonly<{
  admitted: boolean;
  deletionPending: boolean;
  readyForUserDeletion: boolean;
}>;

export type AccountMemoryDeletionHook = Readonly<{
  advance: (
    tx: Prisma.TransactionClient,
    input: Readonly<{ now: Date; userId: string }>
  ) => Promise<AccountMemoryDeletionAdvance>;
  kick: () => void;
}>;

type AccountDeletionRow = Readonly<{
  id: string;
  state: "BLOCKED_REQUIRES_ADMIN" | "CANCELLED" | "PENDING" | "RETRY_WAIT" | "RUNNING" | "SUCCEEDED";
}>;

async function lockAccountSettings(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<Readonly<{
  memoryGeneration: number;
  ownerStatus: string;
}>> {
  const [row] = await tx.$queryRaw<Array<{
    memoryGeneration: number;
    ownerStatus: string;
  }>>(Prisma.sql`
    SELECT
      settings."memoryGeneration",
      owner."status"::text AS "ownerStatus"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner ON owner."id" = settings."userId"
    WHERE settings."userId" = ${userId}
    FOR UPDATE OF owner, settings
  `);
  if (
    !row ||
    row.ownerStatus === "active" ||
    !Number.isSafeInteger(row.memoryGeneration) ||
    row.memoryGeneration < 0 ||
    row.memoryGeneration >= 2_147_483_647
  ) {
    throw new MemoryCoordinatorError("memory_account_deletion_admission_invalid", false);
  }
  return row;
}

async function fenceAndAdmit(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date
): Promise<AccountDeletionRow> {
  const settings = await lockAccountSettings(tx, userId);
  const nextGeneration = settings.memoryGeneration + 1;

  await tx.memoryIndexGeneration.updateMany({
    data: { state: "CANCELLED" },
    where: { state: { in: ["BUILDING", "CATCHING_UP", "READY"] }, userId }
  });
  await tx.memoryIndexGeneration.updateMany({
    data: { state: "SUPERSEDED", supersededAt: now },
    where: { state: "ACTIVE", userId }
  });
  await tx.userMemorySettings.update({
    data: {
      acceptedUtilityEgressAt: null,
      acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null,
      activeIndexGenerationId: null,
      embeddingProviderModelId: null,
      learnAutomatically: false,
      memoryConsentRevision: { increment: 1 },
      memoryGeneration: nextGeneration,
      memoryRevision: { increment: 1 },
      referenceChatHistory: false,
      settingsRevision: { increment: 1 },
      useMemoryFacts: false
    },
    where: { userId }
  });
  await tx.memoryJob.updateMany({
    data: {
      completedAt: now,
      errorCode: "memory_account_deletion",
      errorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      state: "CANCELLED",
      updatedAt: now
    },
    where: {
      state: {
        in: ["CLAIMED", "QUEUED", "RETRYABLE_FAILED", "WAITING_FOR_EGRESS_CONSENT"]
      },
      userId
    }
  });
  await tx.memoryExecutionBinding.updateMany({
    data: {
      completedAt: now,
      errorCode: "memory_account_deletion",
      state: "CANCELLED"
    },
    where: { state: "PENDING", userId }
  });
  return tx.memoryDeletionOutbox.create({
    data: {
      memoryGeneration: nextGeneration,
      operation: "ACCOUNT_MEMORY_DELETE",
      targetId: userId,
      targetType: ACCOUNT_MEMORY_DELETION_TARGET_TYPE,
      userId
    },
    select: { id: true, state: true }
  });
}

async function existingAccountDeletion(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<AccountDeletionRow | null> {
  const rows = await tx.memoryDeletionOutbox.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, state: true },
    take: 2,
    where: {
      operation: "ACCOUNT_MEMORY_DELETE",
      targetId: userId,
      targetType: ACCOUNT_MEMORY_DELETION_TARGET_TYPE,
      userId
    }
  });
  if (rows.length > 1) {
    throw new MemoryCoordinatorError("memory_account_deletion_duplicate", true);
  }
  return rows[0] ?? null;
}

async function advanceAccountDeletion(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; userId: string }>,
  admissionEnabled: boolean
): Promise<AccountMemoryDeletionAdvance> {
  if (!Number.isFinite(input.now.getTime())) {
    throw new MemoryCoordinatorError("memory_account_deletion_clock_invalid", false);
  }
  const existing = await existingAccountDeletion(tx, input.userId);
  if (!existing) {
    if (!admissionEnabled) {
      return { admitted: false, deletionPending: false, readyForUserDeletion: false };
    }
    await fenceAndAdmit(tx, input.userId, input.now);
    return { admitted: true, deletionPending: true, readyForUserDeletion: false };
  }
  if (existing.state === "CANCELLED") {
    await tx.memoryDeletionOutbox.update({
      data: {
        completedAt: null,
        errorCode: null,
        lastAuditAt: input.now,
        nextAttemptAt: null,
        state: "PENDING"
      },
      where: { id: existing.id }
    });
    return { admitted: true, deletionPending: true, readyForUserDeletion: false };
  }
  if (existing.state !== "SUCCEEDED") {
    return { admitted: false, deletionPending: true, readyForUserDeletion: false };
  }

  const residuals = await inspectAccountMemoryDeletionResiduals(tx, {
    deletionId: existing.id,
    userId: input.userId
  });
  if (residuals.length > 0) {
    await tx.memoryDeletionOutbox.update({
      data: {
        completedAt: null,
        errorCode: "memory_account_deletion_incomplete",
        lastAuditAt: input.now,
        nextAttemptAt: input.now,
        state: "RETRY_WAIT"
      },
      where: { id: existing.id }
    });
    return { admitted: true, deletionPending: true, readyForUserDeletion: false };
  }

  // The leaf retained only usage-backed, provider-detached immutable call
  // evidence. Global account deletion now owns the final removal of both
  // sides of that restrictive FK before deleting the user.
  await tx.usageEvent.deleteMany({
    where: { memoryExecutionBindingId: { not: null }, userId: input.userId }
  });
  await tx.memoryExecutionBinding.deleteMany({ where: { userId: input.userId } });
  await tx.memoryJob.deleteMany({ where: { userId: input.userId } });

  const deleted = await tx.memoryDeletionOutbox.deleteMany({
    where: {
      id: existing.id,
      operation: "ACCOUNT_MEMORY_DELETE",
      state: "SUCCEEDED",
      userId: input.userId
    }
  });
  if (deleted.count !== 1) {
    throw new MemoryCoordinatorError("memory_account_deletion_finalize_conflict", true);
  }
  return { admitted: false, deletionPending: false, readyForUserDeletion: true };
}

export function createAccountMemoryDeletionHook(input: Readonly<{
  admissionEnabled?: () => boolean;
  kick: () => void;
}>): AccountMemoryDeletionHook {
  return Object.freeze({
    advance: (tx, request) => advanceAccountDeletion(
      tx,
      request,
      input.admissionEnabled?.() ?? true
    ),
    kick: input.kick
  });
}
