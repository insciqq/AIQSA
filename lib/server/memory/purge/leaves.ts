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
