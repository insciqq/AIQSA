import { Prisma, type MemoryJobState, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { prisma } from "../../prisma";
import { MemoryExecutionError } from "../execution/errors";
import { probeMemoryStructuredOutputAuthority } from "../execution/structuredClassifier";
import { MemoryPersistenceError } from "../persistence/errors";
import { enqueueMemoryJob } from "../persistence/jobs";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_FACT_EXTRACTION_HEAL_JOB_PREFIX,
  MEMORY_FACT_EXTRACTION_JOB_PREFIX,
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_VERSIONS,
  memoryFactExtractionHealJobFingerprint,
  memoryFactExtractionHealJobPrefix
} from "./extraction/contract";
import { loadMemoryIdentityWriteProfile } from "./identity/config";

/** Content-free repair constant, registered in observability/failureCodes.json. */
export const MEMORY_FACT_EXTRACTION_HEAL_VERSION = "extraction-heal-v1";
export const MEMORY_FACT_EXTRACTION_HEAL_MAX_OWNERS = 8;
/** Re-extractions one owner may have queued or running, which also caps one
 * pass: live extraction of new messages never waits behind a healing backlog. */
export const MEMORY_FACT_EXTRACTION_HEAL_OWNER_LIMIT = 2;
/** A failure under the current Memory-role policy is retried once, this long
 * after it settled, so a passing provider outage is not hammered. */
export const MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS = 6 * 60 * 60_000;

const ACTIVE_STATES = Object.freeze([
  "QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT"
] as const satisfies readonly MemoryJobState[]);
const ACTIVE_JOB_STATES = Prisma.sql`(${Prisma.join(ACTIVE_STATES.map((state) =>
  Prisma.sql`${state}::"MemoryJobState"`))})`;
const CONTINUATION_PAGE_PATTERN = `${MEMORY_FACT_EXTRACTION_JOB_PREFIX}p%`;

/** Uses `job`. A FAILED extraction call of the job that settled with `code`. */
function failedCallSql(code: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "MemoryExecutionBinding" AS failed
    WHERE failed."userId" = job."userId" AND failed."memoryJobId" = job.id
      AND failed."ownerType" = 'JOB' AND failed."logicalRole" = 'MEMORY_FACT_EXTRACT'
      AND failed.state = 'FAILED' AND failed."errorCode" = ${code})`;
}

/** Uses `job`. Some call of the job was bound under this Memory-role policy. */
function ranUnderPolicySql(policyVersion: number): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "MemoryExecutionBinding" AS execution
    WHERE execution."userId" = job."userId" AND execution."memoryJobId" = job.id
      AND execution."secretFreeExecutionSnapshot"->>'policyRevision' = ${String(policyVersion)})`;
}

/** Uses `job`. A re-extraction of the same source already holds this key. */
function healKeyUsedSql(prefix: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "MemoryJob" AS heal
    WHERE heal."userId" = job."userId" AND heal."sourceMessageId" = job."sourceMessageId"
      AND heal.kind = 'EXTRACT_FACTS'::"MemoryJobKind"
      AND heal."idempotencyFingerprint" LIKE ${`${prefix}%`})`;
}

/**
 * Uses `job`, `settings`, `chat` and `source`. The newest first-page
 * extraction of a still-current direct user message that ended on a provider
 * failure with no output and no ambiguity: a permanent failure (the job
 * settled on that stage) or exhausted transient retries (the job failed
 * terminally at the provider call). Its key under the current Memory-role
 * policy must still be unused: right away after a failure under an older
 * policy, otherwise once, after a delay. Admitted work that failed is retried;
 * nothing created at or before the latest Resume cutoff is, so this is never a
 * historical backfill.
 */
function healableExtractionSql(policyVersion: number, now: Date): Prisma.Sql {
  const samePolicyBefore = new Date(now.getTime() - MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS);
  return Prisma.sql`job.kind = 'EXTRACT_FACTS'::"MemoryJobKind"
    AND job."pipelineVersion" = ${MEMORY_FACT_EXTRACTION_PIPELINE_VERSION}
    AND job."idempotencyFingerprint" NOT LIKE ${CONTINUATION_PAGE_PATTERN}
    AND job."activeLeafMessageId" IS NOT NULL AND job."branchGeneration" IS NOT NULL
    AND job."sourceRevision" IS NOT NULL AND job."sourceHash" IS NOT NULL
    AND job."completedAt" IS NOT NULL
    AND ((job.state = 'SUCCEEDED'::"MemoryJobState" AND job.stage = 'fact_provider_unavailable'
        AND ${failedCallSql("memory_fact_provider_unavailable")})
      OR (job.state = 'TERMINAL_FAILED'::"MemoryJobState" AND job.stage = 'provider_call'
        AND job."errorCode" = 'memory_fact_provider_transient'
        AND ${failedCallSql("memory_fact_provider_transient")}))
    AND NOT EXISTS (SELECT 1 FROM "MemoryExecutionBinding" AS execution
      WHERE execution."userId" = job."userId" AND execution."memoryJobId" = job.id
        AND (execution.state IN ('RUNNING', 'OUTCOME_UNKNOWN', 'SUCCEEDED')
          OR (execution.state = 'PENDING' AND execution."startedAt" IS NOT NULL)
          OR (execution.state <> 'PENDING' AND NOT EXISTS (SELECT 1 FROM "UsageEvent" AS usage
            WHERE usage."userId" = execution."userId" AND usage."memoryExecutionBindingId" = execution.id))))
    AND job."memoryGenerationSnapshot" = settings."memoryGeneration"
    AND settings."useMemoryFacts" AND settings."learnAutomatically"
    AND chat."projectId" IS NULL AND chat."permanentDeletionAt" IS NULL
    AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
    AND source.role = 'user' AND source.status = 'complete'::"MessageStatus"
    -- An edit branches the message DAG: only the active path is current.
    AND EXISTS (
      WITH RECURSIVE active_path(id, "parentMessageId") AS (
        SELECT leaf.id, leaf."parentMessageId" FROM "Message" AS leaf
        WHERE leaf."chatId" = chat.id AND leaf.id = chat."activeLeafMessageId"
        UNION
        SELECT parent.id, parent."parentMessageId" FROM active_path
        JOIN "Message" AS parent ON parent."chatId" = chat.id AND parent.id = active_path."parentMessageId"
        WHERE active_path.id <> source.id
      )
      SELECT 1 FROM active_path WHERE active_path.id = source.id)
    AND NOT EXISTS (SELECT 1 FROM "MemoryPauseInterval" AS pause
      WHERE pause."userId" = job."userId"
        AND pause.scope IN ('MASTER'::"MemoryPauseScope", 'AUTOMATIC_LEARNING'::"MemoryPauseScope")
        AND (pause."resumedAt" IS NULL OR source."createdAt" <= pause."resumedAt"))
    AND NOT EXISTS (SELECT 1 FROM "ChatMemoryCheckpoint" AS checkpoint
      WHERE checkpoint."userId" = job."userId" AND checkpoint."chatId" = chat.id
        AND source."createdAt" <= checkpoint."resumeCreatedAtCutoff")
    AND NOT EXISTS (SELECT 1 FROM "MemorySourceBarrier" AS barrier
      WHERE barrier."userId" = job."userId" AND NOT barrier."explicitOverrideAllowed"
        AND barrier.kind IN ('ALL_REUSABLE'::"MemorySourceBarrierKind", 'AUTOMATIC_FACTS'::"MemorySourceBarrierKind")
        AND source."createdAt" <= barrier."sourceCreatedAtCutoff")
    AND NOT EXISTS (SELECT 1 FROM "MemorySuppression" AS suppression
      WHERE suppression."userId" = job."userId"
        AND (suppression."expiresAt" IS NULL OR suppression."expiresAt" > ${now})
        AND (suppression.scope = 'ALL'::"MemorySuppressionScope"
          OR (suppression.scope = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND suppression."sourceChatId" = chat.id AND suppression."sourceMessageId" = source.id)))
    AND NOT EXISTS (SELECT 1 FROM "MemoryJob" AS other
      WHERE other."userId" = job."userId" AND other."sourceMessageId" = job."sourceMessageId"
        AND other.kind = 'EXTRACT_FACTS'::"MemoryJobKind" AND other.id <> job.id
        AND (other.state IN ${ACTIVE_JOB_STATES}
          OR (other."idempotencyFingerprint" NOT LIKE ${CONTINUATION_PAGE_PATTERN}
            AND (other."createdAt", other.id) > (job."createdAt", job.id))))
    AND CASE WHEN ${ranUnderPolicySql(policyVersion)}
      THEN job."completedAt" <= ${samePolicyBefore}
        AND NOT ${healKeyUsedSql(memoryFactExtractionHealJobPrefix({ samePolicy: true, utilityPolicyVersion: policyVersion }))}
      ELSE NOT ${healKeyUsedSql(memoryFactExtractionHealJobPrefix({ samePolicy: false, utilityPolicyVersion: policyVersion }))}
    END`;
}

/** Uses `job`. Re-extractions of the owner that are queued or running. */
const inFlightHealsSql = Prisma.sql`(SELECT COUNT(*) FROM "MemoryJob" AS heal
  WHERE heal."userId" = job."userId" AND heal.kind = 'EXTRACT_FACTS'::"MemoryJobKind"
    AND heal."idempotencyFingerprint" LIKE ${`${MEMORY_FACT_EXTRACTION_HEAL_JOB_PREFIX}%`}
    AND heal.state IN ${ACTIVE_JOB_STATES})`;

const candidateSources = Prisma.sql`"MemoryJob" AS job
  JOIN "UserMemorySettings" AS settings ON settings."userId" = job."userId"
  JOIN "Chat" AS chat ON chat.id = job."chatId" AND chat."userId" = job."userId"
  JOIN "Message" AS source ON source.id = job."sourceMessageId" AND source."chatId" = chat.id`;

type HealCandidate = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  samePolicy: boolean;
  sourceHash: string;
  sourceMessageId: string;
  sourceRevision: number;
}>;

/** No paid call: whether the current Memory role can bind an extraction now. */
async function extractionAuthorityAvailable(client: PrismaClient, now: Date, userId: string): Promise<boolean> {
  try {
    await probeMemoryStructuredOutputAuthority({ authority: { now: () => now }, client,
      role: "MEMORY_FACT_EXTRACT", userId, versions: MEMORY_FACT_EXTRACTION_VERSIONS });
    return true;
  } catch (error) {
    if (error instanceof MemoryExecutionError ||
      error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable") return false;
    throw error;
  }
}

async function currentPolicyVersion(client: Pick<PrismaClient, "$queryRaw">): Promise<number | null> {
  const [policy] = await client.$queryRaw<Array<{ version: number }>>(Prisma.sql`
    SELECT version FROM "MemoryUtilityModelPolicy" WHERE id = 'installation'
  `);
  return policy?.version ?? null;
}

/**
 * Re-extracts direct user messages whose fact extraction ended on a provider
 * failure that produced no output, such as an outage of the Memory model. Each
 * admission is a new first-page EXTRACT_FACTS job carrying the failed job's
 * exact source snapshot and keyed by the current Memory-role policy version;
 * the failed row, its bindings and usage stay untouched. The extraction
 * handler re-proves the source, command, suppression, pause and generation
 * fences before any provider call. Continuation pages of a long message are
 * not re-extracted. The predicate stops matching once the newest attempt of a
 * source succeeded, was fenced or holds its key, so the pass ends by itself.
 */
export async function healFailedMemoryFactExtractions(
  client: PrismaClient = prisma,
  input: Readonly<{ authorityAvailable?: (userId: string) => Promise<boolean>; now: Date }>
): Promise<number> {
  if (!Number.isFinite(input.now.getTime())) throw new Error("memory_fact_extraction_heal_input_invalid");
  const authorityAvailable = input.authorityAvailable ??
    ((userId: string) => extractionAuthorityAvailable(client, input.now, userId));
  const policyVersion = await currentPolicyVersion(client).catch(retainDatabaseFailure);
  if (policyVersion === null) return 0;
  const owners = await client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT candidate."userId" FROM (
      SELECT DISTINCT ON (job."userId") job."userId", job."completedAt", job.id
      FROM ${candidateSources}
      JOIN "User" AS owner_user ON owner_user.id = job."userId" AND owner_user.status = 'active'::"UserStatus"
      WHERE ${healableExtractionSql(policyVersion, input.now)}
        AND ${inFlightHealsSql} < ${MEMORY_FACT_EXTRACTION_HEAL_OWNER_LIMIT}
      ORDER BY job."userId", job."completedAt", job.id
    ) AS candidate
    ORDER BY candidate."completedAt", candidate.id
    LIMIT ${MEMORY_FACT_EXTRACTION_HEAL_MAX_OWNERS}
  `).catch(retainDatabaseFailure);
  let admitted = 0;
  let failed = 0;
  for (const { userId } of owners) {
    try {
      // A model that cannot extract now must not consume the owner's keys.
      if (!await authorityAvailable(userId)) continue;
      admitted += await withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        if (!settings.useMemoryFacts || !settings.learnAutomatically) return 0;
        const policy = await currentPolicyVersion(tx);
        if (policy === null) return 0;
        const capacity = MEMORY_FACT_EXTRACTION_HEAL_OWNER_LIMIT - await tx.memoryJob.count({ where: {
          idempotencyFingerprint: { startsWith: MEMORY_FACT_EXTRACTION_HEAL_JOB_PREFIX },
          kind: "EXTRACT_FACTS", state: { in: [...ACTIVE_STATES] }, userId
        } });
        if (capacity <= 0) return 0;
        const candidates = await tx.$queryRaw<HealCandidate[]>(Prisma.sql`
          SELECT job."chatId", job."sourceMessageId", job."activeLeafMessageId",
            job."branchGeneration", job."sourceRevision", job."sourceHash",
            ${ranUnderPolicySql(policy)} AS "samePolicy"
          FROM ${candidateSources}
          WHERE job."userId" = ${userId} AND ${healableExtractionSql(policy, input.now)}
          ORDER BY job."completedAt", job.id
          LIMIT ${capacity}
          FOR UPDATE OF job SKIP LOCKED
        `);
        const identityProfile = loadMemoryIdentityWriteProfile();
        let created = 0;
        for (const candidate of candidates) {
          const source = {
            activeLeafMessageId: candidate.activeLeafMessageId,
            branchGeneration: candidate.branchGeneration,
            chatId: candidate.chatId,
            sourceHash: candidate.sourceHash,
            sourceMessageId: candidate.sourceMessageId,
            sourceRevision: candidate.sourceRevision
          };
          const queued = await enqueueMemoryJob(tx, settings, {
            idempotencyFingerprint: memoryFactExtractionHealJobFingerprint(
              { ...source, memoryGenerationSnapshot: settings.memoryGeneration, userId },
              identityProfile,
              { samePolicy: candidate.samePolicy, utilityPolicyVersion: policy }
            ),
            kind: "EXTRACT_FACTS",
            pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
            source
          });
          if (queued.created) created += 1;
        }
        return created;
      });
    } catch (error) {
      // Account disable or deletion may win after selection. Any other owner
      // failure retries on a later pass without holding other owners back.
      if (!(error instanceof MemoryPersistenceError && error.code === "memory_owner_unavailable")) failed += 1;
    }
  }
  if (admitted > 0 || failed > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "recovery",
      outcome: failed > 0 ? "failed" : "completed", action: "retry",
      code: MEMORY_FACT_EXTRACTION_HEAL_VERSION, count: admitted,
      ...(failed > 0 ? { failed_count: failed } : {}) });
  }
  return admitted;
}
