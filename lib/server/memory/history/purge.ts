import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryDeletionClaim,
  MemoryDeletionHandler
} from "../coordinator/types";
import type { MemoryTransaction } from "../persistence/transaction";

export const MEMORY_HISTORY_CLEAR_MANIFEST_VERSION =
  "memory-p4-history-clear-v1";
export const MEMORY_HISTORY_SOURCE_PURGE_MANIFEST_VERSION =
  "memory-p4-history-source-v1";
export const MEMORY_HISTORY_CLEAR_TARGET_TYPE =
  `HISTORY_INDEX@${MEMORY_HISTORY_CLEAR_MANIFEST_VERSION}`;
export const MEMORY_HISTORY_SOURCE_TARGET_TYPE =
  `HISTORY_SOURCE@${MEMORY_HISTORY_SOURCE_PURGE_MANIFEST_VERSION}`;

type HistoryPurgeSelection =
  | Readonly<{ barrierId: string; kind: "CLEAR" }>
  | Readonly<{ chatId: string; kind: "SOURCE" }>
  | Readonly<{ kind: "SUPPRESSED" }>;

type HistoryTargetIds = Readonly<{
  chunkIds: readonly string[];
  episodeIds: readonly string[];
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
  if (selection.kind === "CLEAR") {
    const barrier = await tx.memorySourceBarrier.findFirst({
      select: { createdAt: true, sourceCreatedAtCutoff: true },
      where: {
        id: selection.barrierId,
        kind: "HISTORY_INDEX",
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
    const episodes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT episode."id"
      FROM "MemoryEpisode" AS episode
      LEFT JOIN "MemoryEpisodeMessage" AS source_message
        ON source_message."userId" = episode."userId"
        AND source_message."episodeId" = episode."id"
      LEFT JOIN "Message" AS message
        ON message."chatId" = source_message."chatId"
        AND message."id" = source_message."messageId"
      WHERE episode."userId" = ${userId}
        AND (
          episode."createdAt" <= ${barrier.createdAt}
          OR message."createdAt" <= ${barrier.sourceCreatedAtCutoff}
        )
      ORDER BY episode."id"
    `);
    return {
      chunkIds: chunks.map(({ id }) => id),
      episodeIds: episodes.map(({ id }) => id)
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
          OR chat."memoryBranchGeneration" <> chunk."branchGeneration"
          OR chat."memorySourceRevision" <> chunk."sourceRevisionAtCreation"
        )
      ORDER BY chunk."id"
    `);
    const episodes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT episode."id"
      FROM "MemoryEpisode" AS episode
      LEFT JOIN "Chat" AS chat
        ON chat."userId" = episode."userId" AND chat."id" = episode."chatId"
      WHERE episode."userId" = ${userId}
        AND episode."chatId" = ${selection.chatId}
        AND (
          episode."state" <> 'ACTIVE'::"MemoryHistoryItemState"
          OR chat."id" IS NULL
          OR chat."memoryMode" <> 'NORMAL'::"MemoryChatMode"
          OR chat."memoryBranchGeneration" <> episode."branchGeneration"
          OR chat."memorySourceRevision" <> episode."sourceRevisionAtCreation"
        )
      ORDER BY episode."id"
    `);
    return {
      chunkIds: chunks.map(({ id }) => id),
      episodeIds: episodes.map(({ id }) => id)
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
  const episodes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT episode."id"
    FROM "MemoryEpisode" AS episode
    LEFT JOIN "MemoryEpisodeMessage" AS source_message
      ON source_message."userId" = episode."userId"
      AND source_message."episodeId" = episode."id"
    INNER JOIN "MemorySuppression" AS suppression
      ON suppression."userId" = episode."userId"
      AND (
        suppression."scope" = 'ALL'::"MemorySuppressionScope"
        OR (
          suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
          AND suppression."sourceEpisodeId" = episode."id"
        )
        OR (
          suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
          AND suppression."sourceChatId" = source_message."chatId"
          AND suppression."sourceMessageId" = source_message."messageId"
          AND (
            suppression."sourceBranchGeneration" IS NULL
            OR suppression."sourceBranchGeneration" = episode."branchGeneration"
          )
        )
      )
    WHERE episode."userId" = ${userId}
      AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
    ORDER BY episode."id"
  `);
  return {
    chunkIds: chunks.map(({ id }) => id),
    episodeIds: episodes.map(({ id }) => id)
  };
}

function targetPredicate(ids: HistoryTargetIds): Prisma.Sql {
  const predicates: Prisma.Sql[] = [];
  if (ids.chunkIds.length > 0) {
    predicates.push(Prisma.sql`item."recallChunkId" IN (${Prisma.join([...ids.chunkIds])})`);
  }
  if (ids.episodeIds.length > 0) {
    predicates.push(Prisma.sql`item."episodeId" IN (${Prisma.join([...ids.episodeIds])})`);
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
        "preparedContextText" = NULL,
        "preparedContextHash" = NULL,
        "preparedContextTokenCount" = NULL,
        "errorCode" = CASE
          WHEN attempt."state" IN (
            'PENDING'::"MemoryRetrievalAttemptState",
            'EXECUTING'::"MemoryRetrievalAttemptState",
            'READY'::"MemoryRetrievalAttemptState"
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

async function detachEpisodeSuppressions(
  tx: MemoryTransaction,
  userId: string,
  episodeIds: readonly string[],
  selection: HistoryPurgeSelection
): Promise<void> {
  if (episodeIds.length === 0) return;
  const suppressions = await tx.memorySuppression.findMany({
    orderBy: { id: "asc" },
    select: {
      deletionGeneration: true,
      explicitOverrideAllowed: true,
      expiresAt: true,
      fingerprintKeyVersion: true,
      id: true,
      normalizationVersion: true,
      sourceBranchGeneration: true,
      sourceChatId: true,
      sourceEpisodeId: true
    },
    where: {
      scope: "SOURCE_EPISODE",
      sourceEpisodeId: { in: [...episodeIds] },
      userId
    }
  });
  if (suppressions.length === 0) return;

  const sourceStillExists = selection.kind === "SOURCE"
    ? await tx.chat.count({ where: { id: selection.chatId, userId } }) > 0
    : selection.kind === "SUPPRESSED";
  if (sourceStillExists) {
    const joins = await tx.memoryEpisodeMessage.findMany({
      orderBy: [{ episodeId: "asc" }, { ordinal: "asc" }],
      select: { chatId: true, episodeId: true, messageId: true },
      where: { episodeId: { in: [...episodeIds] }, userId }
    });
    const replacementRows = [];
    for (const suppression of suppressions) {
      const sources = joins.filter((join) =>
        join.episodeId === suppression.sourceEpisodeId);
      if (
        !suppression.sourceChatId ||
        suppression.sourceBranchGeneration === null ||
        sources.length === 0 ||
        sources.some((source) => source.chatId !== suppression.sourceChatId)
      ) {
        throw new MemoryCoordinatorError("memory_purge_incomplete", true);
      }
      replacementRows.push(...sources.map((source) => ({
        deletionGeneration: suppression.deletionGeneration,
        explicitOverrideAllowed: suppression.explicitOverrideAllowed,
        expiresAt: suppression.expiresAt,
        fingerprintKeyVersion: suppression.fingerprintKeyVersion,
        id: randomUUID(),
        normalizationVersion: suppression.normalizationVersion,
        scope: "SOURCE_MESSAGE" as const,
        sourceBranchGeneration: suppression.sourceBranchGeneration!,
        sourceChatId: suppression.sourceChatId!,
        sourceMessageId: source.messageId,
        userId
      })));
    }
    if (replacementRows.length > 0) {
      await tx.memorySuppression.createMany({ data: replacementRows });
    }
  }
  await tx.memorySuppression.deleteMany({
    where: { id: { in: suppressions.map(({ id }) => id) }, userId }
  });
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
  if (selection.kind === "CLEAR") {
    const barrier = await tx.memorySourceBarrier.findFirst({
      select: { sourceCreatedAtCutoff: true },
      where: {
        id: selection.barrierId,
        kind: "HISTORY_INDEX",
        userId
      }
    });
    if (!barrier) {
      throw new MemoryCoordinatorError("memory_deletion_target_invalid", true);
    }
    return {
      history: Prisma.sql`history."createdAt" <= ${barrier.sourceCreatedAtCutoff}`,
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
            OR (
              suppression."scope" = 'SOURCE_EPISODE'::"MemorySuppressionScope"
              AND EXISTS (
                SELECT 1
                FROM "MemoryEpisodeMessage" AS episode_message
                WHERE episode_message."userId" = suppression."userId"
                  AND episode_message."episodeId" = suppression."sourceEpisodeId"
                  AND episode_message."chatId" = result ->> 'sourceChatId'
                  AND result -> 'sourceMessageIds' ? episode_message."messageId"
              )
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
  await purgeMemoryHistoryReceiptDerivatives(tx, userId, selection);
  while (true) {
    const ids = await targetIds(tx, userId, selection);
    if (ids.chunkIds.length === 0 && ids.episodeIds.length === 0) return;
    await settleAttemptItems(tx, userId, ids);
    await tx.memorySearchEntry.deleteMany({
      where: {
        OR: [
          ...(ids.chunkIds.length > 0
            ? [{ recallChunkId: { in: [...ids.chunkIds] } }]
            : []),
          ...(ids.episodeIds.length > 0
            ? [{ episodeId: { in: [...ids.episodeIds] } }]
            : [])
        ],
        userId
      }
    });
    if (ids.episodeIds.length > 0) {
      await tx.memoryEvidence.deleteMany({
        where: { episodeId: { in: [...ids.episodeIds] }, userId }
      });
      await detachEpisodeSuppressions(tx, userId, ids.episodeIds, selection);
      await tx.memoryEpisodeMessage.deleteMany({
        where: { episodeId: { in: [...ids.episodeIds] }, userId }
      });
      await tx.memoryEpisode.deleteMany({
        where: { id: { in: [...ids.episodeIds] }, userId }
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
    if (selection.kind !== "SUPPRESSED") return;
  }
}

export async function inspectMemoryHistoryPurge(
  tx: MemoryTransaction,
  userId: string,
  selection: HistoryPurgeSelection
): Promise<MemoryHistoryPurgeProgress> {
  const ids = await targetIds(tx, userId, selection);
  const receiptDerivatives = await historyReceiptDerivativeCounts(tx, userId, selection);
  const itemCount = ids.chunkIds.length + ids.episodeIds.length;
  let referenceCount = 0;
  let searchCount = 0;
  if (itemCount > 0) {
    [referenceCount, searchCount] = await Promise.all([
      tx.memoryRetrievalAttemptItem.count({
        where: {
          OR: [
            ...(ids.chunkIds.length > 0 ? [{ recallChunkId: { in: [...ids.chunkIds] } }] : []),
            ...(ids.episodeIds.length > 0 ? [{ episodeId: { in: [...ids.episodeIds] } }] : [])
          ],
          userId
        }
      }),
      tx.memorySearchEntry.count({
        where: {
          OR: [
            ...(ids.chunkIds.length > 0 ? [{ recallChunkId: { in: [...ids.chunkIds] } }] : []),
            ...(ids.episodeIds.length > 0 ? [{ episodeId: { in: [...ids.episodeIds] } }] : [])
          ],
          userId
        }
      })
    ]);
  }
  const completedUnits = Number(itemCount === 0) +
    Number(referenceCount === 0) +
    Number(searchCount === 0) +
    Number(receiptDerivatives.historyRuns === 0);
  return { complete: completedUnits === 4, completedUnits, totalUnits: 4 };
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
