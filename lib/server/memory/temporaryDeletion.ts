import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { decodeMemoryPreparingBaseSnapshot } from "../runs/preparingRun";
import type { StorageAdapter } from "../uploads/storage";
import type { WorkspaceRuntime } from "../workspace/runtime";
import { MemoryCoordinatorError } from "./coordinator/errors";
import type {
  MemoryDeletionClaim,
  MemoryDeletionHandler
} from "./coordinator/types";
import {
  MEMORY_TEMPORARY_DELETION_GENERATION,
  MEMORY_TEMPORARY_DELETION_TARGET_TYPE
} from "./temporaryRetention";

const activeRunStatuses = ["preparing", "queued", "streaming", "in_progress"] as const;
const activeMessageStatuses = ["queued", "streaming"] as const;

type TemporaryAttachment = Readonly<{
  id: string;
  storageKey: string;
}>;

type TemporaryObjectDisposition = Readonly<{
  deleted: boolean;
  storageKey: string;
}>;

type TemporaryDeletionSnapshot = Readonly<{
  attachments: readonly TemporaryAttachment[];
  chatExists: boolean;
  workspaceSession: Readonly<{
    cleanupClaimToken: string | null;
    id: string;
    runtimeSandboxId: string | null;
    sandboxName: string;
  }> | null;
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function assertClaimShape(claim: MemoryDeletionClaim): void {
  if (
    claim.operation !== "TEMPORARY_DELETE" ||
    claim.targetType !== MEMORY_TEMPORARY_DELETION_TARGET_TYPE ||
    claim.memoryGeneration !== MEMORY_TEMPORARY_DELETION_GENERATION
  ) {
    throw new MemoryCoordinatorError("memory_temporary_target_invalid", false);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("memory_temporary_deletion_aborted");
  }
}

async function assertNoReusableMemorySource(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim
): Promise<void> {
  const evidence = await tx.memoryEvidence.count({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  const scopes = await tx.memoryScope.count({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  const events = await tx.memoryEvent.count({
    where: { sourceChatId: claim.targetId, userId: claim.userId }
  });
  const suppressions = await tx.memorySuppression.count({
    where: { sourceChatId: claim.targetId, userId: claim.userId }
  });
  const acceptedItems = await tx.modelRunMemoryItem.count({
    where: { sourceChatIdSnapshot: claim.targetId, userId: claim.userId }
  });
  if (evidence + scopes + events + suppressions + acceptedItems > 0) {
    throw new MemoryCoordinatorError(
      "memory_temporary_reusable_source_detected",
      true
    );
  }
}

async function settleOverdueRuns(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim,
  now: Date
): Promise<void> {
  const runs = await tx.modelRun.findMany({
    select: { assistantMessageId: true, id: true, status: true },
    where: {
      chatId: claim.targetId,
      status: { in: [...activeRunStatuses] },
      userId: claim.userId
    }
  });
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  const attempts = await tx.memoryRetrievalAttempt.findMany({
    select: {
      boundedPrivateBaseRequestSnapshot: true,
      id: true,
      modelRunId: true
    },
    where: { modelRunId: { in: runIds }, userId: claim.userId }
  });
  const jobs = await tx.memoryJob.findMany({
    select: { id: true },
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  const executionOwners = [
    { modelRunId: { in: runIds } },
    ...(attempts.length > 0
      ? [{ retrievalAttemptId: { in: attempts.map((attempt) => attempt.id) } }]
      : []),
    ...(jobs.length > 0
      ? [{ memoryJobId: { in: jobs.map((job) => job.id) } }]
      : [])
  ];

  await tx.memoryExecutionBinding.updateMany({
    data: {
      completedAt: now,
      errorCode: "memory_temporary_retention_expired",
      state: "CANCELLED"
    },
    where: {
      OR: executionOwners,
      state: "PENDING",
      userId: claim.userId
    }
  });
  await tx.memoryExecutionBinding.updateMany({
    data: {
      completedAt: now,
      errorCode: "memory_temporary_retention_expired",
      state: "OUTCOME_UNKNOWN"
    },
    where: {
      OR: executionOwners,
      state: "RUNNING",
      userId: claim.userId
    }
  });
  await tx.memoryRetrievalAttempt.updateMany({
    data: {
      errorCode: "memory_temporary_retention_expired",
      state: "CANCELLED",
      updatedAt: now
    },
    where: {
      modelRunId: { in: runIds },
      state: { in: ["PENDING", "EXECUTING", "READY"] },
      userId: claim.userId
    }
  });
  await tx.modelRunToolCall.updateMany({
    data: {
      completedAt: now,
      result: json({ error: "temporary_retention_expired" }),
      state: "cancelled"
    },
    where: { modelRunId: { in: runIds }, state: "pending" }
  });
  await tx.modelRunToolCall.updateMany({
    data: {
      completedAt: now,
      result: json({ error: "temporary_retention_expired" }),
      state: "error"
    },
    where: { modelRunId: { in: runIds }, state: "running" }
  });
  const assistantMessageIds = runs.flatMap((run) =>
    run.assistantMessageId ? [run.assistantMessageId] : []);
  if (assistantMessageIds.length > 0) {
    await tx.message.updateMany({
      data: {
        errorMessage: "Temporary retention expired before this run settled.",
        status: "error"
      },
      where: {
        id: { in: assistantMessageIds },
        status: { in: [...activeMessageStatuses] }
      }
    });
  }
  for (const run of runs) {
    if (run.status !== "preparing") continue;
    const attempt = attempts.find((candidate) => candidate.modelRunId === run.id);
    const baseSnapshot = decodeMemoryPreparingBaseSnapshot(
      attempt?.boundedPrivateBaseRequestSnapshot
    );
    await tx.modelRun.update({
      data: {
        errorPayload: json({
          code: "temporary_retention_expired",
          message: "Temporary retention expired before this run settled."
        }),
        normalizedRequest: json(baseSnapshot?.normalizedRequest ?? {}),
        status: "error"
      },
      where: { id: run.id }
    });
  }
  await tx.modelRun.updateMany({
    data: {
      errorPayload: json({
        code: "temporary_retention_expired",
        message: "Temporary retention expired before this run settled."
      }),
      status: "error"
    },
    where: { id: { in: runIds }, status: { in: [...activeRunStatuses] } }
  });
}

async function prepareDeletionSnapshot(
  client: PrismaClient,
  claim: MemoryDeletionClaim,
  now: Date
): Promise<TemporaryDeletionSnapshot> {
  return client.$transaction(async (tx) => {
    const [chat] = await tx.$queryRaw<Array<{
      memoryMode: string;
      temporaryRetentionDeadline: Date | null;
      temporaryRetentionPolicyVersion: string | null;
    }>>(Prisma.sql`
      SELECT
        "memoryMode"::text AS "memoryMode",
        "temporaryRetentionDeadline",
        "temporaryRetentionPolicyVersion"
      FROM "Chat"
      WHERE "id" = ${claim.targetId} AND "userId" = ${claim.userId}
      FOR UPDATE
    `);
    if (!chat) {
      return { attachments: [], chatExists: false, workspaceSession: null };
    }
    if (
      chat.memoryMode !== "TEMPORARY" ||
      chat.temporaryRetentionPolicyVersion !==
        MEMORY_TEMPORARY_RETENTION_POLICY_VERSION ||
      !chat.temporaryRetentionDeadline ||
      chat.temporaryRetentionDeadline > now
    ) {
      throw new MemoryCoordinatorError("memory_temporary_not_due", true);
    }

    await assertNoReusableMemorySource(tx, claim);
    await settleOverdueRuns(tx, claim, now);
    const workspaceSession = await tx.workspaceSession.findUnique({
      select: { id: true, runtimeSandboxId: true, sandboxName: true },
      where: { chatId: claim.targetId }
    });
    const cleanupClaimToken = workspaceSession?.runtimeSandboxId
      ? randomUUID()
      : null;
    if (workspaceSession) {
      await tx.workspaceSession.update({
        data: { lastErrorCode: null, state: "DELETING" },
        where: { id: workspaceSession.id }
      });
      await tx.workspaceCleanupJob.upsert({
        create: {
          attemptCount: cleanupClaimToken ? 1 : 0,
          claimedAt: cleanupClaimToken ? now : null,
          claimToken: cleanupClaimToken,
          lastAttemptAt: cleanupClaimToken ? now : null,
          nextAttemptAt: now,
          runtimeSandboxId: workspaceSession.runtimeSandboxId,
          sandboxName: workspaceSession.sandboxName,
          state: cleanupClaimToken ? "RUNNING" : "PENDING",
          workspaceSessionId: workspaceSession.id
        },
        update: {
          ...(cleanupClaimToken ? { attemptCount: { increment: 1 } } : {}),
          claimedAt: cleanupClaimToken ? now : null,
          claimToken: cleanupClaimToken,
          lastAttemptAt: cleanupClaimToken ? now : null,
          lastErrorCode: null,
          nextAttemptAt: now,
          runtimeSandboxId: workspaceSession.runtimeSandboxId,
          sandboxName: workspaceSession.sandboxName,
          state: cleanupClaimToken ? "RUNNING" : "PENDING"
        },
        where: { workspaceSessionId: workspaceSession.id }
      });
    }
    const attachments = await tx.attachment.findMany({
      orderBy: { id: "asc" },
      select: { id: true, storageKey: true, userId: true },
      where: { chatId: claim.targetId }
    });
    if (attachments.some((attachment) => attachment.userId !== claim.userId)) {
      throw new MemoryCoordinatorError(
        "memory_temporary_attachment_owner_mismatch",
        true
      );
    }
    return {
      attachments: attachments.map(({ id, storageKey }) => ({ id, storageKey })),
      chatExists: true,
      workspaceSession: workspaceSession
        ? { ...workspaceSession, cleanupClaimToken }
        : null
    };
  });
}

async function removeTemporaryWorkspace(
  client: PrismaClient,
  runtime: WorkspaceRuntime | undefined,
  snapshot: TemporaryDeletionSnapshot,
  signal: AbortSignal,
  now: Date
): Promise<void> {
  const session = snapshot.workspaceSession;
  if (!session?.runtimeSandboxId) return;
  if (!runtime || !session.cleanupClaimToken) {
    throw new MemoryCoordinatorError(
      "memory_temporary_workspace_runtime_unavailable",
      true
    );
  }
  try {
    throwIfAborted(signal);
    await runtime.removeSession({
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId: session.id,
      signal
    });
    const settled = await client.workspaceSession.updateMany({
      data: {
        lastErrorCode: null,
        runtimeSandboxId: null,
        state: "DELETING",
        stoppedAt: now
      },
      where: {
        id: session.id,
        runtimeSandboxId: session.runtimeSandboxId,
        state: "DELETING"
      }
    });
    if (settled.count !== 1) {
      throw new Error("workspace_cleanup_fence_changed");
    }
  } catch {
    await client.workspaceCleanupJob.updateMany({
      data: {
        claimedAt: null,
        claimToken: null,
        lastErrorCode: "workspace_remove_failed",
        nextAttemptAt: new Date(now.getTime() + 30_000),
        state: "FAILED"
      },
      where: {
        claimToken: session.cleanupClaimToken,
        workspaceSessionId: session.id
      }
    }).catch(() => undefined);
    throw new MemoryCoordinatorError(
      "memory_temporary_workspace_cleanup_failed",
      true
    );
  }
}

async function deleteExclusiveObjects(
  client: PrismaClient,
  storage: Pick<StorageAdapter, "deleteObject">,
  attachments: readonly TemporaryAttachment[],
  signal: AbortSignal
): Promise<readonly TemporaryObjectDisposition[]> {
  const attachmentIds = attachments.map((attachment) => attachment.id);
  const keys = [...new Set(attachments.map((attachment) => attachment.storageKey))].sort();
  const dispositions: TemporaryObjectDisposition[] = [];
  for (const storageKey of keys) {
    throwIfAborted(signal);
    const otherAttachments = await client.attachment.count({
      where: {
        id: { notIn: attachmentIds },
        storageKey
      }
    });
    const knowledgeReferences = await client.knowledgeDocumentVersion.count({
      where: {
        OR: [
          { normalizedTextStorageKey: storageKey },
          { originalStorageKey: storageKey }
        ]
      }
    });
    const shared = otherAttachments + knowledgeReferences > 0;
    if (!shared) {
      try {
        await storage.deleteObject(storageKey);
      } catch {
        throw new MemoryCoordinatorError(
          "memory_temporary_object_delete_failed",
          true
        );
      }
    }
    dispositions.push({ deleted: !shared, storageKey });
  }
  throwIfAborted(signal);
  return dispositions;
}

function sameAttachments(
  left: readonly TemporaryAttachment[],
  right: readonly TemporaryAttachment[]
): boolean {
  return left.length === right.length && left.every((value, index) =>
    value.id === right[index]?.id && value.storageKey === right[index]?.storageKey);
}

async function applyAggregateDeletion(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim,
  snapshot: TemporaryDeletionSnapshot,
  dispositions: readonly TemporaryObjectDisposition[],
  now: Date
): Promise<void> {
  const [chat] = await tx.$queryRaw<Array<{
    id: string;
    temporaryRetentionDeadline: Date | null;
    temporaryRetentionPolicyVersion: string | null;
  }>>(Prisma.sql`
    SELECT "id", "temporaryRetentionDeadline", "temporaryRetentionPolicyVersion"
    FROM "Chat"
    WHERE "id" = ${claim.targetId}
      AND "userId" = ${claim.userId}
      AND "memoryMode" = 'TEMPORARY'::"MemoryChatMode"
    FOR UPDATE
  `);
  if (!chat) return;
  if (!snapshot.chatExists) {
    throw new MemoryCoordinatorError("memory_temporary_aggregate_changed", true);
  }
  if (
    chat.temporaryRetentionPolicyVersion !==
      MEMORY_TEMPORARY_RETENTION_POLICY_VERSION ||
    !chat.temporaryRetentionDeadline ||
    chat.temporaryRetentionDeadline > now
  ) {
    throw new MemoryCoordinatorError("memory_temporary_not_due", true);
  }
  await assertNoReusableMemorySource(tx, claim);
  const activeRuns = await tx.modelRun.count({
    where: {
      chatId: claim.targetId,
      status: { in: [...activeRunStatuses] },
      userId: claim.userId
    }
  });
  if (activeRuns > 0) {
    throw new MemoryCoordinatorError("memory_temporary_run_still_active", true);
  }

  const currentAttachments = await tx.attachment.findMany({
    orderBy: { id: "asc" },
    select: { id: true, storageKey: true },
    where: { chatId: claim.targetId }
  });
  if (!sameAttachments(snapshot.attachments, currentAttachments)) {
    throw new MemoryCoordinatorError("memory_temporary_aggregate_changed", true);
  }
  const attachmentIds = currentAttachments.map((attachment) => attachment.id);
  for (const disposition of dispositions) {
    if (disposition.deleted) continue;
    const otherAttachments = await tx.attachment.count({
      where: {
        id: { notIn: attachmentIds },
        storageKey: disposition.storageKey
      }
    });
    const knowledgeReferences = await tx.knowledgeDocumentVersion.count({
      where: {
        OR: [
          { normalizedTextStorageKey: disposition.storageKey },
          { originalStorageKey: disposition.storageKey }
        ]
      }
    });
    if (otherAttachments + knowledgeReferences === 0) {
      throw new MemoryCoordinatorError(
        "memory_temporary_object_reference_changed",
        true
      );
    }
  }

  const runs = await tx.modelRun.findMany({
    select: { id: true },
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  const runIds = runs.map((run) => run.id);
  const attempts = runIds.length === 0
    ? []
    : await tx.memoryRetrievalAttempt.findMany({
        select: { id: true },
        where: { modelRunId: { in: runIds }, userId: claim.userId }
      });
  const jobs = await tx.memoryJob.findMany({
    select: { id: true },
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  const attemptIds = attempts.map((attempt) => attempt.id);
  const jobIds = jobs.map((job) => job.id);
  const executionBindings = runIds.length + attemptIds.length + jobIds.length === 0
    ? []
    : await tx.memoryExecutionBinding.findMany({
        select: { id: true },
        where: {
          OR: [
            ...(runIds.length > 0 ? [{ modelRunId: { in: runIds } }] : []),
            ...(attemptIds.length > 0
              ? [{ retrievalAttemptId: { in: attemptIds } }]
              : []),
            ...(jobIds.length > 0 ? [{ memoryJobId: { in: jobIds } }] : [])
          ],
          userId: claim.userId
        }
      });
  const executionBindingIds = executionBindings.map((binding) => binding.id);

  await tx.usageEvent.deleteMany({
    where: {
      OR: [
        { chatId: claim.targetId },
        ...(runIds.length > 0 ? [{ modelRunId: { in: runIds } }] : []),
        ...(executionBindingIds.length > 0
          ? [{ memoryExecutionBindingId: { in: executionBindingIds } }]
          : [])
      ],
      userId: claim.userId
    }
  });
  await tx.memoryMutationAuthorization.deleteMany({
    where: {
      OR: [
        { sourceChatId: claim.targetId },
        ...(runIds.length > 0 ? [{ modelRunId: { in: runIds } }] : [])
      ],
      userId: claim.userId
    }
  });
  if (runIds.length > 0) {
    await tx.memoryOperationReceipt.deleteMany({
      where: { modelRunId: { in: runIds }, userId: claim.userId }
    });
  }
  if (jobIds.length > 0) {
    await tx.memoryJob.deleteMany({
      where: { id: { in: jobIds }, userId: claim.userId }
    });
  }
  await tx.sharedChatSnapshot.deleteMany({
    where: { chatId: claim.targetId }
  });
  if (currentAttachments.length > 0) {
    await tx.attachment.deleteMany({
      where: { chatId: claim.targetId, userId: claim.userId }
    });
    const deletedObjectKeys = dispositions
      .filter((disposition) => disposition.deleted)
      .map((disposition) => disposition.storageKey);
    if (deletedObjectKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: deletedObjectKeys } }
      });
    }
  }
  if (runIds.length > 0) {
    await tx.modelRun.deleteMany({
      where: { id: { in: runIds }, userId: claim.userId }
    });
  }
  const currentWorkspaceSession = await tx.workspaceSession.findUnique({
    select: { id: true, runtimeSandboxId: true },
    where: { chatId: claim.targetId }
  });
  if (snapshot.workspaceSession) {
    if (
      currentWorkspaceSession?.id !== snapshot.workspaceSession.id ||
      currentWorkspaceSession.runtimeSandboxId !== null
    ) {
      throw new MemoryCoordinatorError(
        "memory_temporary_workspace_cleanup_pending",
        true
      );
    }
    await tx.workspaceCleanupJob.deleteMany({
      where: { workspaceSessionId: currentWorkspaceSession.id }
    });
    await tx.workspaceSession.delete({ where: { id: currentWorkspaceSession.id } });
  } else if (currentWorkspaceSession) {
    throw new MemoryCoordinatorError("memory_temporary_aggregate_changed", true);
  }
  const deleted = await tx.chat.deleteMany({
    where: {
      id: claim.targetId,
      memoryMode: "TEMPORARY",
      userId: claim.userId
    }
  });
  if (deleted.count !== 1) {
    throw new MemoryCoordinatorError("memory_temporary_aggregate_changed", true);
  }

  const remainingMessages = await tx.message.count({
    where: { chatId: claim.targetId }
  });
  const remainingRuns = await tx.modelRun.count({
    where: { chatId: claim.targetId }
  });
  const remainingAttachments = await tx.attachment.count({
    where: { chatId: claim.targetId }
  });
  const remainingShares = await tx.sharedChatSnapshot.count({
    where: { chatId: claim.targetId }
  });
  const remainingUsage = await tx.usageEvent.count({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  if (
    remainingMessages + remainingRuns + remainingAttachments +
      remainingShares + remainingUsage !== 0
  ) {
    throw new MemoryCoordinatorError("memory_temporary_purge_incomplete", true);
  }
}

export function createPrismaTemporaryChatDeletionHandler(
  storage: Pick<StorageAdapter, "deleteObject">,
  client: PrismaClient,
  workspaceRuntime?: WorkspaceRuntime
): MemoryDeletionHandler {
  return Object.freeze({
    async execute(claim, context) {
      assertClaimShape(claim);
      const now = context.now();
      const snapshot = await prepareDeletionSnapshot(client, claim, now);
      await removeTemporaryWorkspace(
        client,
        workspaceRuntime,
        snapshot,
        context.signal,
        now
      );
      const dispositions = snapshot.chatExists
        ? await deleteExclusiveObjects(
            client,
            storage,
            snapshot.attachments,
            context.signal
          )
        : [];
      return {
        apply: (tx, committedClaim) =>
          applyAggregateDeletion(tx, committedClaim, snapshot, dispositions, now)
      };
    },
    operation: "TEMPORARY_DELETE"
  });
}
