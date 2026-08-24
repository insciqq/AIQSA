import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryDeletionClaim,
  MemoryDeletionHandler
} from "../coordinator/types";
import type { MemoryTransaction } from "../persistence/transaction";
import {
  inspectMemoryFeedbackHistoryClear,
  inspectMemoryFeedbackInvalidSource,
  purgeMemoryFeedbackHistoryClear,
  purgeMemoryFeedbackInvalidSource
} from "../review/purge";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";

export const MEMORY_HISTORY_CLEAR_MANIFEST_VERSION =
  "memory-history-clear-v1";
export const MEMORY_HISTORY_SOURCE_PURGE_MANIFEST_VERSION =
  "memory-history-source-v1";
export const MEMORY_HISTORY_CLEAR_TARGET_TYPE =
  `HISTORY_INDEX@${MEMORY_HISTORY_CLEAR_MANIFEST_VERSION}`;
export const MEMORY_HISTORY_SOURCE_TARGET_TYPE =
  `HISTORY_SOURCE@${MEMORY_HISTORY_SOURCE_PURGE_MANIFEST_VERSION}`;

type HistoryPurgeSelection =
  | Readonly<{ barrierId: string; kind: "ALL_REUSABLE" }>
  | Readonly<{ barrierId: string; kind: "CLEAR" }>
  | Readonly<{ chatId: string; kind: "SOURCE" }>
  | Readonly<{ kind: "SUPPRESSED" }>;

type HistoryTargetIds = Readonly<{
  candidateIds: readonly string[];
  chunkIds: readonly string[];
  digestIds: readonly string[];
}>;

export type MemoryHistoryPurgeProgress = Readonly<{
  complete: boolean;
  completedUnits: number;
  totalUnits: number;
}>;

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
}

function parseHistoryDeletionTarget(
  claim: Pick<MemoryDeletionClaim, "operation" | "targetId" | "targetType">
): HistoryPurgeSelection | null {
  if (
    claim.operation === "BULK_CLEAR" &&
    claim.targetType === MEMORY_HISTORY_CLEAR_TARGET_TYPE &&
    validId(claim.targetId)
  ) {
    return { barrierId: claim.targetId, kind: "CLEAR" };
  }
  if (
    claim.operation === "SOURCE_PURGE" &&
    claim.targetType === MEMORY_HISTORY_SOURCE_TARGET_TYPE &&
    validId(claim.targetId)
  ) {
    return { chatId: claim.targetId, kind: "SOURCE" };
  }
  return null;
}

async function targetIds(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<HistoryTargetIds> {
  if (selection.kind === "CLEAR" || selection.kind === "ALL_REUSABLE") {
    const barrier = await tx.memorySourceBarrier.findFirst({
      select: { createdAt: true, sourceCreatedAtCutoff: true },
      where: {
        id: selection.barrierId,
        kind: selection.kind === "ALL_REUSABLE" ? "ALL_REUSABLE" : "HISTORY_INDEX",
        userId
      }
    });
    if (!barrier) {
      throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
    }
    const chunks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT chunk."id"
      FROM "MemoryRecallChunk" AS chunk
      LEFT JOIN "MemoryRecallChunkMessage" AS source_message
        ON source_message."userId" = chunk."userId"
        AND source_message."chunkId" = chunk."id"
      LEFT JOIN "Message" AS message
        ON message."chatId" = source_message."chatId"
        AND message."id" = source_message."messageId"
      WHERE chunk."userId" = ${userId}
        AND (
          chunk."createdAt" <= ${barrier.createdAt}
          OR message."createdAt" <= ${barrier.sourceCreatedAtCutoff}
        )
      ORDER BY chunk."id"
    `);
    const digests = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT digest."id"
      FROM "ChatMemoryDigest" AS digest
      LEFT JOIN "ChatMemoryDigestMessage" AS source_map
        ON source_map."userId" = digest."userId"
        AND source_map."digestId" = digest."id"
      LEFT JOIN "Message" AS message
        ON message."chatId" = source_map."chatId"
        AND message."id" = source_map."messageId"
      WHERE digest."userId" = ${userId}
        AND (digest."createdAt" <= ${barrier.createdAt}
          OR message."createdAt" <= ${barrier.sourceCreatedAtCutoff})
      ORDER BY digest."id"
    `);
    return {
      candidateIds: [],
      chunkIds: chunks.map(({ id }) => id),
      digestIds: digests.map(({ id }) => id)
    };
  }
  if (selection.kind === "SOURCE") {
    const chunks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT chunk."id"
      FROM "MemoryRecallChunk" AS chunk
      LEFT JOIN "Chat" AS chat
        ON chat."userId" = chunk."userId" AND chat."id" = chunk."chatId"
      WHERE chunk."userId" = ${userId}
        AND chunk."chatId" = ${selection.chatId}
        AND (
          chunk."state" <> 'ACTIVE'::"MemoryHistoryItemState"
          OR chat."id" IS NULL
          OR chat."memoryMode" <> 'NORMAL'::"MemoryChatMode"
          OR (
            chunk."chunkingVersion" <> ${MEMORY_HISTORY_CHUNKING_VERSION}
            AND (
              chat."memoryBranchGeneration" <> chunk."branchGeneration"
              OR chat."memorySourceRevision" <> chunk."sourceRevisionAtCreation"
            )
          )
          OR (
            chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
            AND (
              chunk."sourceProjectionVersion" <>
                ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
              OR NOT EXISTS (
                SELECT 1 FROM "MemoryRecallChunkMessage" AS source_map
                WHERE source_map."userId" = chunk."userId"
                  AND source_map."chatId" = chunk."chatId"
                  AND source_map."chunkId" = chunk."id"
              )
              OR EXISTS (
                SELECT 1
                FROM "MemoryRecallChunkMessage" AS source_map
                LEFT JOIN "Message" AS source_message
                  ON source_message."chatId" = source_map."chatId"
                  AND source_message."id" = source_map."messageId"
                WHERE source_map."userId" = chunk."userId"
                  AND source_map."chatId" = chunk."chatId"
                  AND source_map."chunkId" = chunk."id"
                  AND (
                    source_message."id" IS NULL
                    OR source_message."updatedAt" <>
                      source_map."sourceMessageUpdatedAt"
                    OR NOT EXISTS (
                      WITH RECURSIVE active_path AS (
                        SELECT message."id", message."parentMessageId"
                        FROM "Message" AS message
                        WHERE message."chatId" = chat."id"
                          AND message."id" = chat."activeLeafMessageId"
                        UNION ALL
                        SELECT parent."id", parent."parentMessageId"
                        FROM active_path AS child
                        INNER JOIN "Message" AS parent
                          ON parent."chatId" = chat."id"
                          AND parent."id" = child."parentMessageId"
                      )
                      SELECT 1 FROM active_path
                      WHERE active_path."id" = source_map."messageId"
                    )
                  )
              )
            )
          )
        )
      ORDER BY chunk."id"
    `);
    const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT candidate."id"
      FROM "MemoryCandidate" AS candidate
      LEFT JOIN "Chat" AS chat
        ON chat."userId" = candidate."userId" AND chat."id" = candidate."chatId"
      WHERE candidate."userId" = ${userId}
        AND candidate."chatId" = ${selection.chatId}
        AND (
          candidate."state" = 'STALE'::"MemoryCandidateState"
          OR chat."id" IS NULL
          OR chat."memoryMode" <> 'NORMAL'::"MemoryChatMode"
          OR chat."memoryBranchGeneration" <> candidate."branchGeneration"
          OR (
            candidate."proposedScope" ->> 'type' = 'FOLDER'
            AND candidate."proposedScope" ->> 'target_id'
              IS DISTINCT FROM chat."folderId"
          )
        )
      ORDER BY candidate."id"
      FOR UPDATE OF candidate
    `);
    const digests = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT digest."id"
      FROM "ChatMemoryDigest" AS digest
      LEFT JOIN "Chat" AS chat
        ON chat."userId" = digest."userId" AND chat."id" = digest."chatId"
      WHERE digest."userId" = ${userId}
        AND digest."chatId" = ${selection.chatId}
        AND (digest."state" <> 'ACTIVE'::"MemoryHistoryItemState"
          OR chat."id" IS NULL
          OR chat."memoryMode" <> 'NORMAL'::"MemoryChatMode"
          OR chat."memoryBranchGeneration" <> digest."branchGeneration"
          OR chat."memorySourceRevision" <> digest."sourceRevisionAtCreation"
          OR chat."activeLeafMessageId" IS DISTINCT FROM digest."activeLeafMessageId")
      ORDER BY digest."id"
    `);
    return {
      candidateIds: candidates.map(({ id }) => id),
      chunkIds: chunks.map(({ id }) => id),
      digestIds: digests.map(({ id }) => id)
    };
  }

  const chunks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT chunk."id"
    FROM "MemoryRecallChunk" AS chunk
    INNER JOIN "MemoryRecallChunkMessage" AS source_message
      ON source_message."userId" = chunk."userId"
      AND source_message."chunkId" = chunk."id"
    INNER JOIN "MemorySuppression" AS suppression
      ON suppression."userId" = source_message."userId"
      AND (
        suppression."scope" = 'ALL'::"MemorySuppressionScope"
        OR (
          suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND suppression."sourceChatId" = source_message."chatId"
          AND suppression."sourceMessageId" = source_message."messageId"
          AND (
            suppression."sourceBranchGeneration" IS NULL
            OR suppression."sourceBranchGeneration" = chunk."branchGeneration"
          )
        )
      )
    WHERE chunk."userId" = ${userId}
      AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
    ORDER BY chunk."id"
  `);
  const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT candidate."id"
    FROM "MemoryCandidate" AS candidate
    LEFT JOIN "MemoryCandidateMessage" AS source_message
      ON source_message."userId" = candidate."userId"
      AND source_message."candidateId" = candidate."id"
    INNER JOIN "MemorySuppression" AS suppression
      ON suppression."userId" = candidate."userId"
      AND (
        suppression."scope" = 'ALL'::"MemorySuppressionScope"
        OR (
          suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND suppression."sourceChatId" = source_message."chatId"
          AND suppression."sourceMessageId" = source_message."messageId"
          AND (
            suppression."sourceBranchGeneration" IS NULL
            OR suppression."sourceBranchGeneration" = candidate."branchGeneration"
          )
        )
      )
    WHERE candidate."userId" = ${userId}
      AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
    ORDER BY candidate."id"
  `);
  const digests = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT digest."id"
    FROM "ChatMemoryDigest" AS digest
    INNER JOIN "ChatMemoryDigestMessage" AS source_map
      ON source_map."userId" = digest."userId"
      AND source_map."digestId" = digest."id"
    INNER JOIN "MemorySuppression" AS suppression
      ON suppression."userId" = source_map."userId"
      AND (suppression."scope" = 'ALL'::"MemorySuppressionScope" OR (
        suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
        AND suppression."sourceChatId" = source_map."chatId"
        AND suppression."sourceMessageId" = source_map."messageId"
      ))
    WHERE digest."userId" = ${userId}
      AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
    ORDER BY digest."id"
  `);
  return {
    candidateIds: candidates.map(({ id }) => id),
    chunkIds: chunks.map(({ id }) => id),
    digestIds: digests.map(({ id }) => id)
  };
}

function targetPredicate(ids: HistoryTargetIds): Prisma.Sql {
  const predicates: Prisma.Sql[] = [];
  if (ids.chunkIds.length > 0) {
    predicates.push(Prisma.sql`item."recallChunkId" IN (${Prisma.join([...ids.chunkIds])})`);
  }
  return predicates.length === 0
    ? Prisma.sql`FALSE`
    : Prisma.join(predicates, " OR ");
}

async function settleAttemptItems(
  tx: MemoryTransaction,
  userId: string,
  ids: HistoryTargetIds
): Promise<void> {
  // Finalized bindings require their attempt to remain CONSUMED. Scrub an
  // already-consumed pack to the canonical empty-text triple; only live
  // attempts transition to STALE.
  await tx.$executeRaw(Prisma.sql`
    WITH deleted AS (
      DELETE FROM "MemoryRetrievalAttemptItem" AS item
      WHERE item."userId" = ${userId}
        AND (${targetPredicate(ids)})
      RETURNING item."userId", item."attemptId"
    ), affected AS (
      SELECT DISTINCT deleted."userId", deleted."attemptId"
      FROM deleted
    ), settled_attempts AS (
      UPDATE "MemoryRetrievalAttempt" AS attempt
      SET
        "state" = CASE
          WHEN attempt."state" IN (
            'PENDING'::"MemoryRetrievalAttemptState",
            'EXECUTING'::"MemoryRetrievalAttemptState",
            'READY'::"MemoryRetrievalAttemptState"
          ) THEN 'STALE'::"MemoryRetrievalAttemptState"
          ELSE attempt."state"
        END,
        "preparedContextText" = CASE
          WHEN attempt."state" = 'CONSUMED'::"MemoryRetrievalAttemptState" THEN ''
          ELSE NULL
        END,
        "preparedContextHash" = CASE
          WHEN attempt."state" = 'CONSUMED'::"MemoryRetrievalAttemptState"
            THEN 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          ELSE NULL
        END,
        "preparedContextTokenCount" = CASE
          WHEN attempt."state" = 'CONSUMED'::"MemoryRetrievalAttemptState" THEN 0
          ELSE NULL
        END,
        "consumedAt" = CASE
          WHEN attempt."state" IN (
            'PENDING'::"MemoryRetrievalAttemptState",
            'EXECUTING'::"MemoryRetrievalAttemptState",
            'READY'::"MemoryRetrievalAttemptState"
          ) THEN NULL
          ELSE attempt."consumedAt"
        END,
        "errorCode" = CASE
          WHEN attempt."state" IN (
            'PENDING'::"MemoryRetrievalAttemptState",
            'EXECUTING'::"MemoryRetrievalAttemptState",
            'READY'::"MemoryRetrievalAttemptState",
            'CONSUMED'::"MemoryRetrievalAttemptState"
          ) THEN 'memory_source_stale'
          ELSE attempt."errorCode"
        END,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM affected
      WHERE attempt."userId" = affected."userId"
        AND attempt."id" = affected."attemptId"
      RETURNING
        attempt."admittedAssistantLeafMessageId", attempt."chatId",
        attempt."modelRunId", attempt."userId", attempt."state"
    ), settled_runs AS (
      UPDATE "ModelRun" AS run
      SET
        "errorPayload" = jsonb_build_object(
          'code', 'memory_source_stale',
          'message', 'Memory preparation stopped because selected history was cleared.'
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
      "errorMessage" = 'Memory preparation stopped because selected history was cleared.',
      "status" = 'error'::"MessageStatus",
      "updatedAt" = CURRENT_TIMESTAMP
    FROM settled_attempts AS attempt
    INNER JOIN settled_runs AS run
      ON run."id" = attempt."modelRunId" AND run."userId" = attempt."userId"
    WHERE message."id" = attempt."admittedAssistantLeafMessageId"
      AND message."chatId" = attempt."chatId"
      AND message."status" IN ('queued'::"MessageStatus", 'streaming'::"MessageStatus")
  `);
}

async function receiptSelectionPredicates(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<Readonly<{ history: Prisma.Sql; result: Prisma.Sql; running: Prisma.Sql }>> {
  if (selection.kind === "SOURCE") {
    return {
      history: Prisma.sql`TRUE`,
      result: Prisma.sql`result ->> 'sourceChatId' = ${selection.chatId}`,
      running: Prisma.sql`history."state" = 'RUNNING'::"MemoryHistoryRunState"`
    };
  }
  if (selection.kind === "CLEAR" || selection.kind === "ALL_REUSABLE") {
    const barrier = await tx.memorySourceBarrier.findFirst({
      select: { createdAt: true, sourceCreatedAtCutoff: true },
      where: {
        id: selection.barrierId,
        kind: selection.kind === "ALL_REUSABLE" ? "ALL_REUSABLE" : "HISTORY_INDEX",
        userId
      }
    });
    if (!barrier) {
      throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
    }
    return {
      history: Prisma.sql`history."createdAt" <= ${barrier.createdAt}`,
      result: Prisma.sql`TRUE`,
      running: Prisma.sql`FALSE`
    };
  }
  const activeSuppression = Prisma.sql`
    suppression."userId" = ${userId}
    AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
  `;
  return {
    history: Prisma.sql`TRUE`,
    result: Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "MemorySuppression" AS suppression
        WHERE ${activeSuppression}
          AND (
            suppression."scope" = 'ALL'::"MemorySuppressionScope"
            OR (
              suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
              AND suppression."sourceChatId" = result ->> 'sourceChatId'
              AND result -> 'sourceMessageIds' ? suppression."sourceMessageId"
            )
          )
      )
    `,
    running: Prisma.sql`history."state" = 'RUNNING'::"MemoryHistoryRunState"`
  };
}

async function historyReceiptDerivativeCounts(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<Readonly<{ historyRuns: number }>> {
  const predicates = await receiptSelectionPredicates(tx, userId, selection);
  const historyRows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT history."id")::integer AS "count"
    FROM "MemoryHistoryRun" AS history
    LEFT JOIN LATERAL jsonb_array_elements(
      COALESCE(history."results" -> 'results', '[]'::jsonb)
    ) AS result ON TRUE
    WHERE history."userId" = ${userId}
      AND history."retentionState" = 'RETAINED'::"MemoryReceiptRetentionState"
      AND (
        (${predicates.running})
        OR ((${predicates.history}) AND (${predicates.result}))
      )
  `);
  const historyRuns = historyRows[0]?.count ?? -1;
  if (!Number.isSafeInteger(historyRuns) || historyRuns < 0) {
    throw new MemoryCoordinatorError("memory_purge_incomplete", true);
  }
  return { historyRuns };
}

export async function purgeMemoryHistoryReceiptDerivatives(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<void> {
  const predicates = await receiptSelectionPredicates(tx, userId, selection);
  await tx.$executeRaw(Prisma.sql`
    WITH affected AS MATERIALIZED (
      SELECT DISTINCT history."id", history."modelRunToolCallId"
      FROM "MemoryHistoryRun" AS history
      LEFT JOIN LATERAL jsonb_array_elements(
        COALESCE(history."results" -> 'results', '[]'::jsonb)
      ) AS result ON TRUE
      WHERE history."userId" = ${userId}
        AND history."retentionState" = 'RETAINED'::"MemoryReceiptRetentionState"
        AND (
          (${predicates.running})
          OR ((${predicates.history}) AND (${predicates.result}))
        )
    ), scrubbed_history AS (
      UPDATE "MemoryHistoryRun" AS history
      SET
        "query" = NULL,
        "privateRequest" = '{}'::jsonb,
        "results" = NULL,
        "providerResult" = NULL,
        "resultHash" = NULL,
        "state" = CASE
          WHEN history."state" = 'RUNNING'::"MemoryHistoryRunState"
            THEN 'CANCELLED'::"MemoryHistoryRunState"
          ELSE history."state"
        END,
        "outcome" = CASE
          WHEN history."state" = 'RUNNING'::"MemoryHistoryRunState"
            THEN 'FAILED'::"MemoryHistoryRunOutcome"
          ELSE history."outcome"
        END,
        "completedAt" = CASE
          WHEN history."state" = 'RUNNING'::"MemoryHistoryRunState"
            THEN COALESCE(history."completedAt", CURRENT_TIMESTAMP)
          ELSE history."completedAt"
        END,
        "durationMs" = CASE
          WHEN history."state" = 'RUNNING'::"MemoryHistoryRunState"
            THEN COALESCE(history."durationMs", 0)
          ELSE history."durationMs"
        END,
        "errorCode" = CASE
          WHEN history."state" = 'RUNNING'::"MemoryHistoryRunState"
            THEN 'memory_history_receipt_scrubbed'
          ELSE history."errorCode"
        END,
        "retentionState" = 'SCRUBBED'::"MemoryReceiptRetentionState",
        "plaintextPurgedAt" = COALESCE(history."plaintextPurgedAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP
      FROM affected
      WHERE history."id" = affected."id"
      RETURNING history."modelRunToolCallId"
    )
    UPDATE "ModelRunToolCall" AS call
    SET
      "arguments" = '{}'::jsonb,
      "state" = 'error'::"ModelRunToolCallState",
      "completedAt" = COALESCE(call."completedAt", CURRENT_TIMESTAMP),
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
        'status', 'error'
      ),
      "updatedAt" = CURRENT_TIMESTAMP
    FROM scrubbed_history
    WHERE call."id" = scrubbed_history."modelRunToolCallId"
  `);
}

export async function purgeMemoryHistorySelection(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<void> {
  const initialTargetIds = await targetIds(tx, userId, selection);
  if (selection.kind === "CLEAR" || selection.kind === "ALL_REUSABLE") {
    await purgeMemoryFeedbackHistoryClear(
      tx,
      userId,
      initialTargetIds,
      selection.kind === "ALL_REUSABLE" ? "all_reusable_delete" : "history_clear"
    );
  } else if (selection.kind === "SOURCE") {
    await purgeMemoryFeedbackInvalidSource(
      tx,
      userId,
      selection.chatId,
      initialTargetIds
    );
  } else {
    await purgeMemoryFeedbackHistoryClear(
      tx,
      userId,
      initialTargetIds,
      "suppressed_source"
    );
  }
  await purgeMemoryHistoryReceiptDerivatives(tx, userId, selection);
  while (true) {
    const ids = await targetIds(tx, userId, selection);
    if (ids.candidateIds.length === 0 && ids.chunkIds.length === 0 &&
      ids.digestIds.length === 0) break;
    await settleAttemptItems(tx, userId, ids);
    await tx.memorySearchEntry.deleteMany({
      where: { recallChunkId: { in: [...ids.chunkIds] }, userId }
    });
    if (ids.digestIds.length > 0) {
      await tx.chatMemoryDigestChunk.deleteMany({
        where: { digestId: { in: [...ids.digestIds] }, userId }
      });
      await tx.chatMemoryDigestMessage.deleteMany({
        where: { digestId: { in: [...ids.digestIds] }, userId }
      });
      await tx.chatMemoryDigest.deleteMany({
        where: { id: { in: [...ids.digestIds] }, userId }
      });
    }
    if (ids.chunkIds.length > 0) {
      await tx.memoryRecallChunkMessage.deleteMany({
        where: { chunkId: { in: [...ids.chunkIds] }, userId }
      });
      await tx.memoryRecallChunk.deleteMany({
        where: { id: { in: [...ids.chunkIds] }, userId }
      });
    }
    if (ids.candidateIds.length > 0) {
      await tx.memoryCandidateMessage.deleteMany({
        where: { candidateId: { in: [...ids.candidateIds] }, userId }
      });
      await tx.memoryCandidate.deleteMany({
        where: { id: { in: [...ids.candidateIds] }, userId }
      });
    }
    if (selection.kind !== "SUPPRESSED") break;
  }
}

export async function inspectMemoryHistoryPurge(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<MemoryHistoryPurgeProgress> {
  const ids = await targetIds(tx, userId, selection);
  const receiptDerivatives = await historyReceiptDerivativeCounts(tx, userId, selection);
  const feedbackCount = selection.kind === "CLEAR" || selection.kind === "ALL_REUSABLE"
    ? await inspectMemoryFeedbackHistoryClear(tx, userId, ids)
    : selection.kind === "SOURCE"
      ? await inspectMemoryFeedbackInvalidSource(tx, userId, selection.chatId, ids)
      : await inspectMemoryFeedbackHistoryClear(tx, userId, ids);
  const historyItemCount = ids.candidateIds.length + ids.chunkIds.length +
    ids.digestIds.length;
  let referenceCount = 0;
  let searchCount = 0;
  if (historyItemCount > 0) {
    [referenceCount, searchCount] = await Promise.all([
      tx.memoryRetrievalAttemptItem.count({
        where: { recallChunkId: { in: [...ids.chunkIds] }, userId }
      }),
      tx.memorySearchEntry.count({
        where: { recallChunkId: { in: [...ids.chunkIds] }, userId }
      })
    ]);
  }
  const completedUnits = Number(historyItemCount === 0) +
    Number(referenceCount === 0) +
    Number(searchCount === 0) +
    Number(receiptDerivatives.historyRuns === 0) +
    Number(feedbackCount === 0);
  return { complete: completedUnits === 5, completedUnits, totalUnits: 5 };
}

function handler(operation: "BULK_CLEAR" | "SOURCE_PURGE"): MemoryDeletionHandler {
  return Object.freeze({
    async execute(claim) {
      const selection = parseHistoryDeletionTarget(claim);
      if (!selection || claim.operation !== operation) {
        throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
      }
      return {
        apply: async (tx) => {
          await purgeMemoryHistorySelection(tx, claim.userId, selection);
          const progress = await inspectMemoryHistoryPurge(tx, claim.userId, selection);
          if (!progress.complete) {
            throw new MemoryCoordinatorError("memory_purge_incomplete", true);
          }
        }
      };
    },
    operation
  });
}

export const memoryHistoryClearDeletionHandler = handler("BULK_CLEAR");
export const memoryHistorySourceDeletionHandler = handler("SOURCE_PURGE");

export async function auditMemoryHistoryClearDeletion(
  deletionId: string,
  userId: string,
  client: PrismaClient = prisma,
  now = new Date()
): Promise<Readonly<{
  completedUnits: number;
  lastAuditAt: Date | null;
  memoryGeneration: number;
  state: "BLOCKED_REQUIRES_ADMIN" | "PENDING" | "RETRY_WAIT" | "RUNNING" | "SUCCEEDED";
  totalUnits: number;
  updatedAt: Date;
}> | null> {
  return client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{
      id: string;
      lastAuditAt: Date | null;
      memoryGeneration: number;
      state: "BLOCKED_REQUIRES_ADMIN" | "PENDING" | "RETRY_WAIT" | "RUNNING" | "SUCCEEDED";
      targetId: string;
      targetType: string;
      updatedAt: Date;
    }>>(Prisma.sql`
      SELECT "id", "lastAuditAt", "memoryGeneration", "state"::text AS "state",
        "targetId", "targetType", "updatedAt"
      FROM "MemoryDeletionOutbox"
      WHERE "id" = ${deletionId} AND "userId" = ${userId}
        AND "operation" = 'BULK_CLEAR'::"MemoryDeletionOperation"
      FOR UPDATE
    `);
    const row = locked[0];
    if (!row || row.targetType !== MEMORY_HISTORY_CLEAR_TARGET_TYPE) return null;
    const progress = await inspectMemoryHistoryPurge(tx, userId, {
      barrierId: row.targetId,
      kind: "CLEAR"
    });
    let state = row.state;
    let updatedAt = row.updatedAt;
    let lastAuditAt = row.lastAuditAt;
    if (state === "SUCCEEDED" && !progress.complete) {
      const reopened = await tx.memoryDeletionOutbox.update({
        data: {
          completedAt: null,
          errorCode: "memory_purge_incomplete",
          lastAuditAt: now,
          nextAttemptAt: null,
          state: "PENDING",
          updatedAt: now
        },
        where: { id: row.id }
      });
      state = "PENDING";
      updatedAt = reopened.updatedAt;
      lastAuditAt = reopened.lastAuditAt;
    } else {
      const audited = await tx.memoryDeletionOutbox.update({
        data: { lastAuditAt: now, updatedAt: now },
        where: { id: row.id }
      });
      updatedAt = audited.updatedAt;
      lastAuditAt = audited.lastAuditAt;
    }
    return {
      completedUnits: progress.completedUnits,
      lastAuditAt,
      memoryGeneration: row.memoryGeneration,
      state,
      totalUnits: progress.totalUnits,
      updatedAt
    };
  });
}

export const suppressedMemoryHistoryPurgeSelection = Object.freeze({
  kind: "SUPPRESSED" as const
});

export function allReusableMemoryHistoryPurgeSelection(
  barrierId: string
): HistoryPurgeSelection {
  if (!validId(barrierId)) {
    throw new Error("memory_history_all_reusable_barrier_invalid");
  }
  return Object.freeze({ barrierId, kind: "ALL_REUSABLE" as const });
}

export async function reconcileCompletedMemoryHistorySourceDeletionAudits(
  client: PrismaClient = prisma,
  options: Readonly<{ limit?: number; now?: Date }> = {}
): Promise<Readonly<{ checked: number; reopened: number }>> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("memory_history_source_audit_limit_invalid");
  }
  const now = options.now ?? new Date();
  const rows = await client.memoryDeletionOutbox.findMany({
    orderBy: [{ lastAuditAt: "asc" }, { id: "asc" }],
    select: { id: true, targetId: true, userId: true },
    take: limit,
    where: {
      OR: [{ lastAuditAt: null }, { lastAuditAt: { lt: now } }],
      operation: "SOURCE_PURGE",
      state: "SUCCEEDED",
      targetType: MEMORY_HISTORY_SOURCE_TARGET_TYPE
    }
  });
  let reopened = 0;
  for (const row of rows) {
    const wasReopened = await client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ state: string }>>(Prisma.sql`
        SELECT "state"::text AS "state"
        FROM "MemoryDeletionOutbox"
        WHERE "id" = ${row.id} AND "userId" = ${row.userId}
        FOR UPDATE
      `);
      if (locked[0]?.state !== "SUCCEEDED") return false;
      const progress = await inspectMemoryHistoryPurge(tx, row.userId, {
        chatId: row.targetId,
        kind: "SOURCE"
      });
      await tx.memoryDeletionOutbox.update({
        data: progress.complete
          ? { lastAuditAt: now, updatedAt: now }
          : {
              completedAt: null,
              errorCode: "memory_purge_incomplete",
              lastAuditAt: now,
              leaseExpiresAt: null,
              leaseToken: null,
              nextAttemptAt: null,
              state: "PENDING",
              updatedAt: now
            },
        where: { id: row.id }
      });
      return !progress.complete;
    });
    if (wasReopened) reopened += 1;
  }
  return { checked: rows.length, reopened };
}
