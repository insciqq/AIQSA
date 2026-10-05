import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import { prisma } from "../../prisma";
import { MemoryExecutionError } from "../execution/errors";
import { MemoryPersistenceError } from "../persistence/errors";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import {
  MEMORY_EMBEDDING_BATCH_VERSIONS,
  memoryItemEmbeddingGenerationMatchesPin,
  type MemoryItemEmbeddingGeneration,
  type MemoryItemEmbeddingPin
} from "./contract";
import { enqueueMemoryEmbeddingBatchItems } from "./enqueue";
import { probeCurrentMemoryEmbeddingPin } from "./handler";
import { createPrismaMemoryItemEmbeddingRepository } from "./repository";

/** Content-free repair code, registered in observability/failureCodes.json. */
export const MEMORY_EMBEDDING_SWEEP_VERSION = "embedding-sweep-v1";
/** Younger entries and settlements belong to live writers and batches. */
export const MEMORY_EMBEDDING_SWEEP_GRACE_MS = 15 * 60_000;
/** A terminally failed batch is retried this long after it settled, or once
 * the grace passed when the failed call's credential has been rotated. */
export const MEMORY_EMBEDDING_SWEEP_FAILURE_DELAY_MS = 6 * 60 * 60_000;
/** Retries after an entry's first terminally failed batch. */
export const MEMORY_EMBEDDING_SWEEP_FAILURE_RETRIES = 3;
export const MEMORY_EMBEDDING_SWEEP_MAX_OWNERS = 8;
export const MEMORY_EMBEDDING_SWEEP_MAX_ENTRIES_PER_OWNER = 64;
export const MEMORY_EMBEDDING_SWEEP_INTERVAL_MS = 60_000;

/** Provider input failures that repeat on every retry of the same text. */
const DETERMINISTIC_FAILURE_CODES = Object.freeze([
  "embedding_batch_invalid",
  "embedding_input_invalid",
  "embedding_request_too_large"
]);

const OPEN_JOB_STATES = Prisma.sql`(
  'QUEUED'::"MemoryJobState", 'CLAIMED'::"MemoryJobState",
  'RETRYABLE_FAILED'::"MemoryJobState",
  'WAITING_FOR_CONFIGURATION'::"MemoryJobState",
  'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
)`;

/** Uses `settings`: the settings-active vector generation as `generation`. */
const ACTIVE_VECTOR_GENERATION = Prisma.sql`"MemoryIndexGeneration" AS generation
  ON generation."userId" = settings."userId"
  AND generation."id" = settings."activeIndexGenerationId"
  AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
  AND generation."indexMode" = 'HYBRID'::"MemoryIndexMode"
  AND generation."retrievalPipelineVersion" = ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION}
  AND generation."embeddingProviderModelId" = settings."embeddingProviderModelId"`;

/** Uses `settings`. A reset or account deletion is draining the owner. */
const OWNER_DELETION_PENDING = Prisma.sql`EXISTS (
  SELECT 1 FROM "MemoryDeletionOutbox" AS deletion
  WHERE deletion."userId" = settings."userId"
    AND deletion."operation" IN (
      'BULK_CLEAR'::"MemoryDeletionOperation",
      'ACCOUNT_MEMORY_DELETE'::"MemoryDeletionOperation"
    )
    AND deletion."state" NOT IN (
      'SUCCEEDED'::"MemoryDeletionState", 'CANCELLED'::"MemoryDeletionState"
    )
)`;

/** Uses `entry`: its newest batch child, with that child's job, as `latest`. */
const LATEST_CHILD = Prisma.sql`LEFT JOIN LATERAL (
  SELECT child."id", child."state"::text AS "state", child."errorCode",
    child."memoryJobId", job."state"::text AS "jobState",
    COALESCE(child."completedAt", job."completedAt", job."updatedAt") AS "settledAt",
    COALESCE(job."completedAt", job."updatedAt") AS "jobSettledAt"
  FROM "MemoryEmbeddingBatchItem" AS child
  INNER JOIN "MemoryJob" AS job
    ON job."userId" = child."userId" AND job."id" = child."memoryJobId"
  WHERE child."userId" = entry."userId" AND child."searchEntryId" = entry."id"
  ORDER BY child."createdAt" DESC, child."id" DESC
  LIMIT 1
) AS latest ON TRUE`;

/**
 * Uses `entry` and `latest`. A vector-less entry that no live batch owns:
 * - any child of it in an open job is live work and owns the entry;
 * - an unapplied durable result, an ambiguous call of the newest batch or a
 *   deterministic input failure is never sent again;
 * - work retired without a terminal failure (a target that lost authority, a
 *   paused or fenced batch, no batch at all) is re-admitted after the grace;
 * - a terminal failure waits the failure delay unless the failed call's
 *   credential has been rotated since, and is retried a bounded number of
 *   times per entry.
 */
function strandedEntrySql(now: Date): Prisma.Sql {
  const graceCutoff = new Date(now.getTime() - MEMORY_EMBEDDING_SWEEP_GRACE_MS);
  const failureCutoff = new Date(
    now.getTime() - MEMORY_EMBEDDING_SWEEP_FAILURE_DELAY_MS
  );
  return Prisma.sql`entry."embeddingState" IN (
      'PENDING'::"MemoryEmbeddingState", 'FAILED'::"MemoryEmbeddingState"
    )
    AND entry."updatedAt" <= ${graceCutoff}
    AND NOT EXISTS (
      SELECT 1 FROM "MemoryEmbeddingBatchItem" AS open_child
      INNER JOIN "MemoryJob" AS open_job
        ON open_job."userId" = open_child."userId"
        AND open_job."id" = open_child."memoryJobId"
      WHERE open_child."userId" = entry."userId"
        AND open_child."searchEntryId" = entry."id"
        AND open_job."state" IN ${OPEN_JOB_STATES}
    )
    AND (latest."id" IS NULL OR (
      latest."state" NOT IN ('RESULT_READY', 'OUTCOME_UNKNOWN')
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryExecutionBinding" AS call
        WHERE call."userId" = entry."userId"
          AND call."memoryJobId" = latest."memoryJobId"
          AND (
            call."state" IN (
              'RUNNING'::"MemoryExecutionState",
              'OUTCOME_UNKNOWN'::"MemoryExecutionState"
            )
            OR (call."state" = 'PENDING'::"MemoryExecutionState"
              AND call."startedAt" IS NOT NULL)
          )
      )
      AND NOT (latest."state" = 'FAILED'
        AND latest."errorCode" IN (${Prisma.join(DETERMINISTIC_FAILURE_CODES)}))
    ))
    AND CASE
      WHEN entry."embeddingState" = 'FAILED'::"MemoryEmbeddingState"
        OR latest."jobState" = 'TERMINAL_FAILED'
      THEN (
        SELECT COUNT(*) FROM "MemoryEmbeddingBatchItem" AS failed_child
        INNER JOIN "MemoryJob" AS failed_job
          ON failed_job."userId" = failed_child."userId"
          AND failed_job."id" = failed_child."memoryJobId"
        WHERE failed_child."userId" = entry."userId"
          AND failed_child."searchEntryId" = entry."id"
          AND failed_job."state" = 'TERMINAL_FAILED'::"MemoryJobState"
      ) <= ${MEMORY_EMBEDDING_SWEEP_FAILURE_RETRIES}
        AND COALESCE(latest."jobSettledAt", entry."updatedAt") <= ${graceCutoff}
        AND (
          COALESCE(latest."jobSettledAt", entry."updatedAt") <= ${failureCutoff}
          OR EXISTS (
            SELECT 1 FROM "MemoryExecutionBinding" AS failed_call
            INNER JOIN "ProviderCredential" AS credential
              ON credential."id" = failed_call."credentialId"
            WHERE failed_call."userId" = entry."userId"
              AND failed_call."memoryJobId" = latest."memoryJobId"
              AND failed_call."state" = 'FAILED'::"MemoryExecutionState"
              AND credential."activeVersionId" IS DISTINCT FROM
                failed_call."credentialVersionId"
          )
        )
      ELSE COALESCE(latest."settledAt", entry."updatedAt") <= ${graceCutoff}
    END`;
}

type OwnerRow = Readonly<{
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  generationId: string;
  referenceChatHistory: boolean;
  vectorSpaceFingerprint: string | null;
  userId: string;
}>;

type CandidateRow = Readonly<{
  entryId: string;
  latestChildId: string | null;
  safeContentHash: string;
}>;

type CandidateQuery = Readonly<{
  afterEntryId?: string;
  entryIds?: readonly string[];
  generationId: string;
  includeHistory: boolean;
  limit: number;
  now: Date;
  userId: string;
}>;

function candidatesSql(input: CandidateQuery): Prisma.Sql {
  return Prisma.sql`
    SELECT entry."id" AS "entryId", entry."safeContentHash",
      latest."id" AS "latestChildId"
    FROM "MemorySearchEntry" AS entry
    ${LATEST_CHILD}
    WHERE entry."userId" = ${input.userId}
      AND entry."indexGenerationId" = ${input.generationId}
      AND entry."id" > ${input.afterEntryId ?? ""}
      ${input.entryIds
        ? Prisma.sql`AND entry."id" IN (${Prisma.join([...input.entryIds])})`
        : Prisma.empty}
      ${input.includeHistory
        ? Prisma.empty
        : Prisma.sql`AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"`}
      AND ${strandedEntrySql(input.now)}
    ORDER BY entry."id"
    LIMIT ${input.limit}
  `;
}

/** Owners whose Memory, history preference, active vector generation and
 * deletion state admit embedding work, optionally only those holding a
 * stranded entry. */
function ownersSql(input: Readonly<{
  afterUserId?: string;
  limit: number;
  strandedAt?: Date;
  userId?: string;
}>): Prisma.Sql {
  return Prisma.sql`
    SELECT settings."userId", settings."referenceChatHistory",
      generation."id" AS "generationId",
      generation."embeddingConfigurationFingerprint",
      generation."embeddingConnectionId", generation."embeddingDimension",
      generation."embeddingProviderModelId", generation."vectorSpaceFingerprint"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner
      ON owner."id" = settings."userId" AND owner."status" = 'active'::"UserStatus"
    INNER JOIN ${ACTIVE_VECTOR_GENERATION}
    WHERE settings."useMemoryFacts" = TRUE
      ${input.userId
        ? Prisma.sql`AND settings."userId" = ${input.userId}`
        : Prisma.sql`AND settings."userId" > ${input.afterUserId ?? ""}`}
      AND NOT ${OWNER_DELETION_PENDING}
      ${input.strandedAt ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "MemorySearchEntry" AS entry
        ${LATEST_CHILD}
        WHERE entry."userId" = settings."userId"
          AND entry."indexGenerationId" = generation."id"
          AND (settings."referenceChatHistory"
            OR entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType")
          AND ${strandedEntrySql(input.strandedAt)}
      )` : Prisma.empty}
    ORDER BY settings."userId"
    LIMIT ${input.limit}
  `;
}

function generationOf(owner: OwnerRow): MemoryItemEmbeddingGeneration {
  return {
    embeddingConfigurationFingerprint: owner.embeddingConfigurationFingerprint,
    embeddingConnectionId: owner.embeddingConnectionId,
    embeddingDimension: owner.embeddingDimension,
    embeddingProviderModelId: owner.embeddingProviderModelId,
    id: owner.generationId,
    indexMode: "HYBRID",
    retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
    vectorSpaceFingerprint: owner.vectorSpaceFingerprint
  };
}

/** No paid call: the owner's current document destination, or null. */
async function currentPin(
  client: PrismaClient,
  userId: string,
  now: Date
): Promise<MemoryItemEmbeddingPin | null> {
  try {
    return await probeCurrentMemoryEmbeddingPin(
      { now: () => now },
      client,
      userId,
      MEMORY_EMBEDDING_BATCH_VERSIONS
    );
  } catch (error) {
    if (error instanceof MemoryExecutionError ||
      error instanceof ProviderAdmissionError ||
      error instanceof MemoryPersistenceError &&
        error.code === "memory_owner_unavailable") return null;
    throw error;
  }
}

/** The successor of exactly one stranded batch child (or of none): a second
 * pass over the same state reuses it, and every later admission needs a new
 * stranded predecessor. */
function sweepTriggerIdentity(
  generationId: string,
  candidate: CandidateRow
): string {
  return memorySha256({
    domain: "aiqsa.memory.embedding-sweep",
    generationId,
    predecessor: candidate.latestChildId,
    safeContentHash: candidate.safeContentHash,
    version: MEMORY_EMBEDDING_SWEEP_VERSION
  });
}

export type MemoryEmbeddingSweepCursor = {
  afterEntryIdByOwner: Map<string, string>;
  afterUserId: string;
};

export type MemoryEmbeddingSweepResult = Readonly<{
  admitted: number;
  failedOwners: number;
}>;

async function sweepOwner(
  client: PrismaClient,
  owner: OwnerRow,
  now: Date,
  cursor: MemoryEmbeddingSweepCursor
): Promise<number> {
  // A destination that cannot embed now, or no longer matches the active
  // vector space, never consumes the owner's stranded work.
  const pin = await currentPin(client, owner.userId, now);
  if (!pin || !memoryItemEmbeddingGenerationMatchesPin(generationOf(owner), pin)) {
    return 0;
  }
  const page = await client.$queryRaw<CandidateRow[]>(candidatesSql({
    afterEntryId: cursor.afterEntryIdByOwner.get(owner.userId),
    generationId: owner.generationId,
    includeHistory: owner.referenceChatHistory,
    limit: MEMORY_EMBEDDING_SWEEP_MAX_ENTRIES_PER_OWNER,
    now,
    userId: owner.userId
  }));
  // Entries whose target cannot be admitted now stay behind the cursor, so a
  // long run of them cannot starve later entries of the same owner.
  if (page.length < MEMORY_EMBEDDING_SWEEP_MAX_ENTRIES_PER_OWNER) {
    cursor.afterEntryIdByOwner.delete(owner.userId);
  } else {
    cursor.afterEntryIdByOwner.set(owner.userId, page.at(-1)!.entryId);
  }
  // Re-prove each target with the batch handler's own authority rejoin: the
  // current owner, source, lifecycle, suppression, history checkpoint and
  // generation. Purged, suppressed or not-yet-current entries are skipped.
  const items = createPrismaMemoryItemEmbeddingRepository(client);
  const admissible: string[] = [];
  for (const candidate of page) {
    const target = await items.loadTarget(owner.userId, candidate.entryId);
    if (
      target &&
      target.generation.id === owner.generationId &&
      (target.embeddingState === "PENDING" || target.embeddingState === "FAILED") &&
      memoryItemEmbeddingGenerationMatchesPin(target.generation, pin)
    ) admissible.push(candidate.entryId);
  }
  if (admissible.length === 0) return 0;
  return withLockedMemoryTransaction(client, owner.userId, async (tx, locked) => {
    if (!locked.useMemoryFacts ||
      locked.activeIndexGenerationId !== owner.generationId) return 0;
    const [still] = await tx.$queryRaw<OwnerRow[]>(ownersSql({
      limit: 1,
      userId: owner.userId
    }));
    if (!still || still.generationId !== owner.generationId) return 0;
    const confirmed = await tx.$queryRaw<CandidateRow[]>(candidatesSql({
      entryIds: admissible,
      generationId: owner.generationId,
      includeHistory: locked.referenceChatHistory,
      limit: admissible.length,
      now,
      userId: owner.userId
    }));
    if (confirmed.length === 0) return 0;
    const queued = await enqueueMemoryEmbeddingBatchItems(
      tx,
      locked,
      confirmed.map((candidate) => ({
        entryId: candidate.entryId,
        triggerIdentity: sweepTriggerIdentity(owner.generationId, candidate)
      }))
    );
    return queued.childrenCreated;
  });
}

/**
 * Bounded, owner-locked repair of vector-less entries in each owner's
 * settings-active hybrid generation that no live batch owns: targets retired
 * while their source was briefly not current, batches cancelled by a pause,
 * and terminally failed batches. Each admission goes through the ordinary
 * batch enqueue with a trigger identity bound to the stranded child, so the
 * pass is idempotent, and the batch handler re-proves authority before any
 * provider call. Shadow generations belong to their rebuild.
 */
export async function sweepStrandedMemoryEmbeddings(
  client: PrismaClient = prisma,
  input: Readonly<{ cursor?: MemoryEmbeddingSweepCursor; now: Date }>
): Promise<MemoryEmbeddingSweepResult> {
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("memory_embedding_sweep_input_invalid");
  }
  const cursor = input.cursor ?? { afterEntryIdByOwner: new Map(), afterUserId: "" };
  const owners = await client.$queryRaw<OwnerRow[]>(ownersSql({
    afterUserId: cursor.afterUserId,
    limit: MEMORY_EMBEDDING_SWEEP_MAX_OWNERS,
    strandedAt: input.now
  })).catch(retainDatabaseFailure);
  // A rotating owner keyset keeps one busy owner from starving later ones.
  cursor.afterUserId = owners.length < MEMORY_EMBEDDING_SWEEP_MAX_OWNERS
    ? ""
    : owners.at(-1)!.userId;
  let admitted = 0;
  let failedOwners = 0;
  for (const owner of owners) {
    try {
      admitted += await sweepOwner(client, owner, input.now, cursor);
    } catch (error) {
      // Account disable or deletion may win after selection. Any other owner
      // failure retries on a later pass without holding other owners back.
      if (!(error instanceof MemoryPersistenceError &&
        error.code === "memory_owner_unavailable")) failedOwners += 1;
    }
  }
  if (admitted > 0 || failedOwners > 0) {
    logEvent("service_operation", { subsystem: "memory", stage: "recovery",
      outcome: failedOwners > 0 ? "failed" : "completed", action: "retry",
      code: MEMORY_EMBEDDING_SWEEP_VERSION, count: admitted,
      ...(failedOwners > 0 ? { failed_count: failedOwners } : {}) });
  }
  return { admitted, failedOwners };
}

/** The coordinator's discovery pass runs every second; the sweep reads at
 * most once per interval and keeps its rotation cursors between passes. */
export function createPrismaMemoryEmbeddingSweep(client: PrismaClient = prisma) {
  const cursor: MemoryEmbeddingSweepCursor = {
    afterEntryIdByOwner: new Map(),
    afterUserId: ""
  };
  let nextRunAt = 0;
  return Object.freeze({
    async reconcile(now: Date = new Date()): Promise<number> {
      if (now.getTime() < nextRunAt) return 0;
      nextRunAt = now.getTime() + MEMORY_EMBEDDING_SWEEP_INTERVAL_MS;
      return (await sweepStrandedMemoryEmbeddings(client, { cursor, now })).admitted;
    }
  });
}
