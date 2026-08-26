import { Prisma, type MemoryJobState, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { enqueueMemoryJob } from "../persistence/jobs";
import {
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../persistence/transaction";
import { loadMemorySourceSnapshot } from "../sourceState";
import {
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexJobFingerprint
} from "./contract";

export const MEMORY_HISTORY_BACKFILL_WINDOW = 4;
export const MEMORY_HISTORY_BACKFILL_MAX_PARALLELISM = 16;
export const MEMORY_HISTORY_BACKFILL_MAX_WINDOW = 64;
const MEMORY_HISTORY_BACKFILL_OWNER_BATCH = 16;

const activeJobStates = Object.freeze([
  "QUEUED",
  "WAITING_FOR_EGRESS_CONSENT",
  "CLAIMED",
  "RETRYABLE_FAILED"
] satisfies readonly MemoryJobState[]);

const reusableJobStates = Object.freeze([
  "QUEUED",
  "WAITING_FOR_EGRESS_CONSENT",
  "RETRYABLE_FAILED",
  "SUCCEEDED",
  "STALE",
  "CANCELLED"
] satisfies readonly MemoryJobState[]);

type BackfillCandidate = Readonly<{
  chatId: string;
  updatedAt: Date;
}>;

type ProgressRow = Readonly<{
  completedChats: number;
  totalChats: number;
}>;

type OwnerRow = Readonly<{ userId: string }>;

export type MemoryHistoryIndexingProgress = Readonly<{
  completedChats: number;
  state: "DISABLED" | "INDEXING" | "READY";
  totalChats: number;
}>;

export type MemoryHistoryBackfillSeedResult = Readonly<{
  activeJobs: number;
  enqueuedJobs: number;
}>;

export function resolveMemoryHistoryBackfillWindow(
  maxJobParallelPerUser: number
): number {
  if (!Number.isSafeInteger(maxJobParallelPerUser) || maxJobParallelPerUser < 1 ||
    maxJobParallelPerUser > MEMORY_HISTORY_BACKFILL_MAX_PARALLELISM) {
    throw new Error("memory_history_backfill_window_invalid");
  }
  // Keep a bounded backlog behind each per-user worker. History jobs have
  // heterogeneous provider latency, so a window equal to worker parallelism
  // drains to a few stragglers before the next reconciliation pass can seed
  // work. The default four-job depth is retained as the queue depth per
  // worker, while both configured worker parallelism and the backlog remain
  // independently bounded.
  return Math.min(
    MEMORY_HISTORY_BACKFILL_MAX_WINDOW,
    maxJobParallelPerUser * MEMORY_HISTORY_BACKFILL_WINDOW
  );
}

let lastReconciledOwnerUserId: string | null = null;

function eligibleHistorySourceFromSql(): Prisma.Sql {
  return Prisma.sql`
    FROM "Chat" AS chat
    INNER JOIN "Message" AS leaf
      ON leaf."chatId" = chat."id"
     AND leaf."id" = chat."activeLeafMessageId"
     AND leaf."role" = 'assistant'
     AND leaf."status" = 'complete'::"MessageStatus"
  `;
}

function eligibleHistorySourceWhereSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    chat."userId" = ${userId}
    AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
    AND chat."projectId" IS NULL
  `;
}

function checkpointMatchesSourceSql(): Prisma.Sql {
  return Prisma.sql`
    checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
    AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
    AND checkpoint."activeLeafMessageId" = chat."activeLeafMessageId"
    AND checkpoint."branchGeneration" = chat."memoryBranchGeneration"
    AND checkpoint."sourceRevision" = chat."memorySourceRevision"
    AND checkpoint."lastIndexedMessageId" = chat."activeLeafMessageId"
  `;
}

async function currentBackfillCandidates(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  limit: number
): Promise<readonly BackfillCandidate[]> {
  if (limit <= 0) return [];
  return tx.$queryRaw<BackfillCandidate[]>(Prisma.sql`
    SELECT chat."id" AS "chatId", chat."updatedAt"
    ${eligibleHistorySourceFromSql()}
    WHERE ${eligibleHistorySourceWhereSql(settings.userId)}
      -- Destructive clear/reset barriers suppress a source with no settled
      -- post-clear leaf. Non-destructive setting pauses live in interval rows
      -- and are applied per message by the indexer, so A-before can rebuild.
      AND leaf."createdAt" > COALESCE((
        SELECT MAX(barrier."sourceCreatedAtCutoff")
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = chat."userId"
          AND barrier."explicitOverrideAllowed" = FALSE
          AND barrier."kind" IN (
            'ALL_REUSABLE'::"MemorySourceBarrierKind",
            'HISTORY_INDEX'::"MemorySourceBarrierKind"
          )
      ), TO_TIMESTAMP(0))
      AND NOT EXISTS (
        SELECT 1
        FROM "ChatMemoryCheckpoint" AS checkpoint
        WHERE checkpoint."userId" = chat."userId"
          AND checkpoint."chatId" = chat."id"
          AND ${checkpointMatchesSourceSql()}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryJob" AS job
        WHERE job."userId" = chat."userId"
          AND job."kind" = 'INDEX_HISTORY'::"MemoryJobKind"
          AND job."state" IN (
            'QUEUED'::"MemoryJobState",
            'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState",
            'CLAIMED'::"MemoryJobState",
            'RETRYABLE_FAILED'::"MemoryJobState"
          )
          AND job."memoryGenerationSnapshot" = ${settings.memoryGeneration}
          AND job."chatId" = chat."id"
          AND job."activeLeafMessageId" = chat."activeLeafMessageId"
          AND job."branchGeneration" = chat."memoryBranchGeneration"
          AND job."sourceRevision" = chat."memorySourceRevision"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryJob" AS terminal_job
        WHERE terminal_job."userId" = chat."userId"
          AND terminal_job."kind" = 'INDEX_HISTORY'::"MemoryJobKind"
          AND terminal_job."state" = 'TERMINAL_FAILED'::"MemoryJobState"
          AND terminal_job."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
          AND terminal_job."chatId" = chat."id"
          AND terminal_job."activeLeafMessageId" = chat."activeLeafMessageId"
          AND terminal_job."branchGeneration" = chat."memoryBranchGeneration"
          AND terminal_job."sourceRevision" = chat."memorySourceRevision"
      )
    ORDER BY chat."updatedAt" DESC, chat."id" DESC
    LIMIT ${limit}
  `);
}

async function reviveHistoryJob(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  jobId: string,
  nextAttemptAt: Date,
  now: Date
): Promise<boolean> {
  const revived = await tx.memoryJob.updateMany({
    data: {
      acceptedResultHash: null,
      attemptCount: 0,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      nextAttemptAt,
      stage: null,
      state: "QUEUED",
      updatedAt: now
    },
    where: {
      id: jobId,
      state: { in: [...reusableJobStates] },
      userId: settings.userId
    }
  });
  return revived.count === 1;
}

export async function seedMemoryHistoryBackfill(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  options: Readonly<{ now?: Date; window?: number }> = {}
): Promise<MemoryHistoryBackfillSeedResult> {
  const window = options.window ?? MEMORY_HISTORY_BACKFILL_WINDOW;
  if (!Number.isSafeInteger(window) || window < 1 ||
    window > MEMORY_HISTORY_BACKFILL_MAX_WINDOW) {
    throw new Error("memory_history_backfill_window_invalid");
  }
  if (!settings.useMemoryFacts || !settings.referenceChatHistory) {
    return Object.freeze({ activeJobs: 0, enqueuedJobs: 0 });
  }
  const activeJobs = await tx.memoryJob.count({
    where: {
      kind: "INDEX_HISTORY",
      memoryGenerationSnapshot: settings.memoryGeneration,
      state: { in: [...activeJobStates] },
      userId: settings.userId
    }
  });
  const capacity = Math.max(0, window - activeJobs);
  const candidates = await currentBackfillCandidates(tx, settings, capacity);
  const now = options.now ?? new Date();
  let enqueuedJobs = 0;

  for (const [ordinal, candidate] of candidates.entries()) {
    const source = await loadMemorySourceSnapshot(tx, {
      chatId: candidate.chatId,
      lock: "NONE",
      personalOnly: true,
      userId: settings.userId
    });
    if (
      !source ||
      source.memoryMode !== "NORMAL" ||
      source.activeLeafMessageId === null
    ) {
      continue;
    }
    const nextAttemptAt = new Date(
      now.getTime() - Math.max(1, candidates.length - ordinal)
    );
    const job = await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryHistoryIndexJobFingerprint(source),
      kind: "INDEX_HISTORY",
      nextAttemptAt,
      pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
      source: {
        activeLeafMessageId: source.activeLeafMessageId,
        branchGeneration: source.memoryBranchGeneration,
        chatId: source.id,
        sourceHash: source.sourceHash,
        sourceRevision: source.memorySourceRevision
      }
    });
    if (job.created) {
      enqueuedJobs += 1;
      continue;
    }
    if (await reviveHistoryJob(
      tx,
      settings,
      job.id,
      nextAttemptAt,
      now
    )) {
      enqueuedJobs += 1;
    }
  }
  return Object.freeze({ activeJobs, enqueuedJobs });
}

export async function authorizeMemoryHistoryTerminalRetries(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  now = new Date()
): Promise<number> {
  if (!settings.useMemoryFacts || !settings.referenceChatHistory) return 0;
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryJob" AS job
    SET
      "state" = 'STALE'::"MemoryJobState",
      "updatedAt" = ${now}
    FROM "Chat" AS chat
    INNER JOIN "Message" AS leaf
      ON leaf."chatId" = chat."id"
     AND leaf."id" = chat."activeLeafMessageId"
     AND leaf."role" = 'assistant'
     AND leaf."status" = 'complete'::"MessageStatus"
    WHERE job."userId" = ${settings.userId}
      AND job."kind" = 'INDEX_HISTORY'::"MemoryJobKind"
      AND job."state" = 'TERMINAL_FAILED'::"MemoryJobState"
      AND job."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND job."userId" = chat."userId"
      AND job."chatId" = chat."id"
      AND job."activeLeafMessageId" = chat."activeLeafMessageId"
      AND job."branchGeneration" = chat."memoryBranchGeneration"
      AND job."sourceRevision" = chat."memorySourceRevision"
      AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
  `);
  return updated;
}

export async function readMemoryHistoryIndexingProgress(
  client: PrismaClient,
  userId: string,
  referenceChatHistory: boolean,
  memoryEnabled = true
): Promise<MemoryHistoryIndexingProgress> {
  const rows = await client.$queryRaw<ProgressRow[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE ${checkpointMatchesSourceSql()})::integer
        AS "completedChats",
      COUNT(*)::integer AS "totalChats"
    ${eligibleHistorySourceFromSql()}
    LEFT JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chat."userId"
     AND checkpoint."chatId" = chat."id"
    WHERE ${eligibleHistorySourceWhereSql(userId)}
  `);
  const completedChats = rows[0]?.completedChats ?? 0;
  const totalChats = rows[0]?.totalChats ?? 0;
  return Object.freeze({
    completedChats,
    state: !memoryEnabled || !referenceChatHistory
      ? "DISABLED"
      : completedChats < totalChats
        ? "INDEXING"
        : "READY",
    totalChats
  });
}

async function listBackfillOwners(
  client: PrismaClient,
  limit: number
): Promise<readonly string[]> {
  const after = lastReconciledOwnerUserId === null
    ? await client.$queryRaw<OwnerRow[]>(Prisma.sql`
        SELECT settings."userId"
        FROM "UserMemorySettings" AS settings
        INNER JOIN "User" AS owner_user ON owner_user."id" = settings."userId"
        WHERE settings."useMemoryFacts" = TRUE
          AND settings."referenceChatHistory" = TRUE
          AND owner_user."status" = 'active'::"UserStatus"
        ORDER BY settings."userId"
        LIMIT ${limit}
      `)
    : await client.$queryRaw<OwnerRow[]>(Prisma.sql`
        SELECT settings."userId"
        FROM "UserMemorySettings" AS settings
        INNER JOIN "User" AS owner_user ON owner_user."id" = settings."userId"
        WHERE settings."useMemoryFacts" = TRUE
          AND settings."referenceChatHistory" = TRUE
          AND owner_user."status" = 'active'::"UserStatus"
          AND settings."userId" > ${lastReconciledOwnerUserId}
        ORDER BY settings."userId"
        LIMIT ${limit}
      `);
  const remaining = limit - after.length;
  const wrapped = remaining > 0 && lastReconciledOwnerUserId !== null
    ? await client.$queryRaw<OwnerRow[]>(Prisma.sql`
        SELECT settings."userId"
        FROM "UserMemorySettings" AS settings
        INNER JOIN "User" AS owner_user ON owner_user."id" = settings."userId"
        WHERE settings."useMemoryFacts" = TRUE
          AND settings."referenceChatHistory" = TRUE
          AND owner_user."status" = 'active'::"UserStatus"
          AND settings."userId" <= ${lastReconciledOwnerUserId}
        ORDER BY settings."userId"
        LIMIT ${remaining}
      `)
    : [];
  const owners = [...after, ...wrapped].map((row) => row.userId);
  lastReconciledOwnerUserId = owners.at(-1) ?? null;
  return owners;
}

export async function reconcileMemoryHistoryBackfills(
  client: PrismaClient = prisma,
  window = MEMORY_HISTORY_BACKFILL_WINDOW
): Promise<number> {
  if (!Number.isSafeInteger(window) || window < 1 ||
    window > MEMORY_HISTORY_BACKFILL_MAX_WINDOW) {
    throw new Error("memory_history_backfill_window_invalid");
  }
  const owners = await listBackfillOwners(client, MEMORY_HISTORY_BACKFILL_OWNER_BATCH);
  let enqueuedJobs = 0;
  for (const userId of owners) {
    try {
      const result = await withLockedMemoryTransaction(client, userId, (tx, settings) =>
        seedMemoryHistoryBackfill(tx, settings, { window }));
      enqueuedJobs += result.enqueuedJobs;
    } catch {
      // A later coordinator pass retries owner-local reconciliation. Durable
      // queue state remains authoritative and no other owner is held back.
    }
  }
  return enqueuedJobs;
}
