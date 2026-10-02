import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type { MemoryJobDescriptor, MemoryJobHandler } from "../coordinator/types";
import { enqueueMemoryDeletion } from "../persistence/deletion";
import { MemoryPersistenceError } from "../persistence/errors";
import {
  advanceMemoryMutation,
  withLockedMemoryTransaction,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import { memoryPurgeTargetType } from "../purge/contract";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION } from "./policy";

// Dream synthesis is retired. Background maintenance is now the only
// SYNTHESIZE_MEMORIES pipeline; the job kind and the MEMORY_SYNTHESIZE role
// are shared with it and stay. Every derivative synthesis wrote (patterns and
// combinations, both PATTERN modality) is forgotten through the ordinary
// FORGET_PURGE lifecycle; its tables remain retired shapes.

/** Content-free codes; all are registered in observability/failureCodes.json. */
export const MEMORY_SYNTHESIS_RETIRED_CODE = "memory_synthesis_retired";
const MEMORY_SYNTHESIS_RETIRED_FORGOTTEN_CODE = "memory_synthesis_retired_forgotten";
const MEMORY_SYNTHESIS_RETIRED_PINNED_CODE = "memory_synthesis_retired_pinned";
const MEMORY_SYNTHESIS_RETIRED_REASON_CODE = "synthesis_retired";

/** Owners per pass, as the retired scheduler bounded them. */
const MEMORY_RETIRED_SYNTHESIS_MAX_OWNERS = 24;
/** Facts per owner transaction; remaining facts keep the owner selected. */
const MEMORY_RETIRED_SYNTHESIS_MAX_FACTS = 64;

export type MemoryRetiredSynthesisResult = Readonly<{
  closedJobs: number;
  forgottenFacts: number;
  pinnedFacts: number;
  scrubbedExecutions: number;
}>;

/** Every SYNTHESIZE_MEMORIES job outside the maintenance pipeline belongs to
 * retired Dream synthesis. It closes without content, before any provider
 * work; the coordinator claims queued jobs before this reconcile step runs. */
export function createMemorySynthesizeJobDispatcher(maintenance: MemoryJobHandler): MemoryJobHandler {
  if (maintenance.kind !== "SYNTHESIZE_MEMORIES") throw new Error("memory_maintenance_handler_invalid");
  const isMaintenance = (job: MemoryJobDescriptor) => job.pipelineVersion === MEMORY_MAINTENANCE_PIPELINE_VERSION;
  return Object.freeze({
    kind: "SYNTHESIZE_MEMORIES" as const,
    async preflight(job) {
      if (isMaintenance(job)) return maintenance.preflight(job);
      return { status: "CANCELLED" as const, errorCode: MEMORY_SYNTHESIS_RETIRED_CODE };
    },
    async execute(job, context) {
      if (!isMaintenance(job)) throw new MemoryCoordinatorError(MEMORY_SYNTHESIS_RETIRED_CODE, false);
      return maintenance.execute(job, context);
    }
  });
}

/** A synthesized version that still holds content. EXPLICIT patterns are
 * impossible (synthesis shape CHECK); the filter keeps the selector exact. */
function retiredPatternVersionSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT 1 FROM "MemoryFactVersion" AS version
    WHERE version."userId" = fact."userId" AND version."factId" = fact."id"
      AND version."modality" = 'PATTERN'::"MemoryFactModality"
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."contentPurgedAt" IS NULL
  `;
}

async function closeRetiredJobs(client: PrismaClient, now: Date): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    UPDATE "MemoryJob" AS job
    SET "completedAt" = ${now}, "errorCode" = ${MEMORY_SYNTHESIS_RETIRED_CODE}, "errorMessage" = NULL,
      "leaseExpiresAt" = NULL, "leaseToken" = NULL, "nextAttemptAt" = NULL,
      "state" = 'CANCELLED'::"MemoryJobState", "updatedAt" = ${now}
    WHERE job."kind" = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind"
      AND job."pipelineVersion" <> ${MEMORY_MAINTENANCE_PIPELINE_VERSION}
      AND job."state" IN ('QUEUED'::"MemoryJobState", 'RETRYABLE_FAILED'::"MemoryJobState",
        'WAITING_FOR_CONFIGURATION'::"MemoryJobState", 'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState")
      AND EXISTS (SELECT 1 FROM "User" AS owner_user
        WHERE owner_user."id" = job."userId" AND owner_user."status" = 'active'::"UserStatus")
  `);
}

/** Pending staged output keeps content until applied. Its guard only lets
 * output change together with `appliedAt`, so both move in one statement. A
 * job still held under a live lease (a previous-release worker during Compose
 * replacement) is left to its writer and scrubbed by a later pass. */
async function scrubRetiredExecutions(client: PrismaClient, now: Date): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    UPDATE "MemorySynthesisExecution" AS execution
    SET "acceptedOutput" = NULL, "sourceBindings" = NULL,
      "appliedAt" = GREATEST(execution."createdAt", ${now})
    WHERE execution."appliedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "MemoryJob" AS job
        WHERE job."userId" = execution."userId" AND job."id" = execution."memoryJobId"
          AND job."state" = 'CLAIMED'::"MemoryJobState" AND job."leaseExpiresAt" > ${now})
  `);
}

/** Only active owners: `lockMemorySettings` rejects any other owner, which
 * would otherwise reselect the same rows forever. Their records are forgotten
 * once the owner is active again. Memory pause does not stop this cleanup:
 * it removes derivatives of a removed feature and creates no new Memory. */
async function retiredOwners(client: PrismaClient): Promise<readonly string[]> {
  const rows = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT version."userId"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId" AND fact."pinned" = FALSE
    INNER JOIN "User" AS owner_user
      ON owner_user."id" = version."userId" AND owner_user."status" = 'active'::"UserStatus"
    WHERE version."modality" = 'PATTERN'::"MemoryFactModality"
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."contentPurgedAt" IS NULL
    GROUP BY version."userId"
    ORDER BY MIN(version."createdAt"), version."userId"
    LIMIT ${MEMORY_RETIRED_SYNTHESIS_MAX_OWNERS}
  `);
  return rows.map(({ userId }) => userId);
}

/** Forgets one owner's synthesized facts from any lifecycle state, like the
 * maintenance removal of an automatic fact but without requiring a current
 * version: FORGET event, FORGOTTEN fact and versions, no search entries,
 * scrubbed content and a FORGET_PURGE obligation. Source facts stay intact. */
async function forgetRetiredMemorySynthesis(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  now: Date
): Promise<Readonly<{ forgottenFacts: number; pinnedFacts: number }>> {
  const userId = settings.userId;
  const [pinned] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::integer AS count FROM "MemoryFact" AS fact
    WHERE fact."userId" = ${userId} AND fact."pinned" = TRUE AND EXISTS (${retiredPatternVersionSql()})
  `);
  const targets = await tx.$queryRaw<Array<{ factId: string; state: string; versionId: string }>>(Prisma.sql`
    SELECT fact."id" AS "factId", fact."state"::text AS state,
      COALESCE(fact."currentVersionId", (
        SELECT latest."id" FROM "MemoryFactVersion" AS latest
        WHERE latest."userId" = fact."userId" AND latest."factId" = fact."id"
        ORDER BY latest."createdAt" DESC, latest."id" DESC LIMIT 1
      )) AS "versionId"
    FROM "MemoryFact" AS fact
    WHERE fact."userId" = ${userId} AND fact."pinned" = FALSE AND EXISTS (${retiredPatternVersionSql()})
    ORDER BY fact."id"
    LIMIT ${MEMORY_RETIRED_SYNTHESIS_MAX_FACTS}
    FOR UPDATE OF fact
  `);
  const pinnedFacts = pinned?.count ?? 0;
  if (targets.length === 0) return { forgottenFacts: 0, pinnedFacts };
  const factIds = Prisma.join(targets.map(({ factId }) => factId));
  // Facts already forgotten through another owned lifecycle only lose their
  // remaining content; they change no visible state and need no new event.
  const transitioned = targets.filter(({ state }) => state !== "FORGOTTEN");
  if (transitioned.length > 0) {
    await tx.memoryEvent.createMany({ data: transitioned.map(({ factId, versionId }) => ({
      userId, operation: "FORGET" as const, actorType: "JOB" as const, factId, factVersionId: versionId,
      sourceGeneration: settings.memoryGeneration, metadata: { reasonCode: MEMORY_SYNTHESIS_RETIRED_REASON_CODE }
    })) });
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryFactVersion" SET "state" = 'FORGOTTEN'::"MemoryFactVersionState",
      "systemTo" = COALESCE("systemTo", GREATEST(${now}, "systemFrom" + INTERVAL '1 millisecond'))
    WHERE "userId" = ${userId} AND "factId" IN (${factIds})
      AND "state" <> 'FORGOTTEN'::"MemoryFactVersionState"
  `);
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryFact" SET "currentVersionId" = NULL, "state" = 'FORGOTTEN'::"MemoryFactState",
      "forgottenAt" = COALESCE("forgottenAt", ${now}), "updatedAt" = ${now}
    WHERE "userId" = ${userId} AND "id" IN (${factIds}) AND "pinned" = FALSE
  `);
  if (updated !== targets.length) throw new Error("memory_synthesis_retirement_target_changed");
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MemorySearchEntry" AS entry USING "MemoryFactVersion" AS version
    WHERE entry."userId" = ${userId} AND version."userId" = entry."userId"
      AND entry."factVersionId" = version."id" AND version."factId" IN (${factIds})
  `);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryFactVersion" SET "displayText" = NULL, "normalizedSearchText" = NULL, "structuredValue" = NULL,
      "semanticFrame" = NULL, "semanticAdjudication" = NULL, "rawTemporalExpression" = NULL,
      "temporalResolutionEvidence" = NULL, "occurredAt" = NULL, "expectedAt" = NULL, "expiresAt" = NULL,
      "validFrom" = NULL, "validTo" = NULL, "sourceTimezone" = NULL, "temporalResolverVersion" = NULL,
      "contentPurgedAt" = COALESCE("contentPurgedAt", ${now})
    WHERE "userId" = ${userId} AND "factId" IN (${factIds})
  `);
  for (const { factId } of targets) {
    await enqueueMemoryDeletion(tx, settings, { operation: "FORGET_PURGE", targetId: factId,
      targetType: memoryPurgeTargetType("MEMORY_FACT") });
  }
  if (transitioned.length > 0) await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  return { forgottenFacts: targets.length, pinnedFacts };
}

function ownerUnavailable(error: unknown): boolean {
  return error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable";
}

/** Idempotent coordinator step, repeated every pass while rows remain. It also
 * catches records a previous-release worker writes during Compose replacement.
 * Each part runs even when another fails; the first failure is rethrown. */
export async function reconcileRetiredMemorySynthesis(
  client: PrismaClient,
  now: Date
): Promise<MemoryRetiredSynthesisResult> {
  if (!Number.isFinite(now.getTime())) throw new Error("memory_synthesis_retirement_clock_invalid");
  const failures: unknown[] = [];
  const attempt = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      failures.push(error);
      return fallback;
    }
  };
  const closedJobs = await attempt(() => closeRetiredJobs(client, now), 0);
  const scrubbedExecutions = await attempt(() => scrubRetiredExecutions(client, now), 0);
  let forgottenFacts = 0;
  let pinnedFacts = 0;
  for (const userId of await attempt(() => retiredOwners(client), [])) {
    const result = await attempt(() => withLockedMemoryTransaction(client, userId,
      (tx, settings) => forgetRetiredMemorySynthesis(tx, settings, now))
      .catch((error: unknown) => {
        if (ownerUnavailable(error)) return { forgottenFacts: 0, pinnedFacts: 0 };
        throw error;
      }), { forgottenFacts: 0, pinnedFacts: 0 });
    forgottenFacts += result.forgottenFacts;
    pinnedFacts += result.pinnedFacts;
  }
  if (closedJobs > 0) {
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile", outcome: "cancelled",
      code: MEMORY_SYNTHESIS_RETIRED_CODE, count: closedJobs });
  }
  if (forgottenFacts > 0) {
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "cleanup", outcome: "completed",
      code: MEMORY_SYNTHESIS_RETIRED_FORGOTTEN_CODE, count: forgottenFacts });
  }
  if (pinnedFacts > 0) {
    logEvent("runtime_lifecycle", { subsystem: "memory", stage: "cleanup", outcome: "skipped",
      code: MEMORY_SYNTHESIS_RETIRED_PINNED_CODE, count: pinnedFacts });
  }
  if (failures.length > 0) throw failures[0];
  return Object.freeze({ closedJobs, forgottenFacts, pinnedFacts, scrubbedExecutions });
}
