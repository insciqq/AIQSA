import { Prisma } from "@prisma/client";
import type { MemoryPurgeTarget } from "./contract";
import type {
  MemoryDeletionContributor,
  MemoryDeletionContributorRegistry
} from "./registry";
import {
  allReusableMemoryHistoryPurgeSelection,
  inspectMemoryHistoryPurge,
  purgeMemoryHistorySelection,
  suppressedMemoryHistoryPurgeSelection
} from "../history/purge";
import { memoryPurgeVersionCondition } from "./selection";
import {
  allReusableIndexesContributor,
  allReusableLedgerContributor,
  allReusableWorkContributor
} from "./allReusable";

function countFrom(rows: readonly Readonly<{ count: number }>[]): number {
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_purge_count_invalid");
  }
  return count;
}

function candidateTargetCondition(target: MemoryPurgeTarget): Prisma.Sql {
  if (target.kind === "ALL_REUSABLE") {
    return Prisma.sql`
      candidate."userId" = ${target.userId}
      AND (
        candidate."createdAt" <= (
          SELECT barrier."createdAt"
          FROM "MemorySourceBarrier" AS barrier
          WHERE barrier."userId" = ${target.userId}
            AND barrier."id" = ${target.targetId}
            AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryCandidateMessage" AS candidate_message
          INNER JOIN "Message" AS source_message
            ON source_message."chatId" = candidate_message."chatId"
            AND source_message."id" = candidate_message."messageId"
          WHERE candidate_message."userId" = candidate."userId"
            AND candidate_message."candidateId" = candidate."id"
            AND source_message."createdAt" <= (
              SELECT barrier."sourceCreatedAtCutoff"
              FROM "MemorySourceBarrier" AS barrier
              WHERE barrier."userId" = ${target.userId}
                AND barrier."id" = ${target.targetId}
                AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryJob" AS job
          WHERE job."userId" = candidate."userId"
            AND job."id" = candidate."jobId"
            AND job."memoryGenerationSnapshot" < (
              SELECT barrier."memoryGeneration"
              FROM "MemorySourceBarrier" AS barrier
              WHERE barrier."userId" = ${target.userId}
                AND barrier."id" = ${target.targetId}
                AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
            )
        )
      )
    `;
  }
  if (target.kind === "AUTOMATIC_SET") {
    return Prisma.sql`
      candidate."userId" = ${target.userId}
      AND candidate."createdAt" <= (
        SELECT barrier."createdAt"
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = ${target.userId}
          AND barrier."id" = ${target.targetId}
          AND barrier."kind" = 'AUTOMATIC_FACTS'::"MemorySourceBarrierKind"
      )
    `;
  }
  const factTarget = target.kind === "MEMORY_FACT"
    ? Prisma.sql`
        candidate."resolvedFactId" = ${target.targetId}
        OR candidate."proposedCanonicalKey" = (
          SELECT fact."canonicalKey"
          FROM "MemoryFact" AS fact
          WHERE fact."userId" = ${target.userId} AND fact."id" = ${target.targetId}
        )
      `
    : Prisma.sql`
        EXISTS (
          SELECT 1
          FROM "MemoryFact" AS fact
          WHERE fact."userId" = candidate."userId"
            AND (
              candidate."resolvedFactId" = fact."id"
              OR candidate."proposedCanonicalKey" = fact."canonicalKey"
            )
            AND EXISTS (
              SELECT 1
              FROM "MemoryFactVersion" AS explicit_version
              WHERE explicit_version."userId" = fact."userId"
                AND explicit_version."factId" = fact."id"
                AND explicit_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
                AND explicit_version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
            )
        )
      `;
  return Prisma.sql`
    candidate."userId" = ${target.userId}
    AND (
      (${factTarget})
      OR EXISTS (
        SELECT 1
        FROM "MemorySuppression" AS suppression
        LEFT JOIN "MemoryCandidateMessage" AS source_message
          ON source_message."userId" = candidate."userId"
          AND source_message."candidateId" = candidate."id"
        WHERE suppression."userId" = candidate."userId"
          AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > CURRENT_TIMESTAMP)
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
      )
    )
  `;
}

function feedbackTargetCondition(target: MemoryPurgeTarget): Prisma.Sql {
  if (target.kind === "MEMORY_FACT") {
    return Prisma.sql`feedback."memoryFactId" = ${target.targetId}`;
  }
  if (target.kind === "AUTOMATIC_SET") {
    return Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "MemoryFactVersion" AS version
        WHERE version."userId" = feedback."userId"
          AND version."id" = feedback."memoryFactVersionId"
          AND ${memoryPurgeVersionCondition(target)}
      )
    `;
  }
  if (target.kind === "ALL_REUSABLE") {
    return Prisma.sql`
      (
        feedback."createdAt" <= (
          SELECT barrier."createdAt"
          FROM "MemorySourceBarrier" AS barrier
          WHERE barrier."userId" = ${target.userId}
            AND barrier."id" = ${target.targetId}
            AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryFactVersion" AS version
          WHERE version."userId" = feedback."userId"
            AND version."id" = feedback."memoryFactVersionId"
            AND ${memoryPurgeVersionCondition(target)}
        )
      )
    `;
  }
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "MemoryFactVersion" AS explicit_version
      WHERE explicit_version."userId" = feedback."userId"
        AND explicit_version."factId" = feedback."memoryFactId"
        AND explicit_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND explicit_version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    )
  `;
}

const candidateDerivativesContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT candidate."id")::integer AS "count"
      FROM "MemoryCandidate" AS candidate
      WHERE ${candidateTargetCondition(target)}
        AND (
          candidate."contentPurgedAt" IS NULL
          OR num_nonnulls(
            candidate."proposedCanonicalKey", candidate."proposedDisplayText",
            candidate."proposedValue", candidate."proposedCategory",
            candidate."proposedModality", candidate."proposedScope",
            candidate."proposedValidFrom", candidate."proposedValidTo",
            candidate."rawTemporalExpression", candidate."sourceTimezone",
            candidate."temporalResolverVersion",
            candidate."temporalResolutionEvidence",
            candidate."proposedDirectness", candidate."proposedSensitivity",
            candidate."languageCode", candidate."importance",
            candidate."confidence", candidate."negated"
          ) > 0
          OR EXISTS (
            SELECT 1 FROM "MemoryCandidateMessage" AS source_message
            WHERE source_message."userId" = candidate."userId"
              AND source_message."candidateId" = candidate."id"
          )
          OR EXISTS (
            SELECT 1 FROM "MemoryCandidateDecision" AS decision
            WHERE decision."userId" = candidate."userId"
              AND decision."candidateId" = candidate."id"
              AND decision."state" =
                'PENDING_VERIFICATION'::"MemoryCandidateDecisionState"
          )
        )
    `);
    return countFrom(rows);
  },
  id: "candidate-derivatives",
  async purge(tx, target) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT candidate."id"
      FROM "MemoryCandidate" AS candidate
      WHERE ${candidateTargetCondition(target)}
      ORDER BY candidate."id"
    `);
    const ids = rows.map(({ id }) => id);
    if (ids.length === 0) return;
    if (target.kind === "ALL_REUSABLE") {
      await tx.memoryCandidateMessage.deleteMany({
        where: { candidateId: { in: ids }, userId: target.userId }
      });
      await tx.memoryCandidate.deleteMany({
        where: { id: { in: ids }, userId: target.userId }
      });
      return;
    }
    await tx.memoryCandidateDecision.updateMany({
      data: { resolvedAt: new Date(), state: "STALE" },
      where: {
        candidateId: { in: ids },
        state: "PENDING_VERIFICATION",
        userId: target.userId
      }
    });
    await tx.memoryCandidate.updateMany({
      data: {
        confidence: null,
        contentPurgedAt: new Date(),
        importance: null,
        languageCode: null,
        negated: null,
        proposedCanonicalKey: null,
        proposedCategory: null,
        proposedCoreEligible: null,
        proposedCoreSalience: null,
        proposedDirectness: null,
        proposedDisplayText: null,
        proposedModality: null,
        proposedScope: Prisma.DbNull,
        proposedSensitivity: null,
        proposedValidFrom: null,
        proposedValidTo: null,
        proposedValue: Prisma.DbNull,
        rawTemporalExpression: null,
        reasonCode: target.kind === "AUTOMATIC_SET"
          ? "learned_delete"
          : "forgotten_or_suppressed",
        resolvedFactId: null,
        resolvedAt: new Date(),
        sourceTimezone: null,
        state: "STALE",
        temporalResolutionEvidence: Prisma.DbNull,
        temporalResolverVersion: null
      },
      where: { id: { in: ids }, userId: target.userId }
    });
    await tx.memoryCandidateMessage.deleteMany({
      where: { candidateId: { in: ids }, userId: target.userId }
    });
  },
  version: "v1"
});

function allReusableAttemptCondition(target: MemoryPurgeTarget): Prisma.Sql {
  return Prisma.sql`
    attempt."userId" = ${target.userId}
    AND attempt."state" <> 'CONSUMED'::"MemoryRetrievalAttemptState"
    AND (
      attempt."createdAt" <= (
        SELECT barrier."createdAt"
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = ${target.userId}
          AND barrier."id" = ${target.targetId}
          AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
      )
      OR attempt."memoryGenerationSnapshot" < (
        SELECT barrier."memoryGeneration"
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = ${target.userId}
          AND barrier."id" = ${target.targetId}
          AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
      )
    )
  `;
}

const unacceptedAttemptsContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    if (target.kind === "ALL_REUSABLE") {
      const [attemptRows, itemRows] = await Promise.all([
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryRetrievalAttempt" AS attempt
          WHERE ${allReusableAttemptCondition(target)}
        `),
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemoryRetrievalAttemptItem" AS item
          INNER JOIN "MemoryFactVersion" AS version
            ON version."userId" = item."userId" AND version."id" = item."factVersionId"
          WHERE ${memoryPurgeVersionCondition(target)}
        `)
      ]);
      return countFrom(attemptRows) + countFrom(itemRows);
    }
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryRetrievalAttemptItem" AS item
      INNER JOIN "MemoryRetrievalAttempt" AS attempt
        ON attempt."userId" = item."userId" AND attempt."id" = item."attemptId"
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = item."userId" AND version."id" = item."factVersionId"
      WHERE attempt."state" <> 'CONSUMED'::"MemoryRetrievalAttemptState"
        AND ${memoryPurgeVersionCondition(target)}
    `);
    return countFrom(rows);
  },
  id: "unaccepted-attempts",
  async purge(tx, target) {
    if (target.kind === "ALL_REUSABLE") {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "MemoryRetrievalAttemptItem" AS item
        USING "MemoryFactVersion" AS version
        WHERE version."userId" = item."userId"
          AND version."id" = item."factVersionId"
          AND ${memoryPurgeVersionCondition(target)}
      `);
      await tx.$executeRaw(Prisma.sql`
        WITH selected AS MATERIALIZED (
          SELECT
            attempt."admittedAssistantLeafMessageId",
            attempt."boundedPrivateBaseRequestSnapshot",
            attempt."chatId",
            attempt."id",
            attempt."modelRunId",
            attempt."userId"
          FROM "MemoryRetrievalAttempt" AS attempt
          WHERE ${allReusableAttemptCondition(target)}
        ), settled_runs AS (
          UPDATE "ModelRun" AS run
          SET
            "errorPayload" = jsonb_build_object(
              'code', 'memory_all_reusable_deleted',
              'message', 'Memory preparation stopped because reusable Memory was deleted.'
            ),
            "normalizedRequest" = COALESCE(
              run."normalizedRequest",
              selected."boundedPrivateBaseRequestSnapshot" -> 'normalizedRequest',
              '{}'::jsonb
            ),
            "status" = 'error'::"ModelRunStatus",
            "updatedAt" = CURRENT_TIMESTAMP
          FROM selected
          WHERE run."id" = selected."modelRunId"
            AND run."userId" = selected."userId"
            AND run."status" = 'preparing'::"ModelRunStatus"
          RETURNING run."id", run."userId"
        )
        UPDATE "Message" AS message
        SET
          "errorMessage" = 'Memory preparation stopped because reusable Memory was deleted.',
          "status" = 'error'::"MessageStatus",
          "updatedAt" = CURRENT_TIMESTAMP
        FROM selected
        INNER JOIN settled_runs AS run
          ON run."id" = selected."modelRunId" AND run."userId" = selected."userId"
        WHERE message."id" = selected."admittedAssistantLeafMessageId"
          AND message."chatId" = selected."chatId"
          AND message."status" IN ('queued'::"MessageStatus", 'streaming'::"MessageStatus")
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "UsageEvent" AS usage
        SET "memoryExecutionBindingId" = NULL
        FROM "MemoryExecutionBinding" AS binding
        INNER JOIN "MemoryRetrievalAttempt" AS attempt
          ON attempt."userId" = binding."userId"
          AND attempt."id" = binding."retrievalAttemptId"
        WHERE usage."userId" = binding."userId"
          AND usage."memoryExecutionBindingId" = binding."id"
          AND ${allReusableAttemptCondition(target)}
      `);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "MemoryRetrievalAttempt" AS attempt
        WHERE ${allReusableAttemptCondition(target)}
      `);
      return;
    }
    await tx.$executeRaw(Prisma.sql`
      WITH deleted AS (
        DELETE FROM "MemoryRetrievalAttemptItem" AS item
        USING "MemoryRetrievalAttempt" AS attempt, "MemoryFactVersion" AS version
        WHERE attempt."userId" = item."userId"
          AND attempt."id" = item."attemptId"
          AND attempt."state" <> 'CONSUMED'::"MemoryRetrievalAttemptState"
          AND version."userId" = item."userId"
          AND version."id" = item."factVersionId"
          AND ${memoryPurgeVersionCondition(target)}
        RETURNING item."userId", item."attemptId"
      ), affected AS (
        SELECT DISTINCT
          deleted."userId",
          deleted."attemptId",
          attempt."state" IN (
            'PENDING'::"MemoryRetrievalAttemptState",
            'EXECUTING'::"MemoryRetrievalAttemptState",
            'READY'::"MemoryRetrievalAttemptState"
          ) AS "wasNonterminal"
        FROM deleted
        INNER JOIN "MemoryRetrievalAttempt" AS attempt
          ON attempt."userId" = deleted."userId"
          AND attempt."id" = deleted."attemptId"
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
            ) THEN 'memory_item_forgotten'
            ELSE attempt."errorCode"
          END,
          "updatedAt" = CURRENT_TIMESTAMP
        FROM affected
        WHERE attempt."userId" = affected."userId"
          AND attempt."id" = affected."attemptId"
        RETURNING
          attempt."admittedAssistantLeafMessageId",
          attempt."boundedPrivateBaseRequestSnapshot",
          attempt."chatId",
          attempt."modelRunId",
          attempt."userId",
          affected."wasNonterminal"
      ), settled_runs AS (
        UPDATE "ModelRun" AS run
        SET
          "errorPayload" = jsonb_build_object(
            'code', 'memory_item_forgotten',
            'message', 'Memory preparation stopped because a selected Memory item was forgotten.'
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
          AND attempt."wasNonterminal"
        RETURNING run."id", run."userId"
      )
      UPDATE "Message" AS message
      SET
        "errorMessage" =
          'Memory preparation stopped because a selected Memory item was forgotten.',
        "status" = 'error'::"MessageStatus",
        "updatedAt" = CURRENT_TIMESTAMP
      FROM settled_attempts AS attempt
      INNER JOIN settled_runs AS run
        ON run."id" = attempt."modelRunId" AND run."userId" = attempt."userId"
      WHERE message."id" = attempt."admittedAssistantLeafMessageId"
        AND message."chatId" = attempt."chatId"
        AND message."status" IN (
          'queued'::"MessageStatus",
          'streaming'::"MessageStatus"
        )
    `);
  },
  version: "v1"
});

const evidenceContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryEvidence" AS evidence
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = evidence."userId"
        AND version."id" = evidence."factVersionId"
      WHERE ${memoryPurgeVersionCondition(target)}
    `);
    return countFrom(rows);
  },
  id: "fact-evidence",
  async purge(tx, target) {
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemoryEvidence" AS evidence
      USING "MemoryFactVersion" AS version
      WHERE version."userId" = evidence."userId"
        AND version."id" = evidence."factVersionId"
        AND ${memoryPurgeVersionCondition(target)}
    `);
  },
  version: "v1"
});

const feedbackContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryFeedback" AS feedback
      WHERE feedback."userId" = ${target.userId}
        AND feedback."contentPurgedAt" IS NULL
        AND ${feedbackTargetCondition(target)}
    `);
    return countFrom(rows);
  },
  id: "feedback-records",
  async purge(tx, target) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MemoryFeedback" AS feedback
      SET
        "memoryFactId" = NULL,
        "memoryFactVersionId" = NULL,
        "recallChunkId" = NULL,
        "modelRunId" = NULL,
        "modelRunMemoryItemId" = NULL,
        "modelRunToolCallId" = NULL,
        "sourceChatIdSnapshot" = NULL,
        "sourceBranchGenerationSnapshot" = NULL,
        "comment" = NULL,
        "retractsFeedbackId" = NULL,
        "memoryEventId" = NULL,
        "contentPurgedAt" = CURRENT_TIMESTAMP,
        "purgeReason" = ${target.kind === "MEMORY_FACT"
          ? "fact_forgotten"
          : target.kind === "AUTOMATIC_SET"
            ? "learned_delete"
            : target.kind === "ALL_REUSABLE"
              ? "all_reusable_delete"
              : "explicit_delete"}
      WHERE feedback."userId" = ${target.userId}
        AND feedback."contentPurgedAt" IS NULL
        AND ${feedbackTargetCondition(target)}
    `);
  },
  version: "v1"
});

const historyDerivativesContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    if (target.kind === "AUTOMATIC_SET") return 0;
    const progress = await inspectMemoryHistoryPurge(
      tx,
      target.userId,
      target.kind === "ALL_REUSABLE"
        ? allReusableMemoryHistoryPurgeSelection(target.targetId)
        : suppressedMemoryHistoryPurgeSelection
    );
    return progress.totalUnits - progress.completedUnits;
  },
  id: "history-derivatives",
  async purge(tx, target) {
    if (target.kind === "AUTOMATIC_SET") return;
    await purgeMemoryHistorySelection(
      tx,
      target.userId,
      target.kind === "ALL_REUSABLE"
        ? allReusableMemoryHistoryPurgeSelection(target.targetId)
        : suppressedMemoryHistoryPurgeSelection
    );
  },
  version: "v1"
});

const searchContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemorySearchEntry" AS search
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = search."userId"
        AND version."id" = search."factVersionId"
      WHERE ${memoryPurgeVersionCondition(target)}
    `);
    return countFrom(rows);
  },
  id: "fact-search",
  async purge(tx, target) {
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemorySearchEntry" AS search
      USING "MemoryFactVersion" AS version
      WHERE version."userId" = search."userId"
        AND version."id" = search."factVersionId"
        AND ${memoryPurgeVersionCondition(target)}
    `);
  },
  version: "v1"
});

function eventTargetCondition(target: MemoryPurgeTarget): Prisma.Sql {
  if (target.kind === "ALL_REUSABLE") {
    return Prisma.sql`
      event."userId" = ${target.userId}
      AND (
        event."createdAt" <= (
          SELECT barrier."createdAt"
          FROM "MemorySourceBarrier" AS barrier
          WHERE barrier."userId" = ${target.userId}
            AND barrier."id" = ${target.targetId}
            AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryFactVersion" AS version
          WHERE version."userId" = event."userId"
            AND version."id" = event."factVersionId"
            AND ${memoryPurgeVersionCondition(target)}
        )
      )
    `;
  }
  return Prisma.sql`
    event."userId" = ${target.userId}
    AND EXISTS (
      SELECT 1
      FROM "MemoryFactVersion" AS version
      WHERE version."userId" = event."userId"
        AND version."id" = event."factVersionId"
        AND ${memoryPurgeVersionCondition(target)}
    )
  `;
}

const versionContentContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryFactVersion" AS version
      WHERE ${memoryPurgeVersionCondition(target)}
        AND num_nonnulls(
          version."displayText",
          version."normalizedSearchText",
          version."structuredValue",
          version."rawTemporalExpression",
          version."temporalResolutionEvidence"
        ) > 0
    `);
    const versionCount = countFrom(rows);
    if (target.kind !== "AUTOMATIC_SET" && target.kind !== "ALL_REUSABLE") {
      return versionCount;
    }
    const eventRows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryEvent" AS event
      WHERE ${eventTargetCondition(target)}
        AND (
          event."sourceChatId" IS NOT NULL
          OR event."sourceGeneration" IS NOT NULL
          OR event."metadata" <> '{"schemaVersion":"memory-event-purged-v1"}'::jsonb
        )
    `);
    return versionCount + countFrom(eventRows);
  },
  id: "fact-version-content",
  async purge(tx, target) {
    if (target.kind === "AUTOMATIC_SET" || target.kind === "ALL_REUSABLE") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MemoryEvent" AS event
        SET
          "sourceChatId" = NULL,
          "sourceGeneration" = NULL,
          "metadata" = '{"schemaVersion":"memory-event-purged-v1"}'::jsonb
        WHERE ${eventTargetCondition(target)}
      `);
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MemoryFactVersion" AS version
      SET
        "displayText" = NULL,
        "normalizedSearchText" = NULL,
        "structuredValue" = NULL,
        "rawTemporalExpression" = NULL,
        "temporalResolutionEvidence" = NULL,
        "contentPurgedAt" = COALESCE(version."contentPurgedAt", CURRENT_TIMESTAMP)
      WHERE ${memoryPurgeVersionCondition(target)}
        AND num_nonnulls(
          version."displayText",
          version."normalizedSearchText",
          version."structuredValue",
          version."rawTemporalExpression",
          version."temporalResolutionEvidence"
        ) > 0
    `);
  },
  version: "v1"
});

export const memoryDeletionContributors = Object.freeze([
  unacceptedAttemptsContributor,
  historyDerivativesContributor,
  candidateDerivativesContributor,
  feedbackContributor,
  searchContributor,
  versionContentContributor,
  allReusableLedgerContributor,
  evidenceContributor,
  allReusableWorkContributor,
  allReusableIndexesContributor
]);

export function registerMemoryDeletionContributors(
  registry: MemoryDeletionContributorRegistry
): readonly (() => void)[] {
  return Object.freeze(memoryDeletionContributors.map((contributor) =>
    registry.register(contributor)));
}
