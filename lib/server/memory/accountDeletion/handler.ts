import { Prisma, type PrismaClient } from "@prisma/client";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryDeletionClaim,
  MemoryDeletionHandler
} from "../coordinator/types";
import { detachExpiredMemoryExecutionBindings } from "../execution/lifecycle";
import { pruneUnreferencedMemoryEntities } from "../learning/entities/lifecycle";
import { purgeMemoryFeedbackAccount } from "../review/purge";
import {
  parseAccountMemoryDeletionClaim,
  type AccountMemoryDeletionClaim
} from "./contract";

type ResidualRow = Readonly<{ owner: string; residual: number }>;

const nonterminalJobStates = [
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
] as const;

function assertClaim(claim: MemoryDeletionClaim): AccountMemoryDeletionClaim {
  const parsed = parseAccountMemoryDeletionClaim(claim);
  if (!parsed) {
    throw new MemoryCoordinatorError("memory_account_deletion_target_invalid", false);
  }
  return parsed;
}

async function assertGlobalOwnersSettled(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  const [chats, runs, attachments, shares] = await Promise.all([
    tx.chat.count({ where: { userId } }),
    tx.modelRun.count({ where: { userId } }),
    tx.attachment.count({ where: { userId } }),
    tx.sharedChatSnapshot.count({ where: { ownerUserId: userId } })
  ]);
  if (chats + runs + attachments + shares > 0) {
    throw new MemoryCoordinatorError("memory_account_global_owner_pending", true);
  }
}

async function assertFence(
  tx: Prisma.TransactionClient,
  claim: AccountMemoryDeletionClaim
): Promise<void> {
  const [row] = await tx.$queryRaw<Array<{
    activeIndexGenerationId: string | null;
    decayEnabled: boolean;
    embeddingProviderModelId: string | null;
    learnAutomatically: boolean;
    ownerStatus: string;
    referenceChatHistory: boolean;
    synthesisEnabled: boolean;
    useMemoryFacts: boolean;
  }>>(Prisma.sql`
    SELECT
      settings."activeIndexGenerationId",
      settings."decayEnabled",
      settings."embeddingProviderModelId",
      settings."learnAutomatically",
      owner."status"::text AS "ownerStatus",
      settings."referenceChatHistory",
      settings."synthesisEnabled",
      settings."useMemoryFacts"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner ON owner."id" = settings."userId"
    WHERE settings."userId" = ${claim.userId}
    FOR UPDATE OF owner, settings
  `);
  if (
    !row ||
    row.ownerStatus === "active" ||
    row.decayEnabled ||
    row.useMemoryFacts ||
    row.referenceChatHistory ||
    row.learnAutomatically ||
    row.synthesisEnabled ||
    row.activeIndexGenerationId !== null ||
    row.embeddingProviderModelId !== null
  ) {
    throw new MemoryCoordinatorError("memory_account_deletion_fence_invalid", true);
  }
}

async function cancelUndispatchedWork(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date
): Promise<void> {
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
    where: { state: { in: [...nonterminalJobStates] }, userId }
  });
  await tx.memoryJob.updateMany({
    data: { errorMessage: null, updatedAt: now },
    where: { errorMessage: { not: null }, userId }
  });
  await tx.memoryExecutionBinding.updateMany({
    data: {
      completedAt: now,
      errorCode: "memory_account_deletion",
      state: "CANCELLED"
    },
    where: { state: "PENDING", userId }
  });
}

async function assertExecutionsSafeToPurge(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date
): Promise<void> {
  await detachExpiredMemoryExecutionBindings(tx, { userId }, now);
  const [row] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::integer AS "count"
    FROM "MemoryExecutionBinding" AS binding
    WHERE binding."userId" = ${userId}
      AND (
        binding."state" IN (
          'PENDING'::"MemoryExecutionState",
          'RUNNING'::"MemoryExecutionState",
          'OUTCOME_UNKNOWN'::"MemoryExecutionState"
        )
        OR (
          binding."relationsDetachedAt" IS NULL
          AND NOT (
            binding."state" = 'CANCELLED'::"MemoryExecutionState"
            AND binding."startedAt" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "UsageEvent" AS usage
              WHERE usage."userId" = binding."userId"
                AND usage."memoryExecutionBindingId" = binding."id"
            )
          )
        )
        OR (
          binding."relationsDetachedAt" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "UsageEvent" AS usage
            WHERE usage."userId" = binding."userId"
              AND usage."memoryExecutionBindingId" = binding."id"
          )
        )
      )
  `);
  if (!row || !Number.isSafeInteger(row.count) || row.count > 0) {
    throw new MemoryCoordinatorError("memory_account_execution_recovery_pending", true);
  }
}

async function purgeReusableAndPrivateMemory(
  tx: Prisma.TransactionClient,
  claim: AccountMemoryDeletionClaim,
  now: Date
): Promise<void> {
  const userId = claim.userId;

  await purgeMemoryFeedbackAccount(tx, userId);
  await tx.memoryFactExtractionCandidateReceipt.deleteMany({ where: { userId } });
  await tx.memoryFactExtractionExecution.deleteMany({ where: { userId } });
  await tx.memorySynthesisExecution.deleteMany({ where: { userId } });
  await tx.memoryCandidate.deleteMany({ where: { userId } });
  await tx.memoryMutationAuthorization.deleteMany({ where: { userId } });
  await tx.memoryOperationReceipt.deleteMany({ where: { userId } });
  await tx.memoryAuxiliarySemanticCall.deleteMany({ where: { userId } });
  await tx.memoryFactVersionRelation.deleteMany({ where: { userId } });
  await tx.memoryFactVersionSourceDependency.deleteMany({ where: { userId } });
  await tx.memoryEntityAliasSupport.deleteMany({ where: { userId } });
  await tx.memoryFactVersionEntity.deleteMany({ where: { userId } });
  await tx.memoryEntityAlias.deleteMany({ where: { userId } });
  await pruneUnreferencedMemoryEntities(tx, userId);
  await tx.memoryEvidence.deleteMany({ where: { userId } });
  await tx.memoryRetrievalAttemptItem.deleteMany({ where: { userId } });
  await tx.memoryEmbeddingBatchItem.deleteMany({ where: { userId } });
  await tx.memorySearchEntry.deleteMany({ where: { userId } });
  await tx.memoryToolEvent.deleteMany({ where: { userId } });
  await tx.memorySuppression.deleteMany({ where: { userId } });
  await tx.memoryPauseInterval.deleteMany({ where: { userId } });
  await tx.memorySourceBarrier.deleteMany({ where: { userId } });
  await tx.chatMemoryDigestChunk.deleteMany({ where: { userId } });
  await tx.chatMemoryDigestMessage.deleteMany({ where: { userId } });
  await tx.chatMemoryDigest.deleteMany({ where: { userId } });
  await tx.memoryRecallRoundSegmentMessage.deleteMany({ where: { userId } });
  await tx.memoryRecallRoundSegment.deleteMany({ where: { userId } });
  await tx.memoryRecallRoundMessage.deleteMany({ where: { userId } });
  await tx.memoryRecallRound.deleteMany({ where: { userId } });
  await tx.memoryRecallChunkMessage.deleteMany({ where: { userId } });
  await tx.memoryRecallChunk.deleteMany({ where: { userId } });
  await tx.chatMemoryCheckpointMessage.deleteMany({ where: { userId } });
  await tx.chatMemoryCheckpoint.deleteMany({ where: { userId } });

  // Prisma may validate a deferred event/version edge at a statement
  // boundary. Remove the complete bitemporal cycle in one database statement.
  await tx.$executeRaw(Prisma.sql`
    WITH deleted_events AS (
      DELETE FROM "MemoryEvent" WHERE "userId" = ${userId} RETURNING "id"
    ), deleted_versions AS (
      DELETE FROM "MemoryFactVersion" WHERE "userId" = ${userId} RETURNING "id"
    ), deleted_facts AS (
      DELETE FROM "MemoryFact" WHERE "userId" = ${userId} RETURNING "id"
    )
    DELETE FROM "MemoryScope" WHERE "userId" = ${userId}
  `);
  // subjectEntityId deliberately restricts entity deletion until every fact
  // container is gone; the second pass settles those now-unreferenced roots.
  await pruneUnreferencedMemoryEntities(tx, userId);

  while (true) {
    const leaves = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT generation."id"
      FROM "MemoryIndexGeneration" AS generation
      WHERE generation."userId" = ${userId}
        AND NOT EXISTS (
          SELECT 1
          FROM "MemoryIndexGeneration" AS child
          WHERE child."userId" = generation."userId"
            AND child."sourceIndexGenerationId" = generation."id"
        )
      ORDER BY generation."generation" DESC, generation."id" DESC
      LIMIT 100
    `);
    if (leaves.length === 0) break;
    await tx.memoryIndexGeneration.deleteMany({
      where: { id: { in: leaves.map(({ id }) => id) }, userId }
    });
  }

  // Never-dispatched cancellation evidence is disposable. Settled calls with
  // durable usage stay as detached, content-free evidence until the global
  // user/usage retention owner removes them.
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemoryExecutionBinding" AS binding
    WHERE binding."userId" = ${userId}
      AND binding."state" = 'CANCELLED'::"MemoryExecutionState"
      AND binding."startedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "UsageEvent" AS usage
        WHERE usage."userId" = binding."userId"
          AND usage."memoryExecutionBindingId" = binding."id"
      )
  `);
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemoryJob" AS job
    WHERE job."userId" = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryExecutionBinding" AS binding
        WHERE binding."userId" = job."userId"
          AND binding."memoryJobId" = job."id"
      )
  `);

  await tx.memoryDeletionOutbox.deleteMany({
    where: { id: { not: claim.id }, userId }
  });
  await tx.userMemorySettings.update({
    data: {
      acceptedUtilityEgressAt: null,
      acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null,
      activeIndexGenerationId: null,
      decayEnabled: false,
      decayPolicyVersion: null,
      embeddingProviderModelId: null,
      learnAutomatically: false,
      referenceChatHistory: false,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      synthesisEnabled: false,
      synthesisEnabledAt: null,
      synthesisPolicyVersion: null,
      lastSynthesisAt: null,
      useMemoryFacts: false,
      updatedAt: now
    },
    where: { userId }
  });
}

/**
 * Audits the pre-user-delete state. The one fenced settings row, the current
 * obligation, and usage-backed detached execution evidence are the only
 * permitted Memory residues.
 */
export async function inspectAccountMemoryDeletionResiduals(
  tx: Prisma.TransactionClient,
  input: Readonly<{ deletionId: string; userId: string }>
): Promise<readonly string[]> {
  const rows = await tx.$queryRaw<ResidualRow[]>(Prisma.sql`
    SELECT owner, residual FROM (
      SELECT 'settings-fence' AS owner, COUNT(*)::integer AS residual
      FROM "UserMemorySettings" AS settings
      WHERE settings."userId" = ${input.userId}
        AND NOT (
          settings."useMemoryFacts" = FALSE
          AND settings."decayEnabled" = FALSE
          AND settings."decayPolicyVersion" IS NULL
          AND settings."referenceChatHistory" = FALSE
          AND settings."learnAutomatically" = FALSE
          AND settings."synthesisEnabled" = FALSE
          AND settings."synthesisEnabledAt" IS NULL
          AND settings."synthesisPolicyVersion" IS NULL
          AND settings."lastSynthesisAt" IS NULL
          AND settings."activeIndexGenerationId" IS NULL
          AND settings."embeddingProviderModelId" IS NULL
          AND settings."acceptedUtilityEgressFingerprint" IS NULL
          AND settings."acceptedUtilityPolicyVersion" IS NULL
          AND settings."acceptedUtilityEgressAt" IS NULL
        )
      UNION ALL SELECT 'settings-count',
        CASE WHEN COUNT(*) = 1 THEN 0 ELSE 1 END::integer
        FROM "UserMemorySettings" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'scopes', COUNT(*)::integer FROM "MemoryScope" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'checkpoints', COUNT(*)::integer FROM "ChatMemoryCheckpoint" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'checkpoint-messages', COUNT(*)::integer FROM "ChatMemoryCheckpointMessage" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'chunks', COUNT(*)::integer FROM "MemoryRecallChunk" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'chunk-messages', COUNT(*)::integer FROM "MemoryRecallChunkMessage" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'rounds', COUNT(*)::integer FROM "MemoryRecallRound" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'round-messages', COUNT(*)::integer FROM "MemoryRecallRoundMessage" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'round-segments', COUNT(*)::integer FROM "MemoryRecallRoundSegment" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'round-segment-messages', COUNT(*)::integer FROM "MemoryRecallRoundSegmentMessage" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'tool-events', COUNT(*)::integer FROM "MemoryToolEvent" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'digests', COUNT(*)::integer FROM "ChatMemoryDigest" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'digest-chunks', COUNT(*)::integer FROM "ChatMemoryDigestChunk" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'digest-messages', COUNT(*)::integer FROM "ChatMemoryDigestMessage" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'candidates', COUNT(*)::integer FROM "MemoryCandidate" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'candidate-messages', COUNT(*)::integer FROM "MemoryCandidateMessage" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'candidate-decisions', COUNT(*)::integer FROM "MemoryCandidateDecision" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'facts', COUNT(*)::integer FROM "MemoryFact" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'versions', COUNT(*)::integer FROM "MemoryFactVersion" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'version-relations', COUNT(*)::integer FROM "MemoryFactVersionRelation" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'fact-extraction-executions', COUNT(*)::integer FROM "MemoryFactExtractionExecution" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'fact-extraction-candidate-receipts', COUNT(*)::integer FROM "MemoryFactExtractionCandidateReceipt" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'synthesis-executions', COUNT(*)::integer FROM "MemorySynthesisExecution" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'auxiliary-semantic-calls', COUNT(*)::integer FROM "MemoryAuxiliarySemanticCall" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'evidence', COUNT(*)::integer FROM "MemoryEvidence" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'source-dependencies', COUNT(*)::integer FROM "MemoryFactVersionSourceDependency" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'entities', COUNT(*)::integer FROM "MemoryEntity" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'entity-aliases', COUNT(*)::integer FROM "MemoryEntityAlias" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'entity-alias-supports', COUNT(*)::integer FROM "MemoryEntityAliasSupport" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'fact-entities', COUNT(*)::integer FROM "MemoryFactVersionEntity" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'events', COUNT(*)::integer FROM "MemoryEvent" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'feedback', COUNT(*)::integer FROM "MemoryFeedback" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'suppressions', COUNT(*)::integer FROM "MemorySuppression" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'pause-intervals', COUNT(*)::integer FROM "MemoryPauseInterval" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'barriers', COUNT(*)::integer FROM "MemorySourceBarrier" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'authorizations', COUNT(*)::integer FROM "MemoryMutationAuthorization" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'receipts', COUNT(*)::integer FROM "MemoryOperationReceipt" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'generations', COUNT(*)::integer FROM "MemoryIndexGeneration" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'search', COUNT(*)::integer FROM "MemorySearchEntry" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'embedding-batch-items', COUNT(*)::integer FROM "MemoryEmbeddingBatchItem" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'attempts', COUNT(*)::integer FROM "MemoryRetrievalAttempt" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'attempt-items', COUNT(*)::integer FROM "MemoryRetrievalAttemptItem" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'run-bindings', COUNT(*)::integer FROM "ModelRunMemoryBinding" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'run-items', COUNT(*)::integer FROM "ModelRunMemoryItem" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'history-runs', COUNT(*)::integer FROM "MemoryHistoryRun" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'tool-egress', COUNT(*)::integer FROM "MemoryToolEgressReceipt" WHERE "userId" = ${input.userId}
      UNION ALL SELECT 'other-deletions', COUNT(*)::integer
        FROM "MemoryDeletionOutbox"
        WHERE "userId" = ${input.userId} AND "id" <> ${input.deletionId}
      UNION ALL SELECT 'current-deletion',
        CASE WHEN COUNT(*) = 1 THEN 0 ELSE 1 END::integer
        FROM "MemoryDeletionOutbox"
        WHERE "userId" = ${input.userId}
          AND "id" = ${input.deletionId}
          AND "operation" = 'ACCOUNT_MEMORY_DELETE'::"MemoryDeletionOperation"
      UNION ALL SELECT 'unsafe-executions', COUNT(*)::integer
        FROM "MemoryExecutionBinding" AS binding
        WHERE binding."userId" = ${input.userId}
          AND NOT (
            binding."ownerType" IN (
              'JOB'::"MemoryExecutionOwnerType",
              'MUTATION_AUTHORIZATION'::"MemoryExecutionOwnerType"
            )
            AND binding."state" IN (
              'SUCCEEDED'::"MemoryExecutionState",
              'FAILED'::"MemoryExecutionState",
              'CANCELLED'::"MemoryExecutionState"
            )
            AND binding."relationsDetachedAt" IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "UsageEvent" AS usage
              WHERE usage."userId" = binding."userId"
                AND usage."memoryExecutionBindingId" = binding."id"
            )
          )
      UNION ALL SELECT 'unsafe-jobs', COUNT(*)::integer
        FROM "MemoryJob" AS job
        WHERE job."userId" = ${input.userId}
          AND (
            job."state" NOT IN (
              'SUCCEEDED'::"MemoryJobState",
              'TERMINAL_FAILED'::"MemoryJobState",
              'STALE'::"MemoryJobState",
              'CANCELLED'::"MemoryJobState"
            )
            OR job."errorMessage" IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM "MemoryExecutionBinding" AS binding
              INNER JOIN "UsageEvent" AS usage
                ON usage."userId" = binding."userId"
                AND usage."memoryExecutionBindingId" = binding."id"
              WHERE binding."userId" = job."userId"
                AND binding."memoryJobId" = job."id"
                AND binding."relationsDetachedAt" IS NOT NULL
            )
          )
    ) AS inventory
    WHERE residual <> 0
    ORDER BY owner
  `);
  if (rows.some((row) => !Number.isSafeInteger(row.residual) || row.residual < 0)) {
    throw new MemoryCoordinatorError("memory_account_deletion_audit_invalid", true);
  }
  return rows.map((row) => row.owner);
}

export async function assertAccountMemoryDeletionComplete(
  tx: Prisma.TransactionClient,
  input: Readonly<{ deletionId: string; userId: string }>
): Promise<void> {
  if ((await inspectAccountMemoryDeletionResiduals(tx, input)).length > 0) {
    throw new MemoryCoordinatorError("memory_account_deletion_incomplete", true);
  }
}

async function applyAccountMemoryDeletion(
  tx: Prisma.TransactionClient,
  claim: AccountMemoryDeletionClaim,
  now: Date
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL DEFERRED`);
  await assertFence(tx, claim);
  await assertGlobalOwnersSettled(tx, claim.userId);
  await cancelUndispatchedWork(tx, claim.userId, now);
  await assertExecutionsSafeToPurge(tx, claim.userId, now);
  await purgeReusableAndPrivateMemory(tx, claim, now);
  await assertAccountMemoryDeletionComplete(tx, {
    deletionId: claim.id,
    userId: claim.userId
  });
}

export function createPrismaAccountMemoryDeletionHandler(
  _client?: PrismaClient
): MemoryDeletionHandler {
  return Object.freeze({
    async execute(claim, context) {
      const parsed = assertClaim(claim);
      const now = context.now();
      if (!Number.isFinite(now.getTime())) {
        throw new MemoryCoordinatorError("memory_account_deletion_clock_invalid", true);
      }
      return {
        apply: (tx) => applyAccountMemoryDeletion(tx, parsed, now)
      };
    },
    operation: "ACCOUNT_MEMORY_DELETE"
  });
}
