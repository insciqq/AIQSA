import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminHealthQueueId } from "../../../contracts/adminHealthQueues";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { deletionJobClaimableBefore, dueAttachmentDeletionJobSql } from "../../retention/prune";
import { adminMemoryQueueSql } from "../memory/statusRepository";
import { ADMIN_HEALTH_QUEUE_FAILURE_WINDOW_MS, ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS } from "./queueThresholds";

export type AdminHealthQueueClient = Pick<PrismaClient, "$executeRaw" | "$queryRaw" | "$transaction">;

/** Raw counts of one queue; `oldestDueAt` is when its oldest unfinished job became due. */
export type AdminHealthQueueCounts = Readonly<{
  waiting: number;
  running: number;
  failed24h: number | null;
  oldestDueAt: Date | null;
}>;

/** `counts` is null when that queue could not be read. */
export type AdminHealthQueueReading = Readonly<{ queue: AdminHealthQueueId; counts: AdminHealthQueueCounts | null }>;

type CountRow = Readonly<{
  waiting: bigint | number;
  running: bigint | number;
  failed: bigint | number | null;
  oldestDueAt: Date | null;
}>;

type Window = Readonly<{ now: Date; since: Date }>;

/**
 * One aggregate statement per queue. Every statement reads only unfinished
 * rows (or failures inside the window) through a state-leading index, or a
 * table that holds only unfinished jobs because finished ones are deleted.
 * Nothing but counts and one timestamp leaves PostgreSQL.
 */
const queueSql: Readonly<Record<AdminHealthQueueId, (window: Window) => Prisma.Sql>> = {
  // Settled jobs are deleted, so the table is the queue; a job whose file is no
  // longer processing is not work any more.
  attachment_processing: ({ since }) => Prisma.sql`
    SELECT
      count(*) FILTER (WHERE job."claimToken" IS NULL)::integer AS "waiting",
      count(*) FILTER (WHERE job."claimToken" IS NOT NULL)::integer AS "running",
      count(*) FILTER (WHERE job."lastErrorCode" IS NOT NULL AND job."lastAttemptAt" >= ${since})::integer AS "failed",
      min(job."createdAt") AS "oldestDueAt"
    FROM "AttachmentProcessingJob" AS job
    INNER JOIN "Attachment" AS attachment
      ON attachment."id" = job."attachmentId"
      AND attachment."status" = 'processing'::"AttachmentStatus"
  `,
  // The Knowledge operations card's definitions: pending and processing
  // artifacts, the oldest of either by creation time.
  document_processing: ({ since }) => Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "state" = 'pending'::"KnowledgeSourceArtifactState")::integer AS "waiting",
      count(*) FILTER (WHERE "state" = 'processing'::"KnowledgeSourceArtifactState")::integer AS "running",
      count(*) FILTER (WHERE "state" = 'failed'::"KnowledgeSourceArtifactState" AND "updatedAt" >= ${since})::integer AS "failed",
      min("createdAt") FILTER (WHERE "state" IN (
        'pending'::"KnowledgeSourceArtifactState", 'processing'::"KnowledgeSourceArtifactState"
      )) AS "oldestDueAt"
    FROM "KnowledgeSourceIndexArtifact"
    WHERE "state" IN (
      'pending'::"KnowledgeSourceArtifactState",
      'processing'::"KnowledgeSourceArtifactState",
      'failed'::"KnowledgeSourceArtifactState"
    )
  `,
  // A dispatched title whose answer never arrived ends ambiguous: its outcome is unknown.
  chat_titles: ({ since }) => Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "status" = 'pending'::"ChatTitleGenerationStatus")::integer AS "waiting",
      count(*) FILTER (WHERE "status" = 'dispatched'::"ChatTitleGenerationStatus")::integer AS "running",
      count(*) FILTER (WHERE "status" = 'ambiguous'::"ChatTitleGenerationStatus")::integer AS "failed",
      min("createdAt") FILTER (WHERE "status" IN (
        'pending'::"ChatTitleGenerationStatus", 'dispatched'::"ChatTitleGenerationStatus"
      )) AS "oldestDueAt"
    FROM "ChatTitleGeneration"
    WHERE "status" IN ('pending'::"ChatTitleGenerationStatus", 'dispatched'::"ChatTitleGenerationStatus")
      OR ("status" = 'ambiguous'::"ChatTitleGenerationStatus" AND "createdAt" >= ${since})
  `,
  // Waiting: due active tasks the runner has not claimed yet plus pending
  // occurrences without a live admission lease. Running: admissions in flight
  // and occurrences whose answer run executes; a run may legitimately take
  // long and has its own recovery, so running occurrences do not age the queue.
  scheduled_tasks: ({ now, since }) => Prisma.sql`
    WITH occurrences AS (
      SELECT
        count(*) FILTER (WHERE "state" = 'PENDING'::"ScheduledTaskOccurrenceState"
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now}))::integer AS "waiting",
        count(*) FILTER (WHERE "state" = 'RUNNING'::"ScheduledTaskOccurrenceState"
          OR "leaseExpiresAt" > ${now})::integer AS "running",
        min("scheduledFor") FILTER (WHERE "state" = 'PENDING'::"ScheduledTaskOccurrenceState") AS "oldestDueAt"
      FROM "ScheduledTaskOccurrence"
      WHERE "state" IN ('PENDING'::"ScheduledTaskOccurrenceState", 'RUNNING'::"ScheduledTaskOccurrenceState")
    ), failures AS (
      SELECT count(*)::integer AS "failed"
      FROM "ScheduledTaskOccurrence"
      WHERE "state" = 'FAILED'::"ScheduledTaskOccurrenceState" AND "finishedAt" >= ${since}
    ), due AS (
      SELECT count(*)::integer AS "dueTasks", min("nextRunAt") AS "oldestDueAt"
      FROM "ScheduledTask"
      WHERE "status" = 'ACTIVE'::"ScheduledTaskStatus" AND "nextRunAt" <= ${now}
    )
    SELECT
      occurrences."waiting" + due."dueTasks" AS "waiting",
      occurrences."running",
      failures."failed",
      LEAST(occurrences."oldestDueAt", due."oldestDueAt") AS "oldestDueAt"
    FROM occurrences CROSS JOIN failures CROSS JOIN due
  `,
  // Exactly the Memory card's queue; its failures stay on that card.
  memory: ({ now }) => Prisma.sql`
    SELECT memory_queue."waiting", memory_queue."inProgress" AS "running", NULL::integer AS "failed",
      memory_queue."oldestQueuedAt" AS "oldestDueAt"
    FROM (${adminMemoryQueueSql(now)}) AS memory_queue
  `,
  // Only installation servers that are not archived are ever claimed.
  mcp_activation: ({ since }) => Prisma.sql`
    SELECT
      count(*) FILTER (WHERE job."stage" <> 'failed'::"McpActivationStage" AND job."leaseId" IS NULL)::integer AS "waiting",
      count(*) FILTER (WHERE job."stage" <> 'failed'::"McpActivationStage" AND job."leaseId" IS NOT NULL)::integer AS "running",
      count(*) FILTER (WHERE job."stage" = 'failed'::"McpActivationStage")::integer AS "failed",
      min(job."requestedAt") FILTER (WHERE job."stage" <> 'failed'::"McpActivationStage") AS "oldestDueAt"
    FROM "McpActivationJob" AS job
    INNER JOIN "McpServer" AS server
      ON server."id" = job."serverId" AND server."archivedAt" IS NULL AND server."ownerUserId" IS NULL
    WHERE job."stage" IN (
        'queued'::"McpActivationStage", 'connecting'::"McpActivationStage",
        'discovering_tools'::"McpActivationStage", 'publishing'::"McpActivationStage"
      )
      OR (job."stage" = 'failed'::"McpActivationStage" AND job."updatedAt" >= ${since})
  `,
  // Completed cleanups are deleted; FAILED waits for its retry.
  workspace_cleanup: ({ since }) => Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "state" <> 'RUNNING'::"WorkspaceCleanupState")::integer AS "waiting",
      count(*) FILTER (WHERE "state" = 'RUNNING'::"WorkspaceCleanupState")::integer AS "running",
      count(*) FILTER (WHERE "lastErrorCode" IS NOT NULL AND "lastAttemptAt" >= ${since})::integer AS "failed",
      min("createdAt") AS "oldestDueAt"
    FROM "WorkspaceCleanupJob"
    WHERE "state" IN (
      'PENDING'::"WorkspaceCleanupState", 'RUNNING'::"WorkspaceCleanupState", 'FAILED'::"WorkspaceCleanupState"
    )
  `,
  // The Knowledge operations card's pending deletions (every unfinished state)
  // and their oldest creation time; blocked jobs wait for an administrator.
  knowledge_deletion: ({ since }) => Prisma.sql`
    SELECT
      count(*) FILTER (WHERE "state" <> 'RUNNING'::"KnowledgeDeletionState")::integer AS "waiting",
      count(*) FILTER (WHERE "state" = 'RUNNING'::"KnowledgeDeletionState")::integer AS "running",
      count(*) FILTER (WHERE "lastErrorCode" IS NOT NULL AND "lastAttemptAt" >= ${since})::integer AS "failed",
      min("createdAt") AS "oldestDueAt"
    FROM "KnowledgeDeletionJob"
    WHERE "state" IN (
      'PENDING'::"KnowledgeDeletionState", 'RUNNING'::"KnowledgeDeletionState",
      'RETRY_WAIT'::"KnowledgeDeletionState", 'BLOCKED_REQUIRES_ADMIN'::"KnowledgeDeletionState"
    )
  `,
  // The shared "due" predicate of claims, the prune dry run and the Knowledge
  // operations card: a job a reference still protects is not waiting.
  file_deletion: ({ now, since }) => {
    const claimableBefore = deletionJobClaimableBefore(now);
    return Prisma.sql`
      SELECT
        count(*) FILTER (WHERE work."due")::integer AS "waiting",
        count(*) FILTER (WHERE work."claimedAt" >= ${claimableBefore})::integer AS "running",
        count(*) FILTER (WHERE work."lastErrorCode" IS NOT NULL AND work."lastAttemptAt" >= ${since})::integer AS "failed",
        min(work."createdAt") FILTER (WHERE work."due") AS "oldestDueAt"
      FROM (
        SELECT job."createdAt", job."claimedAt", job."lastErrorCode", job."lastAttemptAt",
          ${dueAttachmentDeletionJobSql({ claimableBefore, now })} AS "due"
        FROM "AttachmentDeletionJob" AS job
      ) AS work
    `;
  }
};

function integer(value: bigint | number, queue: AdminHealthQueueId): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error(`admin_health_queue_count_invalid:${queue}`);
  return converted;
}

function normalize(queue: AdminHealthQueueId, row: CountRow | undefined): AdminHealthQueueCounts {
  if (!row) throw new Error(`admin_health_queue_row_missing:${queue}`);
  const oldestDueAt = row.oldestDueAt === null ? null : new Date(row.oldestDueAt);
  if (oldestDueAt !== null && !Number.isFinite(oldestDueAt.getTime())) throw new Error(`admin_health_queue_time_invalid:${queue}`);
  return {
    waiting: integer(row.waiting, queue),
    running: integer(row.running, queue),
    failed24h: row.failed === null ? null : integer(row.failed, queue),
    oldestDueAt
  };
}

/**
 * Reads the given queues one after another, each in its own short transaction
 * under a statement timeout, so the page holds at most one pooled connection
 * and one slow or failing table only marks its own row unavailable.
 */
export async function readAdminHealthQueueCounts(
  client: AdminHealthQueueClient,
  input: Readonly<{ now: Date; queues: readonly AdminHealthQueueId[]; statementTimeoutMs?: number }>
): Promise<AdminHealthQueueReading[]> {
  const window: Window = { now: input.now, since: new Date(input.now.getTime() - ADMIN_HEALTH_QUEUE_FAILURE_WINDOW_MS) };
  const timeout = String(input.statementTimeoutMs ?? ADMIN_HEALTH_QUEUE_STATEMENT_TIMEOUT_MS);
  const readings: AdminHealthQueueReading[] = [];
  for (const queue of input.queues) {
    try {
      const [, rows] = await client.$transaction([
        client.$executeRaw(Prisma.sql`SELECT set_config('statement_timeout', ${timeout}, true)`),
        client.$queryRaw<CountRow[]>(queueSql[queue](window))
      ]);
      readings.push({ queue, counts: normalize(queue, rows[0]) });
    } catch (error) {
      logEvent("service_operation", { error, subsystem: "admin", stage: "read", outcome: "failed",
        code: "admin_health_failed", prisma_code: databaseFailureCode(error) });
      readings.push({ queue, counts: null });
    }
  }
  return readings;
}
