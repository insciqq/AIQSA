import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../../observability";
import { prisma } from "../../../prisma";
import { MemoryPersistenceError } from "../../persistence/errors";
import {
  memoryAutomaticEquivalenceUnprotectedPredicate,
  memoryEquivalenceComparableVersionPredicate
} from "../../persistence/explicitEquivalence";
import { enqueueMemoryJob } from "../../persistence/jobs";
import {
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../../persistence/transaction";
import {
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  memoryEquivalenceTextKey,
  memoryExplicitRelationJobFingerprint
} from "./explicitPolicy";

/** Recorded per owner once its sweep is complete, so the sweep never becomes a
 * periodic rescan; a later sweep needs a new version. Content-free and
 * registered in observability/failureCodes.json. */
export const MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_VERSION = "explicit-equivalence-sweep-v1";
export const MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_OWNERS = 8;
export const MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_JOBS_PER_OWNER = 32;
/** What a previous-release worker records when it cancels a v2 job it cannot
 * route during Compose replacement. This release never records it for v2. */
const PREVIOUS_RELEASE_CANCELLATION = "memory_fact_relation_job_invalid";

type SweepRow = Readonly<{
  checked: boolean;
  eligible: boolean;
  normalizedSearchText: string;
  scopeId: string;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  versionId: string;
}>;

/** Automatic versions of one owner that share a normalized text with a current
 * explicit save of their scope and have no equivalence check yet. */
export function selectMemoryExplicitEquivalenceSweepTargets(
  rows: readonly SweepRow[]
): readonly string[] {
  const explicitKeys = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.sourceMode !== "EXPLICIT") continue;
    const key = memoryEquivalenceTextKey(row.normalizedSearchText);
    if (key.length === 0) continue;
    const keys = explicitKeys.get(row.scopeId) ?? new Set<string>();
    keys.add(key);
    explicitKeys.set(row.scopeId, keys);
  }
  return Object.freeze(rows.flatMap((row) => {
    if (row.sourceMode !== "AUTOMATIC" || !row.eligible || row.checked) return [];
    const key = memoryEquivalenceTextKey(row.normalizedSearchText);
    return key.length > 0 && explicitKeys.get(row.scopeId)?.has(key) ? [row.versionId] : [];
  }));
}

async function sweepOwner(tx: MemoryTransaction, settings: LockedMemorySettings): Promise<number> {
  if (!settings.useMemoryFacts || !settings.learnAutomatically) return 0;
  // A comparison an older worker cancelled before dispatch is resumed once;
  // it never bought a provider call, and preflight rechecks its source.
  const revived = await tx.memoryJob.updateMany({
    data: {
      acceptedResultHash: null, attemptCount: 0, completedAt: null, errorCode: null,
      errorMessage: null, leaseExpiresAt: null, leaseToken: null, nextAttemptAt: null,
      stage: null, state: "QUEUED"
    },
    where: {
      errorCode: PREVIOUS_RELEASE_CANCELLATION, kind: "RESOLVE_FACT_RELATIONS",
      pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION, state: "CANCELLED",
      userId: settings.userId
    }
  });
  const rows = await tx.$queryRaw<SweepRow[]>(Prisma.sql`
    SELECT version."id" AS "versionId", version."sourceMode"::text AS "sourceMode",
      version."normalizedSearchText", fact."scopeId",
      (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        OR ${memoryAutomaticEquivalenceUnprotectedPredicate()}) AS "eligible",
      EXISTS (
        SELECT 1 FROM "MemoryJob" AS job
        WHERE job."userId" = version."userId" AND job."targetFactVersionId" = version."id"
          AND job."kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
          AND job."pipelineVersion" = ${MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION}
      ) AS "checked"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact ON fact."userId" = version."userId" AND fact."id" = version."factId"
    JOIN "MemoryScope" AS scope ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE version."userId" = ${settings.userId}
      AND version."normalizedSearchText" IS NOT NULL
      AND ${memoryEquivalenceComparableVersionPredicate()}
    ORDER BY version."createdAt", version."id"
  `);
  const targets = selectMemoryExplicitEquivalenceSweepTargets(rows);
  let created = 0;
  for (const targetFactVersionId of targets.slice(0, MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_JOBS_PER_OWNER)) {
    const job = await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryExplicitRelationJobFingerprint(targetFactVersionId),
      kind: "RESOLVE_FACT_RELATIONS", pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
      targetFactVersionId
    });
    if (job.created) created += 1;
  }
  // A larger owner continues next pass; enqueued targets are already checked.
  if (targets.length <= MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_JOBS_PER_OWNER) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "UserMemorySettings"
      SET "explicitEquivalenceSweepVersion" = ${MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_VERSION}
      WHERE "userId" = ${settings.userId}
    `);
  }
  return created + revived.count;
}

/** One owner's sweep under its Memory lock; returns the checks it scheduled
 * or resumed. Repeating it schedules nothing already checked. */
export async function sweepMemoryExplicitEquivalenceOwner(
  client: PrismaClient,
  userId: string
): Promise<number> {
  return withLockedMemoryTransaction(client, userId, sweepOwner);
}

/** Bounded, idempotent discovery of equivalent pairs written before the save
 * and learning triggers existed: one pass per owner and sweep version, no
 * extraction replay. Each scheduled check costs one Memory Utility comparison
 * of one automatic version against at most twelve explicit saves. */
export async function reconcileMemoryExplicitEquivalenceSweep(
  client: PrismaClient = prisma
): Promise<number> {
  const owners = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT settings."userId"
    FROM "UserMemorySettings" AS settings
    JOIN "User" AS owner ON owner."id" = settings."userId" AND owner."status" = 'active'::"UserStatus"
    WHERE settings."useMemoryFacts" = TRUE AND settings."learnAutomatically" = TRUE
      AND settings."explicitEquivalenceSweepVersion" IS DISTINCT FROM ${MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_VERSION}
    ORDER BY settings."userId"
    LIMIT ${MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_OWNERS}
  `);
  let scheduled = 0;
  let failed = 0;
  for (const { userId } of owners) {
    try {
      scheduled += await sweepMemoryExplicitEquivalenceOwner(client, userId);
    } catch (error) {
      // Account disable or deletion may win after selection. Any other owner
      // failure retries on a later pass without holding other owners back.
      if (!(error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable")) failed += 1;
    }
  }
  if (scheduled > 0 || failed > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "recovery",
      outcome: failed > 0 ? "failed" : "completed", action: "retry",
      code: MEMORY_EXPLICIT_EQUIVALENCE_SWEEP_VERSION, count: scheduled,
      ...(failed > 0 ? { failed_count: failed } : {}) });
  }
  return scheduled;
}
