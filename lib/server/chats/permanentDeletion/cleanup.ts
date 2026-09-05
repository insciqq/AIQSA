import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../../uploads/storage";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import { MemoryCoordinatorError } from "../../memory/coordinator/errors";
import type {
  MemoryDeletionClaim,
  MemoryDeletionHandler
} from "../../memory/coordinator/types";
import { forgetExplicitOriginFactsForPermanentChatDeletion } from
  "../../memory/lifecycle/repository";
import {
  inspectMemoryFeedbackPermanentChat,
  purgeMemoryFeedbackPermanentChat
} from "../../memory/review/purge";
import { detachFrozenMemoryRoundTargets } from "../../memory/history/purge";
import { loadMemorySuppressionKeyring } from "../../memory/suppressionKeyring";
import { PERMANENT_CHAT_DELETION_TARGET_TYPE } from "./contract";

const activeRunStatuses = [
  "in_progress",
  "preparing",
  "queued",
  "streaming"
] as const;

type AttachmentSnapshot = Readonly<{ id: string; storageKey: string;
  chatPdfArtifacts?: readonly Readonly<{ id: string; storageKey: string }>[];
}>;
type ObjectDisposition = Readonly<{ deleted: boolean; storageKey: string }>;
type CleanupSnapshot = Readonly<{
  attachments: readonly AttachmentSnapshot[];
  chatExists: boolean;
}>;

type AggregateIds = Readonly<{
  candidateIds: readonly string[];
  chunkIds: readonly string[];
  executionBindingIds: readonly string[];
  jobIds: readonly string[];
  originFactIds: readonly string[];
  retrievalAttemptIds: readonly string[];
  roundIds: readonly string[];
  runIds: readonly string[];
}>;

function validId(value: string | null): boolean {
  return value !== null && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function assertClaimShape(claim: MemoryDeletionClaim): void {
  if (
    claim.operation !== "SOURCE_PURGE" ||
    claim.targetType !== PERMANENT_CHAT_DELETION_TARGET_TYPE ||
    !validId(claim.targetId) ||
    !validId(claim.admissionAuthorizationId) ||
    !Number.isSafeInteger(claim.admittedChatSourceRevision) ||
    claim.admittedChatSourceRevision === null ||
    claim.admittedChatSourceRevision < 0 ||
    (claim.admittedActiveLeafMessageId !== null &&
      !validId(claim.admittedActiveLeafMessageId)) ||
    typeof claim.alsoForgetOriginMemories !== "boolean"
  ) {
    throw new MemoryCoordinatorError("memory_permanent_chat_target_invalid", false);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("memory_permanent_chat_deletion_aborted");
  }
}

async function prepareSnapshot(
  client: PrismaClient,
  claim: MemoryDeletionClaim
): Promise<CleanupSnapshot> {
  return client.$transaction(async (tx) => {
    const [chat] = await tx.$queryRaw<Array<{
      activeLeafMessageId: string | null;
      archived: boolean;
      memoryMode: string;
      memorySourceRevision: number;
      permanentDeletionAt: Date | null;
      permanentDeletionOperationId: string | null;
    }>>(Prisma.sql`
      SELECT
        "activeLeafMessageId", "archived", "memoryMode"::text AS "memoryMode",
        "memorySourceRevision", "permanentDeletionAt", "permanentDeletionOperationId"
      FROM "Chat"
      WHERE "id" = ${claim.targetId} AND "userId" = ${claim.userId}
      FOR SHARE
    `);
    if (chat) {
      if (
        !chat.archived ||
        chat.memoryMode !== "EXCLUDED" ||
        chat.permanentDeletionAt === null ||
        chat.permanentDeletionOperationId !== claim.id ||
        chat.activeLeafMessageId !== claim.admittedActiveLeafMessageId ||
        chat.memorySourceRevision !== claim.admittedChatSourceRevision! + 1
      ) {
        throw new MemoryCoordinatorError("memory_permanent_chat_fence_invalid", true);
      }
      const activeRuns = await tx.modelRun.count({
        where: {
          chatId: claim.targetId,
          status: { in: [...activeRunStatuses] },
          userId: claim.userId
        }
      });
      if (activeRuns > 0) {
        throw new MemoryCoordinatorError("memory_permanent_chat_run_still_active", true);
      }
    }
    const attachments = await tx.attachment.findMany({
      orderBy: { id: "asc" },
      select: { id: true, storageKey: true, userId: true,
        chatPdfArtifacts: { select: { id: true, storageKey: true }, orderBy: { id: "asc" } } },
      where: { chatId: claim.targetId }
    });
    if (attachments.some(({ userId }) => userId !== claim.userId)) {
      throw new MemoryCoordinatorError(
        "memory_permanent_chat_attachment_owner_mismatch",
        true
      );
    }
    return {
      attachments: attachments.map(({ id, storageKey, chatPdfArtifacts }) => ({ id, storageKey,
        ...(chatPdfArtifacts?.length ? { chatPdfArtifacts } : {}) })),
      chatExists: Boolean(chat)
    };
  });
}

async function deleteExclusiveObjects(
  client: PrismaClient,
  storage: Pick<StorageAdapter, "deleteObject">,
  attachments: readonly AttachmentSnapshot[],
  signal: AbortSignal
): Promise<readonly ObjectDisposition[]> {
  const attachmentIds = attachments.map(({ id }) => id);
  const keys = [...new Set(attachments.flatMap(({ storageKey, chatPdfArtifacts }) => [storageKey, ...(chatPdfArtifacts ?? []).map((artifact) => artifact.storageKey)]))].sort();
  const dispositions: ObjectDisposition[] = [];
  for (const storageKey of keys) {
    throwIfAborted(signal);
    const [otherAttachments, knowledgeReferences, pdfReferences] = await Promise.all([
      client.attachment.count({
        where: { id: { notIn: attachmentIds }, storageKey }
      }),
      client.knowledgeDocumentVersion.count({
        where: {
          OR: [
            { normalizedTextStorageKey: storageKey },
            { originalStorageKey: storageKey }
          ]
        }
      }),
      client.chatPdfArtifact.count({ where: { attachmentId: { notIn: attachmentIds }, storageKey } })
    ]);
    const shared = otherAttachments + knowledgeReferences + pdfReferences > 0;
    if (!shared) {
      try {
        await storage.deleteObject(storageKey);
      } catch {
        throw new MemoryCoordinatorError(
          "memory_permanent_chat_object_delete_failed",
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
  left: readonly AttachmentSnapshot[],
  right: readonly AttachmentSnapshot[]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.id === right[index]?.id && entry.storageKey === right[index]?.storageKey &&
    JSON.stringify(entry.chatPdfArtifacts ?? []) === JSON.stringify(right[index]?.chatPdfArtifacts ?? []));
}

async function aggregateIds(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim
): Promise<AggregateIds> {
  const [runs, jobs, chunks, rounds, candidates, originFacts] = await Promise.all([
    tx.modelRun.findMany({
      select: { id: true },
      where: { chatId: claim.targetId, userId: claim.userId }
    }),
    tx.memoryJob.findMany({
      select: { id: true },
      where: { chatId: claim.targetId, userId: claim.userId }
    }),
    tx.memoryRecallChunk.findMany({
      select: { id: true },
      where: { chatId: claim.targetId, userId: claim.userId }
    }),
    tx.memoryRecallRound.findMany({
      select: { id: true },
      where: { chatId: claim.targetId, userId: claim.userId }
    }),
    tx.memoryCandidate.findMany({
      select: { id: true },
      where: { chatId: claim.targetId, userId: claim.userId }
    }),
    tx.$queryRaw<Array<{ factId: string }>>(Prisma.sql`
      SELECT DISTINCT origin."factId"
      FROM (
        SELECT event."factId"
        FROM "MemoryEvent" AS event
        WHERE event."userId" = ${claim.userId}
          AND event."sourceChatId" = ${claim.targetId}
          AND event."factId" IS NOT NULL
        UNION
        SELECT receipt."targetFactId"
        FROM "MemoryOperationReceipt" AS receipt
        INNER JOIN "ModelRun" AS run
          ON run."userId" = receipt."userId" AND run."id" = receipt."modelRunId"
        WHERE receipt."userId" = ${claim.userId}
          AND run."chatId" = ${claim.targetId}
          AND receipt."operation" IN (
            'SAVE'::"MemoryMutationAction",
            'EDIT'::"MemoryMutationAction"
          )
          AND receipt."targetFactId" IS NOT NULL
      ) AS origin
      ORDER BY origin."factId"
    `)
  ]);
  const runIds = runs.map(({ id }) => id);
  const jobIds = jobs.map(({ id }) => id);
  const retrievalAttempts = runIds.length > 0
    ? await tx.memoryRetrievalAttempt.findMany({
        select: { id: true },
        where: { modelRunId: { in: runIds }, userId: claim.userId }
      })
    : [];
  const retrievalAttemptIds = retrievalAttempts.map(({ id }) => id);
  const ownerPredicates = [
    ...(runIds.length > 0 ? [{ modelRunId: { in: runIds } }] : []),
    ...(jobIds.length > 0 ? [{ memoryJobId: { in: jobIds } }] : []),
    ...(retrievalAttemptIds.length > 0
      ? [{ retrievalAttemptId: { in: retrievalAttemptIds } }]
      : [])
  ];
  const executionBindings = ownerPredicates.length > 0
    ? await tx.memoryExecutionBinding.findMany({
        select: { id: true },
        where: { OR: ownerPredicates, userId: claim.userId }
      })
    : [];
  return {
    candidateIds: candidates.map(({ id }) => id),
    chunkIds: chunks.map(({ id }) => id),
    executionBindingIds: executionBindings.map(({ id }) => id),
    jobIds,
    originFactIds: originFacts.map(({ factId }) => factId),
    retrievalAttemptIds,
    roundIds: rounds.map(({ id }) => id),
    runIds
  };
}

async function settleDestinationAttemptItems(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim,
  ids: Pick<AggregateIds, "chunkIds" | "roundIds">
): Promise<void> {
  const predicates: Prisma.Sql[] = [
    Prisma.sql`item."sourceChatIdSnapshot" = ${claim.targetId}`
  ];
  if (ids.chunkIds.length > 0) {
    predicates.push(Prisma.sql`item."recallChunkId" IN (${Prisma.join(ids.chunkIds)})`);
  }
  if (ids.roundIds.length > 0) {
    predicates.push(Prisma.sql`item."recallRoundId" IN (${Prisma.join(ids.roundIds)})`);
  }
  await tx.$executeRaw(Prisma.sql`
    WITH deleted AS (
      DELETE FROM "MemoryRetrievalAttemptItem" AS item
      WHERE item."userId" = ${claim.userId}
        AND (${Prisma.join(predicates, " OR ")})
      RETURNING item."userId", item."attemptId"
    ), affected AS (
      SELECT DISTINCT deleted."userId", deleted."attemptId" FROM deleted
    ), settled_attempts AS (
      UPDATE "MemoryRetrievalAttempt" AS attempt
      SET
        "state" = CASE
          WHEN attempt."state" IN ('PENDING', 'EXECUTING', 'READY')
            THEN 'STALE'::"MemoryRetrievalAttemptState"
          ELSE attempt."state"
        END,
        "preparedContextText" = NULL,
        "preparedContextHash" = NULL,
        "preparedContextTokenCount" = NULL,
        "errorCode" = CASE
          WHEN attempt."state" IN ('PENDING', 'EXECUTING', 'READY')
            THEN 'memory_source_deleted'
          ELSE attempt."errorCode"
        END,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM affected
      WHERE attempt."userId" = affected."userId"
        AND attempt."id" = affected."attemptId"
        AND attempt."state" IN (
          'PENDING'::"MemoryRetrievalAttemptState",
          'EXECUTING'::"MemoryRetrievalAttemptState",
          'READY'::"MemoryRetrievalAttemptState"
        )
      RETURNING
        attempt."admittedAssistantLeafMessageId", attempt."chatId",
        attempt."modelRunId", attempt."state", attempt."userId"
    ), settled_runs AS (
      UPDATE "ModelRun" AS run
      SET
        "errorPayload" = jsonb_build_object(
          'code', 'memory_source_deleted',
          'message', 'Memory preparation stopped because a selected source was deleted.'
        ),
        "status" = 'error'::"ModelRunStatus",
        "updatedAt" = CURRENT_TIMESTAMP
      FROM settled_attempts AS attempt
      WHERE run."id" = attempt."modelRunId"
        AND run."userId" = attempt."userId"
        AND run."status" = 'preparing'::"ModelRunStatus"
        AND attempt."state" = 'STALE'::"MemoryRetrievalAttemptState"
      RETURNING run."id", run."userId"
    )
    UPDATE "Message" AS message
    SET
      "errorMessage" = 'Memory preparation stopped because a selected source was deleted.',
      "status" = 'error'::"MessageStatus",
      "updatedAt" = CURRENT_TIMESTAMP
    FROM settled_attempts AS attempt
    INNER JOIN settled_runs AS run
      ON run."id" = attempt."modelRunId" AND run."userId" = attempt."userId"
    WHERE message."id" = attempt."admittedAssistantLeafMessageId"
      AND message."chatId" = attempt."chatId"
      AND message."status" IN ('queued', 'streaming')
  `);
}

async function releaseAggregateExecutionReferences(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim,
  ids: Pick<AggregateIds, "executionBindingIds" | "jobIds">
): Promise<void> {
  if (ids.executionBindingIds.length === 0 && ids.jobIds.length === 0) return;
  const executionBindingIds = [...ids.executionBindingIds];

  if (executionBindingIds.length > 0) {
    const classifiedVersions = await tx.memoryFactVersion.findMany({
      select: { id: true },
      where: {
        safetyClassifierExecutionId: { in: executionBindingIds },
        userId: claim.userId
      }
    });
    if (classifiedVersions.length > 0) {
      const versionIds = classifiedVersions.map(({ id }) => id);
      // A retained fact must never keep apparently-valid classification
      // provenance whose execution owner is about to disappear with the chat.
      // Fence it until the ordinary global reclassification reconciler records
      // fresh, owner-independent evidence. Forgotten/retracted rows remain
      // fenced and are not rediscovered by that reconciler.
      await tx.memorySearchEntry.deleteMany({
        where: { factVersionId: { in: versionIds }, userId: claim.userId }
      });
      await tx.memoryFactVersion.updateMany({
        data: {
          coreEligible: false,
          coreSalience: "NONE",
          safetyClassificationReasonCode: null,
          safetyClassificationState: "PENDING",
          safetyClassifiedAt: null,
          safetyClassifierExecutionId: null,
          safetyClassifierModelId: null,
          safetyClassifierPolicyVersion: null,
          safetyClassifierProviderId: null
        },
        where: {
          id: { in: versionIds },
          safetyClassifierExecutionId: { in: executionBindingIds },
          userId: claim.userId
        }
      });
    }
    await tx.memoryFactVersionRelation.updateMany({
      data: { executionId: null },
      where: { executionId: { in: executionBindingIds }, userId: claim.userId }
    });
    await tx.memoryFactExtractionExecution.deleteMany({
      where: {
        executionBindingId: { in: executionBindingIds },
        userId: claim.userId
      }
    });
    await tx.memorySynthesisExecution.deleteMany({
      where: {
        executionBindingId: { in: executionBindingIds },
        userId: claim.userId
      }
    });
  }

  await tx.memoryAuxiliarySemanticCall.deleteMany({
    where: {
      OR: [
        ...(executionBindingIds.length > 0
          ? [{ executionId: { in: executionBindingIds } }]
          : []),
        ...(ids.jobIds.length > 0
          ? [{ ownerJobId: { in: [...ids.jobIds] } }]
          : [])
      ],
      userId: claim.userId
    }
  });
}

async function auditCleanup(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim,
  originFactIds: readonly string[]
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ owner: string; residual: number }>>(Prisma.sql`
    SELECT owner, residual FROM (
      SELECT 'chat' AS owner, COUNT(*)::integer AS residual
        FROM "Chat" WHERE "userId" = ${claim.userId} AND "id" = ${claim.targetId}
      UNION ALL SELECT 'messages', COUNT(*)::integer
        FROM "Message" WHERE "chatId" = ${claim.targetId}
      UNION ALL SELECT 'runs', COUNT(*)::integer
        FROM "ModelRun" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'attachments', COUNT(*)::integer
        FROM "Attachment" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'shares', COUNT(*)::integer
        FROM "SharedChatSnapshot" WHERE "ownerUserId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'usage', COUNT(*)::integer
        FROM "UsageEvent" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'active-scopes', COUNT(*)::integer
        FROM "MemoryScope" WHERE "userId" = ${claim.userId}
          AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'checkpoints', COUNT(*)::integer
        FROM "ChatMemoryCheckpoint" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'checkpoint-messages', COUNT(*)::integer
        FROM "ChatMemoryCheckpointMessage" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'chunks', COUNT(*)::integer
        FROM "MemoryRecallChunk" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'rounds', COUNT(*)::integer
        FROM "MemoryRecallRound" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'digests', COUNT(*)::integer
        FROM "ChatMemoryDigest" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'digest-chunks', COUNT(*)::integer
        FROM "ChatMemoryDigestChunk" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'digest-messages', COUNT(*)::integer
        FROM "ChatMemoryDigestMessage" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'candidates', COUNT(*)::integer
        FROM "MemoryCandidate" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'evidence', COUNT(*)::integer
        FROM "MemoryEvidence" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'events', COUNT(*)::integer
        FROM "MemoryEvent" WHERE "userId" = ${claim.userId} AND "sourceChatId" = ${claim.targetId}
      UNION ALL SELECT 'suppressions', COUNT(*)::integer
        FROM "MemorySuppression" WHERE "userId" = ${claim.userId} AND "sourceChatId" = ${claim.targetId}
      UNION ALL SELECT 'authorizations', COUNT(*)::integer
        FROM "MemoryMutationAuthorization"
        WHERE "userId" = ${claim.userId} AND "sourceChatId" = ${claim.targetId}
      UNION ALL SELECT 'jobs', COUNT(*)::integer
        FROM "MemoryJob" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'attempts', COUNT(*)::integer
        FROM "MemoryRetrievalAttempt" WHERE "userId" = ${claim.userId} AND "chatId" = ${claim.targetId}
      UNION ALL SELECT 'staging-items', COUNT(*)::integer
        FROM "MemoryRetrievalAttemptItem"
        WHERE "userId" = ${claim.userId} AND "sourceChatIdSnapshot" = ${claim.targetId}
      UNION ALL SELECT 'live-feedback', COUNT(*)::integer
        FROM "MemoryFeedback" WHERE "userId" = ${claim.userId}
          AND "contentPurgedAt" IS NULL
          AND "sourceChatIdSnapshot" = ${claim.targetId}
    ) AS inventory
  `);
  const feedbackResidual = await inspectMemoryFeedbackPermanentChat(
    tx,
    claim.userId,
    { chatId: claim.targetId, chunkIds: [], roundIds: [], runIds: [] }
  );
  const inventoryResidual = rows.reduce((sum, row) => sum + row.residual, 0);
  if (inventoryResidual + feedbackResidual > 0) {
    throw new MemoryCoordinatorError("memory_permanent_chat_purge_incomplete", true);
  }
  if (claim.alsoForgetOriginMemories && originFactIds.length > 0) {
    const [row] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT fact."id")::integer AS "count"
      FROM "MemoryFact" AS fact
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = fact."userId" AND version."factId" = fact."id"
      WHERE fact."userId" = ${claim.userId}
        AND fact."id" IN (${Prisma.join([...originFactIds])})
        AND fact."state" IN ('ACTIVE', 'CONFLICTED', 'ORPHANED')
        AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND version."contentPurgedAt" IS NULL
    `);
    const remaining = row?.count ?? -1;
    if (!Number.isSafeInteger(remaining) || remaining !== 0) {
      throw new MemoryCoordinatorError("memory_permanent_chat_origin_forget_incomplete", true);
    }
  }
}

async function applyAggregateDeletion(
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim,
  snapshot: CleanupSnapshot,
  dispositions: readonly ObjectDisposition[],
  now: Date
): Promise<void> {
  const [chat] = await tx.$queryRaw<Array<{
    id: string;
    permanentDeletionOperationId: string | null;
  }>>(Prisma.sql`
    SELECT "id", "permanentDeletionOperationId"
    FROM "Chat"
    WHERE "id" = ${claim.targetId} AND "userId" = ${claim.userId}
    FOR UPDATE
  `);
  if (chat && chat.permanentDeletionOperationId !== claim.id) {
    throw new MemoryCoordinatorError("memory_permanent_chat_fence_invalid", true);
  }
  if (Boolean(chat) !== snapshot.chatExists) {
    throw new MemoryCoordinatorError("memory_permanent_chat_aggregate_changed", true);
  }
  const currentAttachments = await tx.attachment.findMany({
    orderBy: { id: "asc" },
    select: { id: true, storageKey: true,
      chatPdfArtifacts: { select: { id: true, storageKey: true }, orderBy: { id: "asc" } } },
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  if (!sameAttachments(snapshot.attachments, currentAttachments)) {
    throw new MemoryCoordinatorError("memory_permanent_chat_aggregate_changed", true);
  }
  const attachmentIds = currentAttachments.map(({ id }) => id);
  for (const disposition of dispositions) {
    if (disposition.deleted) continue;
    const [otherAttachments, knowledgeReferences, pdfReferences] = await Promise.all([
      tx.attachment.count({
        where: { id: { notIn: attachmentIds }, storageKey: disposition.storageKey }
      }),
      tx.knowledgeDocumentVersion.count({
        where: {
          OR: [
            { normalizedTextStorageKey: disposition.storageKey },
            { originalStorageKey: disposition.storageKey }
          ]
        }
      }),
      tx.chatPdfArtifact.count({ where: { attachmentId: { notIn: attachmentIds }, storageKey: disposition.storageKey } })
    ]);
    if (otherAttachments + knowledgeReferences + pdfReferences === 0) {
      throw new MemoryCoordinatorError(
        "memory_permanent_chat_object_reference_changed",
        true
      );
    }
  }

  const ids = await aggregateIds(tx, claim);
  if (claim.alsoForgetOriginMemories) {
    const configured = loadMemorySuppressionKeyring();
    if (configured.status !== "ready") {
      throw new MemoryCoordinatorError(configured.code, true);
    }
    await forgetExplicitOriginFactsForPermanentChatDeletion(tx, configured.keyring, {
      factIds: ids.originFactIds,
      now,
      rootDeletionId: claim.id,
      userId: claim.userId
    });
  }

  await purgeMemoryFeedbackPermanentChat(tx, claim.userId, {
    chatId: claim.targetId,
    chunkIds: ids.chunkIds,
    roundIds: ids.roundIds,
    runIds: ids.runIds
  });
  await settleDestinationAttemptItems(tx, claim, ids);
  await detachFrozenMemoryRoundTargets(tx, claim.userId, ids.roundIds);

  if (ids.chunkIds.length > 0 || ids.roundIds.length > 0) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        OR: [
          { recallChunkId: { in: [...ids.chunkIds] } },
          { recallRoundId: { in: [...ids.roundIds] } }
        ],
        userId: claim.userId
      }
    });
  }
  await tx.memoryEvidence.deleteMany({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  await tx.memorySuppression.deleteMany({
    where: { sourceChatId: claim.targetId, userId: claim.userId }
  });
  if (ids.candidateIds.length > 0) {
    await tx.memoryCandidateMessage.deleteMany({
      where: { candidateId: { in: [...ids.candidateIds] }, userId: claim.userId }
    });
    await tx.memoryCandidate.deleteMany({
      where: { id: { in: [...ids.candidateIds] }, userId: claim.userId }
    });
  }
  await releaseAggregateExecutionReferences(tx, claim, ids);
  await tx.chatMemoryDigestChunk.deleteMany({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  await tx.chatMemoryDigestMessage.deleteMany({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  await tx.chatMemoryDigest.deleteMany({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  if (ids.roundIds.length > 0) {
    await tx.memoryRecallRoundMessage.deleteMany({
      where: { roundId: { in: [...ids.roundIds] }, userId: claim.userId }
    });
    await tx.memoryRecallRound.deleteMany({
      where: { id: { in: [...ids.roundIds] }, userId: claim.userId }
    });
  }
  if (ids.chunkIds.length > 0) {
    await tx.memoryRecallChunkMessage.deleteMany({
      where: { chunkId: { in: [...ids.chunkIds] }, userId: claim.userId }
    });
    await tx.memoryRecallChunk.deleteMany({
      where: { id: { in: [...ids.chunkIds] }, userId: claim.userId }
    });
  }
  await tx.chatMemoryCheckpointMessage.deleteMany({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  await tx.chatMemoryCheckpoint.deleteMany({
    where: { chatId: claim.targetId, userId: claim.userId }
  });
  await tx.memoryEvent.updateMany({
    data: { sourceChatId: null, sourceDeletedAt: now },
    where: { sourceChatId: claim.targetId, sourceDeletedAt: null, userId: claim.userId }
  });
  await tx.memoryMutationAuthorization.deleteMany({
    where: {
      OR: [
        { sourceChatId: claim.targetId },
        ...(ids.runIds.length > 0 ? [{ modelRunId: { in: [...ids.runIds] } }] : [])
      ],
      userId: claim.userId
    }
  });
  await tx.usageEvent.deleteMany({
    where: {
      OR: [
        { chatId: claim.targetId },
        ...(ids.runIds.length > 0 ? [{ modelRunId: { in: [...ids.runIds] } }] : []),
        ...(ids.executionBindingIds.length > 0
          ? [{ memoryExecutionBindingId: { in: [...ids.executionBindingIds] } }]
          : [])
      ],
      userId: claim.userId
    }
  });
  if (ids.runIds.length > 0) {
    await tx.memoryOperationReceipt.deleteMany({
      where: { modelRunId: { in: [...ids.runIds] }, userId: claim.userId }
    });
  }
  if (ids.jobIds.length > 0) {
    await tx.memoryJob.deleteMany({
      where: { id: { in: [...ids.jobIds] }, userId: claim.userId }
    });
  }
  await tx.sharedChatSnapshot.deleteMany({
    where: { chatId: claim.targetId, ownerUserId: claim.userId }
  });
  if (currentAttachments.length > 0) {
    await tx.attachment.deleteMany({
      where: { chatId: claim.targetId, userId: claim.userId }
    });
    const deletedKeys = dispositions
      .filter(({ deleted, storageKey }) => deleted && !storageKey.startsWith("chat-pdf/"))
      .map(({ storageKey }) => storageKey);
    if (deletedKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: deletedKeys } }
      });
    }
  }
  if (ids.runIds.length > 0) {
    await tx.modelRun.deleteMany({
      where: { id: { in: [...ids.runIds] }, userId: claim.userId }
    });
  }
  const workspaceSession = await tx.workspaceSession.findUnique({
    select: { id: true, runtimeSandboxId: true },
    where: { chatId: claim.targetId }
  });
  if (workspaceSession) {
    if (workspaceSession.runtimeSandboxId !== null) {
      throw new MemoryCoordinatorError("memory_permanent_chat_workspace_cleanup_pending", true);
    }
    await tx.workspaceCleanupJob.deleteMany({
      where: { workspaceSessionId: workspaceSession.id }
    });
    await tx.workspaceSession.delete({ where: { id: workspaceSession.id } });
  }
  if (chat) {
    const deleted = await tx.chat.deleteMany({
      where: {
        id: claim.targetId,
        permanentDeletionOperationId: claim.id,
        userId: claim.userId
      }
    });
    if (deleted.count !== 1) {
      throw new MemoryCoordinatorError("memory_permanent_chat_aggregate_changed", true);
    }
  }
  await auditCleanup(tx, claim, ids.originFactIds);
}

export function createPrismaPermanentChatDeletionHandler(
  storage: Pick<StorageAdapter, "deleteObject">,
  client: PrismaClient,
  workspaceRuntime?: WorkspaceRuntime
): MemoryDeletionHandler {
  return Object.freeze({
    async execute(claim, context) {
      assertClaimShape(claim);
      if (claim.alsoForgetOriginMemories) {
        const configured = loadMemorySuppressionKeyring();
        if (configured.status !== "ready") {
          throw new MemoryCoordinatorError(configured.code, true);
        }
      }
      const now = context.now();
      const workspaceSession = await client.workspaceSession.findUnique({
        select: {
          id: true,
          runtimeSandboxId: true,
          sandboxName: true
        },
        where: { chatId: claim.targetId }
      });
      if (workspaceSession?.runtimeSandboxId) {
        if (!workspaceRuntime) {
          throw new MemoryCoordinatorError(
            "memory_permanent_chat_workspace_runtime_unavailable",
            true
          );
        }
        const cleanupClaimToken = randomUUID();
        await client.$transaction(async (tx) => {
          await tx.workspaceCleanupJob.upsert({
            create: {
              attemptCount: 1,
              claimedAt: now,
              claimToken: cleanupClaimToken,
              lastAttemptAt: now,
              nextAttemptAt: now,
              runtimeSandboxId: workspaceSession.runtimeSandboxId,
              sandboxName: workspaceSession.sandboxName,
              state: "RUNNING",
              workspaceSessionId: workspaceSession.id
            },
            update: {
              attemptCount: { increment: 1 },
              claimedAt: now,
              claimToken: cleanupClaimToken,
              lastAttemptAt: now,
              lastErrorCode: null,
              nextAttemptAt: now,
              runtimeSandboxId: workspaceSession.runtimeSandboxId,
              sandboxName: workspaceSession.sandboxName,
              state: "RUNNING"
            },
            where: { workspaceSessionId: workspaceSession.id }
          });
          await tx.workspaceSession.update({
            data: { lastErrorCode: null, state: "DELETING" },
            where: { id: workspaceSession.id }
          });
        });
        try {
          throwIfAborted(context.signal);
          await workspaceRuntime.removeSession({
            runtimeSandboxId: workspaceSession.runtimeSandboxId,
            sessionId: workspaceSession.id,
            signal: context.signal
          });
          await client.workspaceSession.update({
            data: {
              lastErrorCode: null,
              runtimeSandboxId: null,
              state: "DELETING",
              stoppedAt: now
            },
            where: { id: workspaceSession.id }
          });
        } catch {
          await client.workspaceCleanupJob.updateMany({
            data: {
              claimedAt: null,
              claimToken: null,
              lastErrorCode: "workspace_remove_failed",
              nextAttemptAt: new Date(now.getTime() + 30_000),
              state: "FAILED"
            },
            where: { workspaceSessionId: workspaceSession.id }
          }).catch(() => undefined);
          throw new MemoryCoordinatorError(
            "memory_permanent_chat_workspace_cleanup_failed",
            true
          );
        }
      }
      const snapshot = await prepareSnapshot(client, claim);
      const dispositions = await deleteExclusiveObjects(
        client,
        storage,
        snapshot.attachments,
        context.signal
      );
      return {
        apply: (tx, committedClaim) => applyAggregateDeletion(
          tx,
          committedClaim,
          snapshot,
          dispositions,
          now
        )
      };
    },
    operation: "SOURCE_PURGE"
  });
}
