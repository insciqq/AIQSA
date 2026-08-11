import { Prisma } from "@prisma/client";
import type { MemoryPurgeTarget } from "./contract";
import type {
  MemoryDeletionContributor,
  MemoryDeletionContributorRegistry
} from "./registry";
import {
  inspectMemoryHistoryPurge,
  purgeMemoryHistorySelection,
  suppressedMemoryHistoryPurgeSelection
} from "../history/purge";

function versionTargetCondition(target: MemoryPurgeTarget): Prisma.Sql {
  if (target.kind === "MEMORY_FACT") {
    return Prisma.sql`
      version."userId" = ${target.userId}
      AND version."factId" = ${target.targetId}
      AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    `;
  }
  return Prisma.sql`
    version."userId" = ${target.userId}
    AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    AND EXISTS (
      SELECT 1
      FROM "MemoryFactVersion" AS explicit_marker
      WHERE explicit_marker."userId" = version."userId"
        AND explicit_marker."factId" = version."factId"
        AND explicit_marker."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND explicit_marker."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    )
  `;
}

function countFrom(rows: readonly Readonly<{ count: number }>[]): number {
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_purge_count_invalid");
  }
  return count;
}

function candidateTargetCondition(target: MemoryPurgeTarget): Prisma.Sql {
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
    await tx.memoryCandidate.updateMany({
      data: {
        confidence: null,
        contentPurgedAt: new Date(),
        importance: null,
        languageCode: null,
        negated: null,
        proposedCanonicalKey: null,
        proposedCategory: null,
        proposedDirectness: null,
        proposedDisplayText: null,
        proposedModality: null,
        proposedScope: Prisma.DbNull,
        proposedSensitivity: null,
        proposedValidFrom: null,
        proposedValidTo: null,
        proposedValue: Prisma.DbNull,
        rawTemporalExpression: null,
        reasonCode: "forgotten_or_suppressed",
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

const unacceptedAttemptsContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryRetrievalAttemptItem" AS item
      INNER JOIN "MemoryRetrievalAttempt" AS attempt
        ON attempt."userId" = item."userId" AND attempt."id" = item."attemptId"
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = item."userId" AND version."id" = item."factVersionId"
      WHERE attempt."state" <> 'CONSUMED'::"MemoryRetrievalAttemptState"
        AND ${versionTargetCondition(target)}
    `);
    return countFrom(rows);
  },
  id: "unaccepted-attempts",
  async purge(tx, target) {
    await tx.$executeRaw(Prisma.sql`
      WITH deleted AS (
        DELETE FROM "MemoryRetrievalAttemptItem" AS item
        USING "MemoryRetrievalAttempt" AS attempt, "MemoryFactVersion" AS version
        WHERE attempt."userId" = item."userId"
          AND attempt."id" = item."attemptId"
          AND attempt."state" <> 'CONSUMED'::"MemoryRetrievalAttemptState"
          AND version."userId" = item."userId"
          AND version."id" = item."factVersionId"
          AND ${versionTargetCondition(target)}
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
          "providerRequestPreview" = COALESCE(
            run."providerRequestPreview",
            attempt."boundedPrivateBaseRequestSnapshot" -> 'providerRequestPreview',
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
      WHERE ${versionTargetCondition(target)}
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
        AND ${versionTargetCondition(target)}
    `);
  },
  version: "v1"
});

const historyDerivativesContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const progress = await inspectMemoryHistoryPurge(
      tx,
      target.userId,
      suppressedMemoryHistoryPurgeSelection
    );
    return progress.totalUnits - progress.completedUnits;
  },
  id: "history-derivatives",
  async purge(tx, target) {
    await purgeMemoryHistorySelection(
      tx,
      target.userId,
      suppressedMemoryHistoryPurgeSelection
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
      WHERE ${versionTargetCondition(target)}
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
        AND ${versionTargetCondition(target)}
    `);
  },
  version: "v1"
});

const versionContentContributor: MemoryDeletionContributor = Object.freeze({
  async audit(tx, target) {
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryFactVersion" AS version
      WHERE ${versionTargetCondition(target)}
        AND num_nonnulls(
          version."displayText",
          version."normalizedSearchText",
          version."structuredValue",
          version."rawTemporalExpression",
          version."temporalResolutionEvidence"
        ) > 0
    `);
    return countFrom(rows);
  },
  id: "fact-version-content",
  async purge(tx, target) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MemoryFactVersion" AS version
      SET
        "displayText" = NULL,
        "normalizedSearchText" = NULL,
        "structuredValue" = NULL,
        "rawTemporalExpression" = NULL,
        "temporalResolutionEvidence" = NULL,
        "contentPurgedAt" = COALESCE(version."contentPurgedAt", CURRENT_TIMESTAMP)
      WHERE ${versionTargetCondition(target)}
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

export const phase2MemoryDeletionContributors = Object.freeze([
  unacceptedAttemptsContributor,
  historyDerivativesContributor,
  candidateDerivativesContributor,
  evidenceContributor,
  searchContributor,
  versionContentContributor
]);

export function registerPhase2MemoryDeletionContributors(
  registry: MemoryDeletionContributorRegistry
): readonly (() => void)[] {
  return Object.freeze(phase2MemoryDeletionContributors.map((contributor) =>
    registry.register(contributor)));
}
