import { Prisma } from "@prisma/client";
import { RUN_PREPARATION_FAILURE_MESSAGE } from "../../contracts/runs";

/**
 * TEMPORARY BRIDGE — the Memory drop task deletes this file together with the old Memory tables.
 *
 * Chat and account deletion no longer go through the Memory coordinator, but until the old tables are dropped
 * their rows still reference chats, messages, runs and accounts, many through restrictive keys that would refuse
 * the delete. These statements clear exactly those rows, in plain SQL against the tables, so the deletion paths
 * import nothing from `lib/server/memory/`. They port the Memory section of the previous permanent-deletion,
 * Temporary-deletion and account-deletion handlers, without "also forget origin memories" (the facts it forgot
 * are dropped with the tables). The tables they name: ChatMemoryCheckpoint(+Message), MemoryRecallChunk(+Message),
 * MemoryRecallRound(+Message), MemorySearchEntry, MemoryRetrievalAttempt(+Item), ModelRunMemoryItem, MemoryEvidence,
 * MemorySuppression, MemoryCandidate(+Message), MemoryFactVersion, MemoryFactVersionRelation,
 * MemoryFactExtractionExecution, MemoryAuxiliarySemanticCall, MemoryEvent, MemoryScope, MemoryMutationAuthorization,
 * MemoryOperationReceipt, MemoryJob, MemoryExecutionBinding, MemoryFeedback, MemoryHistoryRun, the account's every
 * Memory table, and `UsageEvent.memoryExecutionBindingId`.
 */

type Tx = Prisma.TransactionClient;

type ChatScope = Readonly<{ chatId: string; userId: string }>;

/** Runs (and their Memory retrieval attempts and execution bindings) of one chat that is going away. */
async function chatExecutionIds(
  tx: Tx,
  scope: ChatScope,
  runIds: readonly string[]
): Promise<Readonly<{ attemptIds: string[]; bindingIds: string[]; jobIds: string[] }>> {
  const jobs = await tx.memoryJob.findMany({
    select: { id: true },
    where: { chatId: scope.chatId, userId: scope.userId }
  });
  const jobIds = jobs.map(({ id }) => id);
  const attempts = runIds.length > 0
    ? await tx.memoryRetrievalAttempt.findMany({
        select: { id: true },
        where: { modelRunId: { in: [...runIds] }, userId: scope.userId }
      })
    : [];
  const attemptIds = attempts.map(({ id }) => id);
  const owners = [
    ...(runIds.length > 0 ? [{ modelRunId: { in: [...runIds] } }] : []),
    ...(jobIds.length > 0 ? [{ memoryJobId: { in: jobIds } }] : []),
    ...(attemptIds.length > 0 ? [{ retrievalAttemptId: { in: attemptIds } }] : [])
  ];
  const bindings = owners.length > 0
    ? await tx.memoryExecutionBinding.findMany({
        select: { id: true },
        where: { OR: owners, userId: scope.userId }
      })
    : [];
  return { attemptIds, bindingIds: bindings.map(({ id }) => id), jobIds };
}

/**
 * Before the chat's runs are settled as failed (Temporary expiry): Memory calls of those runs that never started
 * are cancelled, those in flight become outcome-unknown, and open retrieval attempts are cancelled.
 */
export async function settleLegacyMemoryWorkOfChat(
  tx: Tx,
  scope: ChatScope,
  input: Readonly<{ errorCode: string; now: Date; runIds: readonly string[] }>
): Promise<void> {
  if (input.runIds.length === 0) return;
  const ids = await chatExecutionIds(tx, scope, input.runIds);
  const owners = [
    { modelRunId: { in: [...input.runIds] } },
    ...(ids.attemptIds.length > 0 ? [{ retrievalAttemptId: { in: ids.attemptIds } }] : []),
    ...(ids.jobIds.length > 0 ? [{ memoryJobId: { in: ids.jobIds } }] : [])
  ];
  await tx.memoryExecutionBinding.updateMany({
    data: { completedAt: input.now, errorCode: input.errorCode, state: "CANCELLED" },
    where: { OR: owners, state: "PENDING", userId: scope.userId }
  });
  await tx.memoryExecutionBinding.updateMany({
    data: { completedAt: input.now, errorCode: input.errorCode, state: "OUTCOME_UNKNOWN" },
    where: { OR: owners, state: "RUNNING", userId: scope.userId }
  });
  await tx.memoryRetrievalAttempt.updateMany({
    data: { errorCode: input.errorCode, state: "CANCELLED", updatedAt: input.now },
    where: {
      modelRunId: { in: [...input.runIds] },
      state: { in: ["PENDING", "EXECUTING", "READY"] },
      userId: scope.userId
    }
  });
}

/**
 * Memory rows of one chat that would refuse or outlive its deletion: run inside the deleting transaction, before
 * the chat's runs, attachments and the chat row go. Derived history (chunks, rounds, checkpoints, search entries,
 * evidence, candidates, suppressions) is deleted; fact history keeps its events with the chat link cleared; a
 * chat scope is orphaned; usage keeps its row and loses only its Memory link; `memory_search` receipts in other
 * chats that cite this chat are scrubbed, as the old history purge did.
 */
export async function purgeLegacyMemoryRowsOfChat(
  tx: Tx,
  scope: ChatScope,
  input: Readonly<{ now: Date; runIds: readonly string[] }>
): Promise<void> {
  const { chatId, userId } = scope;
  const runIds = [...input.runIds];
  const [chunks, rounds, candidates] = await Promise.all([
    tx.memoryRecallChunk.findMany({ select: { id: true }, where: { chatId, userId } }),
    tx.memoryRecallRound.findMany({ select: { id: true }, where: { chatId, userId } }),
    tx.memoryCandidate.findMany({ select: { id: true }, where: { chatId, userId } })
  ]);
  const chunkIds = chunks.map(({ id }) => id);
  const roundIds = rounds.map(({ id }) => id);
  const candidateIds = candidates.map(({ id }) => id);
  const ids = await chatExecutionIds(tx, scope, runIds);

  await scrubFeedback(tx, userId, Prisma.join([
    Prisma.sql`(feedback."sourceChatIdSnapshot" = ${chatId})`,
    ...(runIds.length > 0 ? [Prisma.sql`(feedback."modelRunId" IN (${Prisma.join(runIds)}))`] : []),
    ...(chunkIds.length > 0 ? [Prisma.sql`(feedback."recallChunkId" IN (${Prisma.join(chunkIds)}))`] : []),
    ...(roundIds.length > 0 ? [Prisma.sql`(feedback."recallRoundId" IN (${Prisma.join(roundIds)}))`] : [])
  ], " OR "));
  await settleAttemptItemsCitingChat(tx, scope, chunkIds, roundIds);
  await scrubHistoryReceiptsCitingChat(tx, scope);
  if (roundIds.length > 0) {
    // Clear the composite round target in one row update before either side goes (an immediate shape check
    // would otherwise see a segment reference without its round).
    await tx.modelRunMemoryItem.updateMany({
      data: { recallRoundId: null, recallRoundSegmentId: null },
      where: { recallRoundId: { in: roundIds }, userId }
    });
  }
  if (chunkIds.length > 0 || roundIds.length > 0) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        OR: [{ recallChunkId: { in: chunkIds } }, { recallRoundId: { in: roundIds } }],
        userId
      }
    });
  }
  await tx.memoryEvidence.deleteMany({ where: { chatId, userId } });
  await tx.memorySuppression.deleteMany({ where: { sourceChatId: chatId, userId } });
  if (candidateIds.length > 0) {
    await tx.memoryCandidateMessage.deleteMany({ where: { candidateId: { in: candidateIds }, userId } });
    await tx.memoryCandidate.deleteMany({ where: { id: { in: candidateIds }, userId } });
  }
  await releaseExecutionReferences(tx, userId, ids);
  if (roundIds.length > 0) {
    await tx.memoryRecallRoundMessage.deleteMany({ where: { roundId: { in: roundIds }, userId } });
    await tx.memoryRecallRound.deleteMany({ where: { id: { in: roundIds }, userId } });
  }
  if (chunkIds.length > 0) {
    await tx.memoryRecallChunkMessage.deleteMany({ where: { chunkId: { in: chunkIds }, userId } });
    await tx.memoryRecallChunk.deleteMany({ where: { id: { in: chunkIds }, userId } });
  }
  await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId, userId } });
  await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId, userId } });
  await tx.memoryEvent.updateMany({
    data: { sourceChatId: null, sourceDeletedAt: input.now },
    where: { sourceChatId: chatId, sourceDeletedAt: null, userId }
  });
  await tx.memoryScope.updateMany({
    data: { chatId: null, orphanedAt: input.now, state: "ORPHANED" },
    where: { chatId, state: "ACTIVE", userId }
  });
  await tx.memoryMutationAuthorization.deleteMany({
    where: {
      OR: [{ sourceChatId: chatId }, ...(runIds.length > 0 ? [{ modelRunId: { in: runIds } }] : [])],
      userId
    }
  });
  if (ids.bindingIds.length > 0) {
    // Content-free accounting outlives the chat: usage keeps its row and loses only its Memory link.
    await tx.usageEvent.updateMany({
      data: { memoryExecutionBindingId: null, providerModelId: null },
      where: { memoryExecutionBindingId: { in: ids.bindingIds }, userId }
    });
  }
  if (runIds.length > 0) {
    await tx.memoryOperationReceipt.deleteMany({ where: { modelRunId: { in: runIds }, userId } });
  }
  if (ids.jobIds.length > 0) {
    await tx.memoryJob.deleteMany({ where: { id: { in: ids.jobIds }, userId } });
  }
}

/** Facts classified by a call of this chat lose that provenance and wait for reclassification, as before. */
async function releaseExecutionReferences(
  tx: Tx,
  userId: string,
  ids: Readonly<{ bindingIds: readonly string[]; jobIds: readonly string[] }>
): Promise<void> {
  const bindingIds = [...ids.bindingIds];
  if (bindingIds.length > 0) {
    const versions = await tx.memoryFactVersion.findMany({
      select: { id: true },
      where: { safetyClassifierExecutionId: { in: bindingIds }, userId }
    });
    if (versions.length > 0) {
      const versionIds = versions.map(({ id }) => id);
      await tx.memorySearchEntry.deleteMany({ where: { factVersionId: { in: versionIds }, userId } });
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
        where: { id: { in: versionIds }, safetyClassifierExecutionId: { in: bindingIds }, userId }
      });
    }
    await tx.memoryFactVersionRelation.updateMany({
      data: { executionId: null },
      where: { executionId: { in: bindingIds }, userId }
    });
    await tx.memoryFactExtractionExecution.deleteMany({
      where: { executionBindingId: { in: bindingIds }, userId }
    });
  }
  const owners = [
    ...(bindingIds.length > 0 ? [{ executionId: { in: bindingIds } }] : []),
    ...(ids.jobIds.length > 0 ? [{ ownerJobId: { in: [...ids.jobIds] } }] : [])
  ];
  if (owners.length > 0) {
    await tx.memoryAuxiliarySemanticCall.deleteMany({ where: { OR: owners, userId } });
  }
}

/** Feedback about the chat keeps its row but loses its content and links (the old review purge). */
async function scrubFeedback(tx: Tx, userId: string, predicate: Prisma.Sql): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    WITH RECURSIVE selected AS (
      SELECT feedback."id", feedback."retractsFeedbackId"
      FROM "MemoryFeedback" AS feedback
      WHERE feedback."userId" = ${userId}
        AND feedback."contentPurgedAt" IS NULL
        AND (${predicate})
      UNION
      SELECT related."id", related."retractsFeedbackId"
      FROM "MemoryFeedback" AS related
      INNER JOIN selected
        ON related."retractsFeedbackId" = selected."id"
        OR selected."retractsFeedbackId" = related."id"
      WHERE related."userId" = ${userId}
        AND related."contentPurgedAt" IS NULL
    )
    UPDATE "MemoryFeedback" AS feedback
    SET
      "memoryFactId" = NULL, "memoryFactVersionId" = NULL, "recallChunkId" = NULL, "recallRoundId" = NULL,
      "modelRunId" = NULL, "modelRunMemoryItemId" = NULL, "modelRunToolCallId" = NULL,
      "sourceChatIdSnapshot" = NULL, "sourceBranchGenerationSnapshot" = NULL, "comment" = NULL,
      "retractsFeedbackId" = NULL, "memoryEventId" = NULL,
      "contentPurgedAt" = CURRENT_TIMESTAMP, "purgeReason" = 'source_chat_deleted'
    WHERE feedback."userId" = ${userId}
      AND feedback."contentPurgedAt" IS NULL
      AND feedback."id" IN (SELECT selected."id" FROM selected)
  `);
}

/**
 * Staged retrieval items that cite the chat go; a retrieval still preparing with them goes stale, and its run
 * (another chat's, preparing) fails visibly instead of answering from deleted text.
 */
async function settleAttemptItemsCitingChat(
  tx: Tx,
  scope: ChatScope,
  chunkIds: readonly string[],
  roundIds: readonly string[]
): Promise<void> {
  const predicates: Prisma.Sql[] = [Prisma.sql`item."sourceChatIdSnapshot" = ${scope.chatId}`];
  if (chunkIds.length > 0) predicates.push(Prisma.sql`item."recallChunkId" IN (${Prisma.join([...chunkIds])})`);
  if (roundIds.length > 0) predicates.push(Prisma.sql`item."recallRoundId" IN (${Prisma.join([...roundIds])})`);
  await tx.$executeRaw(Prisma.sql`
    WITH deleted AS (
      DELETE FROM "MemoryRetrievalAttemptItem" AS item
      WHERE item."userId" = ${scope.userId}
        AND (${Prisma.join(predicates, " OR ")})
      RETURNING item."userId", item."attemptId"
    ), affected AS (
      SELECT DISTINCT deleted."userId", deleted."attemptId" FROM deleted
    ), settled_attempts AS (
      UPDATE "MemoryRetrievalAttempt" AS attempt
      SET
        "state" = 'STALE'::"MemoryRetrievalAttemptState",
        "preparedContextText" = NULL,
        "preparedContextHash" = NULL,
        "preparedContextTokenCount" = NULL,
        "errorCode" = 'memory_source_deleted',
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
        attempt."admittedAssistantLeafMessageId",
        attempt."boundedPrivateBaseRequestSnapshot", attempt."chatId",
        attempt."modelRunId", attempt."userId"
    ), settled_runs AS (
      UPDATE "ModelRun" AS run
      SET
        "errorPayload" = jsonb_build_object(
          'code', 'memory_source_deleted',
          'message', ${RUN_PREPARATION_FAILURE_MESSAGE}::text
        ),
        "normalizedRequest" = COALESCE(
          run."normalizedRequest",
          attempt."boundedPrivateBaseRequestSnapshot" -> 'normalizedRequest',
          '{}'::jsonb
        ),
        "status" = 'error'::"ModelRunStatus",
        "updatedAt" = CURRENT_TIMESTAMP
      FROM settled_attempts AS attempt
      WHERE run."id" = attempt."modelRunId"
        AND run."userId" = attempt."userId"
        AND run."status" = 'preparing'::"ModelRunStatus"
      RETURNING run."id", run."userId"
    )
    UPDATE "Message" AS message
    SET
      "errorMessage" = ${RUN_PREPARATION_FAILURE_MESSAGE},
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

/**
 * `memory_search` receipts of the owner's other chats whose results cite this chat lose their query and results,
 * and their tool calls keep only a scrubbed marker, so the deleted chat's text does not survive in them.
 */
async function scrubHistoryReceiptsCitingChat(tx: Tx, scope: ChatScope): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    WITH affected AS MATERIALIZED (
      SELECT history."id", history."modelRunToolCallId"
      FROM "MemoryHistoryRun" AS history
      WHERE history."userId" = ${scope.userId}
        AND history."retentionState" = 'RETAINED'::"MemoryReceiptRetentionState"
        AND jsonb_path_query_array(history."results", '$.results[*].sourceChatId'::jsonpath) ? ${scope.chatId}::text
    ), scrubbed_history AS (
      UPDATE "MemoryHistoryRun" AS history
      SET
        "query" = NULL,
        "privateRequest" = '{}'::jsonb,
        "results" = NULL,
        "providerResult" = NULL,
        "resultHash" = NULL,
        "retentionState" = 'SCRUBBED'::"MemoryReceiptRetentionState",
        "plaintextPurgedAt" = COALESCE(history."plaintextPurgedAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP
      FROM affected
      WHERE history."id" = affected."id"
        AND history."state" <> 'RUNNING'::"MemoryHistoryRunState"
      RETURNING history."modelRunToolCallId"
    )
    UPDATE "ModelRunToolCall" AS call
    SET
      "arguments" = '{}'::jsonb,
      "result" = jsonb_build_object(
        'callId', call."providerCallId",
        'content', jsonb_build_array(jsonb_build_object(
          'type', 'json',
          'value', jsonb_build_object('error', 'memory_history_receipt_scrubbed')
        )),
        'name', call."toolName",
        'rawPreview', jsonb_build_object(
          'error', 'memory_history_receipt_scrubbed',
          'resultType', 'private_history'
        ),
        'status', CASE WHEN call."state" = 'complete'::"ModelRunToolCallState" THEN 'complete' ELSE 'error' END
      ),
      "updatedAt" = CURRENT_TIMESTAMP
    FROM scrubbed_history
    WHERE call."id" = scrubbed_history."modelRunToolCallId"
  `);
}

/**
 * Every Memory row of an account that is being deleted, in one statement: the old tables reference each other
 * through restrictive keys and a cycle, and a single statement checks them only once all its deletes are done.
 * The account has no chats, runs or attachments left (stale-account deletion requires it), so nothing here
 * reaches a chat; usage tied to a Memory call goes with the account, as the old account purge ended.
 */
export async function purgeLegacyMemoryRowsOfAccount(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL DEFERRED`);
  await tx.$executeRaw(Prisma.sql`
    WITH
      d_usage AS (DELETE FROM "UsageEvent" WHERE "userId" = ${userId} AND "memoryExecutionBindingId" IS NOT NULL RETURNING 1),
      d_feedback AS (DELETE FROM "MemoryFeedback" WHERE "userId" = ${userId} RETURNING 1),
      d_history_runs AS (DELETE FROM "MemoryHistoryRun" WHERE "userId" = ${userId} RETURNING 1),
      d_run_items AS (DELETE FROM "ModelRunMemoryItem" WHERE "userId" = ${userId} RETURNING 1),
      d_run_bindings AS (DELETE FROM "ModelRunMemoryBinding" WHERE "userId" = ${userId} RETURNING 1),
      d_attempt_items AS (DELETE FROM "MemoryRetrievalAttemptItem" WHERE "userId" = ${userId} RETURNING 1),
      d_attempts AS (DELETE FROM "MemoryRetrievalAttempt" WHERE "userId" = ${userId} RETURNING 1),
      d_batch_items AS (DELETE FROM "MemoryEmbeddingBatchItem" WHERE "userId" = ${userId} RETURNING 1),
      d_search AS (DELETE FROM "MemorySearchEntry" WHERE "userId" = ${userId} RETURNING 1),
      d_extraction_receipts AS (DELETE FROM "MemoryFactExtractionCandidateReceipt" WHERE "userId" = ${userId} RETURNING 1),
      d_extractions AS (DELETE FROM "MemoryFactExtractionExecution" WHERE "userId" = ${userId} RETURNING 1),
      d_maintenance_executions AS (DELETE FROM "MemoryMaintenanceExecution" WHERE "userId" = ${userId} RETURNING 1),
      d_maintenance_reviews AS (DELETE FROM "MemoryMaintenanceReview" WHERE "userId" = ${userId} RETURNING 1),
      d_maintenance_suppressions AS (DELETE FROM "MemoryMaintenanceSuppression" WHERE "userId" = ${userId} RETURNING 1),
      d_auxiliary_calls AS (DELETE FROM "MemoryAuxiliarySemanticCall" WHERE "userId" = ${userId} RETURNING 1),
      d_candidate_decisions AS (DELETE FROM "MemoryCandidateDecision" WHERE "userId" = ${userId} RETURNING 1),
      d_candidate_messages AS (DELETE FROM "MemoryCandidateMessage" WHERE "userId" = ${userId} RETURNING 1),
      d_candidates AS (DELETE FROM "MemoryCandidate" WHERE "userId" = ${userId} RETURNING 1),
      d_authorizations AS (DELETE FROM "MemoryMutationAuthorization" WHERE "userId" = ${userId} RETURNING 1),
      d_receipts AS (DELETE FROM "MemoryOperationReceipt" WHERE "userId" = ${userId} RETURNING 1),
      d_identity AS (DELETE FROM "MemoryIdentityCompatibility" WHERE "userId" = ${userId} RETURNING 1),
      d_relations AS (DELETE FROM "MemoryFactVersionRelation" WHERE "userId" = ${userId} RETURNING 1),
      d_dependencies AS (DELETE FROM "MemoryFactVersionSourceDependency" WHERE "userId" = ${userId} RETURNING 1),
      d_alias_supports AS (DELETE FROM "MemoryEntityAliasSupport" WHERE "userId" = ${userId} RETURNING 1),
      d_fact_entities AS (DELETE FROM "MemoryFactVersionEntity" WHERE "userId" = ${userId} RETURNING 1),
      d_aliases AS (DELETE FROM "MemoryEntityAlias" WHERE "userId" = ${userId} RETURNING 1),
      d_evidence AS (DELETE FROM "MemoryEvidence" WHERE "userId" = ${userId} RETURNING 1),
      d_tool_events AS (DELETE FROM "MemoryToolEvent" WHERE "userId" = ${userId} RETURNING 1),
      d_suppressions AS (DELETE FROM "MemorySuppression" WHERE "userId" = ${userId} RETURNING 1),
      d_pauses AS (DELETE FROM "MemoryPauseInterval" WHERE "userId" = ${userId} RETURNING 1),
      d_barriers AS (DELETE FROM "MemorySourceBarrier" WHERE "userId" = ${userId} RETURNING 1),
      d_segment_messages AS (DELETE FROM "MemoryRecallRoundSegmentMessage" WHERE "userId" = ${userId} RETURNING 1),
      d_segments AS (DELETE FROM "MemoryRecallRoundSegment" WHERE "userId" = ${userId} RETURNING 1),
      d_round_messages AS (DELETE FROM "MemoryRecallRoundMessage" WHERE "userId" = ${userId} RETURNING 1),
      d_rounds AS (DELETE FROM "MemoryRecallRound" WHERE "userId" = ${userId} RETURNING 1),
      d_chunk_messages AS (DELETE FROM "MemoryRecallChunkMessage" WHERE "userId" = ${userId} RETURNING 1),
      d_chunks AS (DELETE FROM "MemoryRecallChunk" WHERE "userId" = ${userId} RETURNING 1),
      d_checkpoint_messages AS (DELETE FROM "ChatMemoryCheckpointMessage" WHERE "userId" = ${userId} RETURNING 1),
      d_checkpoints AS (DELETE FROM "ChatMemoryCheckpoint" WHERE "userId" = ${userId} RETURNING 1),
      d_events AS (DELETE FROM "MemoryEvent" WHERE "userId" = ${userId} RETURNING 1),
      d_versions AS (DELETE FROM "MemoryFactVersion" WHERE "userId" = ${userId} RETURNING 1),
      d_facts AS (DELETE FROM "MemoryFact" WHERE "userId" = ${userId} RETURNING 1),
      d_entities AS (DELETE FROM "MemoryEntity" WHERE "userId" = ${userId} RETURNING 1),
      d_scopes AS (DELETE FROM "MemoryScope" WHERE "userId" = ${userId} RETURNING 1),
      d_bindings AS (DELETE FROM "MemoryExecutionBinding" WHERE "userId" = ${userId} RETURNING 1),
      d_jobs AS (DELETE FROM "MemoryJob" WHERE "userId" = ${userId} RETURNING 1),
      d_generations AS (DELETE FROM "MemoryIndexGeneration" WHERE "userId" = ${userId} RETURNING 1),
      d_outbox AS (DELETE FROM "MemoryDeletionOutbox" WHERE "userId" = ${userId} RETURNING 1)
    DELETE FROM "UserMemorySettings" WHERE "userId" = ${userId}
  `);
}
