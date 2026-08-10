import type { MemoryDeletionState } from "@prisma/client";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import type { MemoryTransaction } from "./persistence/transaction";
import type { MemoryTemporaryFinalizationEvent } from "./sourceState";

export const MEMORY_TEMPORARY_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_TEMPORARY_DELETION_TARGET_TYPE =
  `TEMPORARY_CHAT@${MEMORY_TEMPORARY_RETENTION_POLICY_VERSION}`;
export const MEMORY_TEMPORARY_DELETION_GENERATION = 0;

export function temporaryRetentionDeadline(now: Date): Date {
  const deadline = new Date(now.getTime() + MEMORY_TEMPORARY_RETENTION_MS);
  if (!Number.isFinite(deadline.getTime())) {
    throw new Error("memory_temporary_retention_clock_invalid");
  }
  return deadline;
}

function reschedulableState(state: MemoryDeletionState): boolean {
  return state === "PENDING" || state === "RETRY_WAIT" ||
    state === "BLOCKED_REQUIRES_ADMIN";
}

export async function scheduleTemporaryChatDeletion(
  tx: MemoryTransaction,
  input: Readonly<{
    chatId: string;
    deadline: Date;
    now: Date;
    userId: string;
  }>
): Promise<void> {
  const existing = await tx.memoryDeletionOutbox.findUnique({
    select: { id: true, state: true },
    where: {
      userId_operation_targetType_targetId_memoryGeneration: {
        memoryGeneration: MEMORY_TEMPORARY_DELETION_GENERATION,
        operation: "TEMPORARY_DELETE",
        targetId: input.chatId,
        targetType: MEMORY_TEMPORARY_DELETION_TARGET_TYPE,
        userId: input.userId
      }
    }
  });
  if (!existing) {
    await tx.memoryDeletionOutbox.create({
      data: {
        memoryGeneration: MEMORY_TEMPORARY_DELETION_GENERATION,
        nextAttemptAt: input.deadline,
        operation: "TEMPORARY_DELETE",
        targetId: input.chatId,
        targetType: MEMORY_TEMPORARY_DELETION_TARGET_TYPE,
        userId: input.userId
      }
    });
    return;
  }
  if (!reschedulableState(existing.state)) {
    throw new Error("memory_temporary_deletion_already_claimed");
  }
  await tx.memoryDeletionOutbox.update({
    data: {
      completedAt: null,
      errorCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: input.deadline,
      state: "PENDING",
      updatedAt: input.now
    },
    where: { id: existing.id }
  });
}

export async function applyTemporaryRunFinalized(
  tx: MemoryTransaction,
  event: MemoryTemporaryFinalizationEvent
): Promise<void> {
  const now = new Date();
  const deadline = temporaryRetentionDeadline(now);
  const updated = await tx.chat.updateMany({
    data: { temporaryRetentionDeadline: deadline },
    where: {
      id: event.snapshot.id,
      memoryMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
      userId: event.snapshot.userId
    }
  });
  if (updated.count !== 1) {
    throw new Error("memory_temporary_chat_state_changed");
  }
  await scheduleTemporaryChatDeletion(tx, {
    chatId: event.snapshot.id,
    deadline,
    now,
    userId: event.snapshot.userId
  });
}
