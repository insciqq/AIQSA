import {
  Prisma,
  type MemoryDeletionOperation,
  type MemoryJobKind,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import { isMemoryCoordinatorErrorCode } from "./errors";
import { memorySourceJobSnapshotMatches } from "../sourceState";
import type {
  MemoryDeletionApply,
  MemoryDeletionClaim,
  MemoryJobApply,
  MemoryJobClaim,
  MemoryJobGateDecision,
  MemoryWaitingJob
} from "./types";

const JOB_CURSOR = "memory-job";
const DELETION_CURSOR = "memory-delete";
const sha256 = /^[a-f0-9]{64}$/u;
const safeStage = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

type JobClaimRow = Omit<MemoryJobClaim, "recoveredLease"> & {
  priorState: string;
};

type DeletionClaimRow = Omit<
  MemoryDeletionClaim,
  "recoveredLease" | "resumedFromBlocked"
> & {
  priorState: string;
};

type WaitingJobRow = MemoryWaitingJob;

type FairnessCursorRow = Readonly<{
  lastGrantedOwnerUserId: string | null;
}>;

export type MemoryCoordinatorRepository = Readonly<{
  cancelUnavailableJobOwners(input: {
    kinds: readonly MemoryJobKind[];
    now: Date;
  }): Promise<number>;
  claimDeletion(input: {
    claimToken: string;
    leaseExpiresAt: Date;
    now: Date;
    operations: readonly MemoryDeletionOperation[];
  }): Promise<MemoryDeletionClaim | null>;
  claimJob(input: {
    claimToken: string;
    kinds: readonly MemoryJobKind[];
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<MemoryJobClaim | null>;
  commitDeletionSuccess(input: {
    apply?: MemoryDeletionApply;
    claim: MemoryDeletionClaim;
    now: Date;
  }): Promise<boolean>;
  commitJobSuccess(input: {
    acceptedResultHash: string;
    apply?: MemoryJobApply;
    claim: MemoryJobClaim;
    now: Date;
    stage: string | null;
  }): Promise<boolean>;
  heartbeatDeletion(input: {
    claim: MemoryDeletionClaim;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  heartbeatJob(input: {
    claim: MemoryJobClaim;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  listWaitingJobs(input: {
    kinds: readonly MemoryJobKind[];
    limit: number;
  }): Promise<readonly MemoryWaitingJob[]>;
  requeueDueJobs(input: {
    kinds: readonly MemoryJobKind[];
    now: Date;
  }): Promise<number>;
  resolveWaitingJob(input: {
    decision: MemoryJobGateDecision;
    job: MemoryWaitingJob;
    now: Date;
  }): Promise<boolean>;
  retryDeletion(input: {
    blocked: boolean;
    claim: MemoryDeletionClaim;
    errorCode: string;
    nextAttemptAt: Date;
    now: Date;
  }): Promise<boolean>;
  retryJob(input: {
    claim: MemoryJobClaim;
    errorCode: string;
    nextAttemptAt: Date;
    now: Date;
  }): Promise<boolean>;
  setJobStage(input: {
    claim: MemoryJobClaim;
    now: Date;
    stage: string;
  }): Promise<boolean>;
  settleJobGate(input: {
    claim: MemoryJobClaim;
    decision: Exclude<MemoryJobGateDecision, { status: "READY" }>;
    now: Date;
  }): Promise<boolean>;
  terminalJob(input: {
    claim: MemoryJobClaim;
    errorCode: string;
    now: Date;
  }): Promise<boolean>;
}>;

function jobKindList(kinds: readonly MemoryJobKind[]): Prisma.Sql {
  return Prisma.join(kinds.map((kind) => Prisma.sql`${kind}::"MemoryJobKind"`));
}

function deletionOperationList(
  operations: readonly MemoryDeletionOperation[]
): Prisma.Sql {
  return Prisma.join(operations.map((operation) =>
    Prisma.sql`${operation}::"MemoryDeletionOperation"`));
}

async function lockFairnessCursor(
  tx: Prisma.TransactionClient,
  pipeline: typeof JOB_CURSOR | typeof DELETION_CURSOR
): Promise<string | null> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DocumentProcessingFairnessCursor" (
      "pipeline", "lastGrantedOwnerUserId", "updatedAt"
    ) VALUES (${pipeline}, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT ("pipeline") DO NOTHING
  `);
  const rows = await tx.$queryRaw<FairnessCursorRow[]>(Prisma.sql`
    SELECT "lastGrantedOwnerUserId"
    FROM "DocumentProcessingFairnessCursor"
    WHERE "pipeline" = ${pipeline}
    FOR UPDATE
  `);
  if (!rows[0]) throw new Error("memory_fairness_cursor_unavailable");
  return rows[0].lastGrantedOwnerUserId;
}

function jobEligibility(
  kinds: readonly MemoryJobKind[],
  now: Date,
  ownerRange: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    ${ownerRange}
    AND job."kind" IN (${jobKindList(kinds)})
    AND owner_user."status" = 'active'::"UserStatus"
    AND (
      (
        job."state" = 'QUEUED'::"MemoryJobState"
        AND (job."nextAttemptAt" IS NULL OR job."nextAttemptAt" <= ${now})
      )
      OR (
        job."state" = 'CLAIMED'::"MemoryJobState"
        AND job."leaseExpiresAt" <= ${now}
      )
    )
  `;
}

function jobCandidateCtes(
  kinds: readonly MemoryJobKind[],
  now: Date,
  lastOwner: string | null
): Prisma.Sql {
  const selection = (range: Prisma.Sql) => Prisma.sql`
    SELECT job."id", job."state"::text AS "priorState"
    FROM "MemoryJob" AS job
    INNER JOIN "User" AS owner_user ON owner_user."id" = job."userId"
    WHERE ${jobEligibility(kinds, now, range)}
    ORDER BY
      job."userId",
      COALESCE(job."nextAttemptAt", job."createdAt"),
      job."createdAt",
      job."id"
    LIMIT 1
    FOR UPDATE OF job SKIP LOCKED
  `;
  if (lastOwner === null) {
    return Prisma.sql`candidate AS MATERIALIZED (
      ${selection(Prisma.sql`TRUE`)}
    )`;
  }
  return Prisma.sql`
    after_cursor AS MATERIALIZED (
      ${selection(Prisma.sql`job."userId" > ${lastOwner}`)}
    ),
    wrapped AS MATERIALIZED (
      SELECT job."id", job."state"::text AS "priorState"
      FROM "MemoryJob" AS job
      INNER JOIN "User" AS owner_user ON owner_user."id" = job."userId"
      WHERE NOT EXISTS (SELECT 1 FROM after_cursor)
        AND ${jobEligibility(
          kinds,
          now,
          Prisma.sql`job."userId" <= ${lastOwner}`
        )}
      ORDER BY
        job."userId",
        COALESCE(job."nextAttemptAt", job."createdAt"),
        job."createdAt",
        job."id"
      LIMIT 1
      FOR UPDATE OF job SKIP LOCKED
    ),
    candidate AS MATERIALIZED (
      SELECT "id", "priorState" FROM after_cursor
      UNION ALL
      SELECT "id", "priorState" FROM wrapped
    )
  `;
}

function deletionEligibility(
  operations: readonly MemoryDeletionOperation[],
  now: Date,
  ownerRange: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    ${ownerRange}
    AND deletion."operation" IN (${deletionOperationList(operations)})
    AND (
      (
        deletion."state" IN (
          'PENDING'::"MemoryDeletionState",
          'RETRY_WAIT'::"MemoryDeletionState",
          'BLOCKED_REQUIRES_ADMIN'::"MemoryDeletionState"
        )
        AND (
          deletion."nextAttemptAt" IS NULL
          OR deletion."nextAttemptAt" <= ${now}
        )
      )
      OR (
        deletion."state" = 'RUNNING'::"MemoryDeletionState"
        AND deletion."leaseExpiresAt" <= ${now}
      )
    )
  `;
}

function deletionCandidateCtes(
  operations: readonly MemoryDeletionOperation[],
  now: Date,
  lastOwner: string | null
): Prisma.Sql {
  const selection = (range: Prisma.Sql) => Prisma.sql`
    SELECT deletion."id", deletion."state"::text AS "priorState"
    FROM "MemoryDeletionOutbox" AS deletion
    WHERE ${deletionEligibility(operations, now, range)}
    ORDER BY
      deletion."userId",
      COALESCE(deletion."nextAttemptAt", deletion."createdAt"),
      deletion."createdAt",
      deletion."id"
    LIMIT 1
    FOR UPDATE OF deletion SKIP LOCKED
  `;
  if (lastOwner === null) {
    return Prisma.sql`candidate AS MATERIALIZED (
      ${selection(Prisma.sql`TRUE`)}
    )`;
  }
  return Prisma.sql`
    after_cursor AS MATERIALIZED (
      ${selection(Prisma.sql`deletion."userId" > ${lastOwner}`)}
    ),
    wrapped AS MATERIALIZED (
      SELECT deletion."id", deletion."state"::text AS "priorState"
      FROM "MemoryDeletionOutbox" AS deletion
      WHERE NOT EXISTS (SELECT 1 FROM after_cursor)
        AND ${deletionEligibility(
          operations,
          now,
          Prisma.sql`deletion."userId" <= ${lastOwner}`
        )}
      ORDER BY
        deletion."userId",
        COALESCE(deletion."nextAttemptAt", deletion."createdAt"),
        deletion."createdAt",
        deletion."id"
      LIMIT 1
      FOR UPDATE OF deletion SKIP LOCKED
    ),
    candidate AS MATERIALIZED (
      SELECT "id", "priorState" FROM after_cursor
      UNION ALL
      SELECT "id", "priorState" FROM wrapped
    )
  `;
}

function validStage(stage: string | null): boolean {
  return stage === null || safeStage.test(stage);
}

function validDecision(decision: MemoryJobGateDecision): boolean {
  return decision.status === "READY" || isMemoryCoordinatorErrorCode(decision.errorCode);
}

export function createPrismaMemoryCoordinatorRepository(
  client: PrismaClient = prisma
): MemoryCoordinatorRepository {
  return Object.freeze({
    async claimJob(input) {
      if (input.kinds.length === 0) return null;
      return client.$transaction(async (tx) => {
        const lastOwner = await lockFairnessCursor(tx, JOB_CURSOR);
        const candidateCtes = jobCandidateCtes(input.kinds, input.now, lastOwner);
        const rows = await tx.$queryRaw<JobClaimRow[]>(Prisma.sql`
          WITH ${candidateCtes}, claimed AS (
            UPDATE "MemoryJob" AS job
            SET
              "state" = 'CLAIMED'::"MemoryJobState",
              "attemptCount" = job."attemptCount" + 1,
              "leaseToken" = ${input.claimToken},
              "leaseExpiresAt" = ${input.leaseExpiresAt},
              "nextAttemptAt" = NULL,
              "errorCode" = NULL,
              "errorMessage" = NULL,
              "updatedAt" = ${input.now}
            FROM candidate
            WHERE job."id" = candidate."id"
            RETURNING
              job."id", job."userId", job."chatId", job."activeLeafMessageId",
              job."branchGeneration", job."sourceRevision", job."sourceHash",
              job."kind"::text AS "kind", job."stage", job."attemptCount",
              job."pipelineVersion", job."memoryGenerationSnapshot",
              job."memoryRevisionSnapshot", job."idempotencyFingerprint",
              job."leaseToken" AS "claimToken", job."leaseExpiresAt",
              candidate."priorState"
          )
          SELECT * FROM claimed
        `);
        const row = rows[0];
        if (!row) return null;
        const advanced = await tx.$executeRaw(Prisma.sql`
          UPDATE "DocumentProcessingFairnessCursor"
          SET "lastGrantedOwnerUserId" = ${row.userId}, "updatedAt" = ${input.now}
          WHERE "pipeline" = ${JOB_CURSOR}
        `);
        if (advanced !== 1) throw new Error("memory_job_fairness_cursor_lost");
        const { priorState, ...claim } = row;
        return {
          ...claim,
          recoveredLease: priorState === "CLAIMED"
        } as MemoryJobClaim;
      });
    },

    async heartbeatJob(input) {
      const updated = await client.$executeRaw(Prisma.sql`
        UPDATE "MemoryJob" AS job
        SET "leaseExpiresAt" = ${input.leaseExpiresAt}, "updatedAt" = ${input.now}
        WHERE job."id" = ${input.claim.id}
          AND job."userId" = ${input.claim.userId}
          AND job."state" = 'CLAIMED'::"MemoryJobState"
          AND job."leaseToken" = ${input.claim.claimToken}
          AND job."leaseExpiresAt" > ${input.now}
          AND EXISTS (
            SELECT 1 FROM "User" AS owner_user
            WHERE owner_user."id" = job."userId"
              AND owner_user."status" = 'active'::"UserStatus"
          )
      `);
      return updated === 1;
    },

    async setJobStage(input) {
      if (!safeStage.test(input.stage)) return false;
      const updated = await client.memoryJob.updateMany({
        data: { stage: input.stage, updatedAt: input.now },
        where: {
          id: input.claim.id,
          leaseExpiresAt: { gt: input.now },
          leaseToken: input.claim.claimToken,
          state: "CLAIMED",
          userId: input.claim.userId
        }
      });
      return updated.count === 1;
    },

    async settleJobGate(input) {
      if (!validDecision(input.decision)) return false;
      const terminal = input.decision.status === "STALE" ||
        input.decision.status === "CANCELLED";
      const updated = await client.memoryJob.updateMany({
        data: {
          completedAt: terminal ? input.now : null,
          errorCode: input.decision.errorCode,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: null,
          state: input.decision.status,
          updatedAt: input.now
        },
        where: {
          id: input.claim.id,
          leaseExpiresAt: { gt: input.now },
          leaseToken: input.claim.claimToken,
          state: "CLAIMED",
          userId: input.claim.userId
        }
      });
      return updated.count === 1;
    },

    async retryJob(input) {
      if (!isMemoryCoordinatorErrorCode(input.errorCode)) return false;
      const updated = await client.memoryJob.updateMany({
        data: {
          errorCode: input.errorCode,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: input.nextAttemptAt,
          state: "RETRYABLE_FAILED",
          updatedAt: input.now
        },
        where: {
          id: input.claim.id,
          leaseExpiresAt: { gt: input.now },
          leaseToken: input.claim.claimToken,
          state: "CLAIMED",
          userId: input.claim.userId
        }
      });
      return updated.count === 1;
    },

    async terminalJob(input) {
      if (!isMemoryCoordinatorErrorCode(input.errorCode)) return false;
      const updated = await client.memoryJob.updateMany({
        data: {
          completedAt: input.now,
          errorCode: input.errorCode,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: null,
          state: "TERMINAL_FAILED",
          updatedAt: input.now
        },
        where: {
          id: input.claim.id,
          leaseExpiresAt: { gt: input.now },
          leaseToken: input.claim.claimToken,
          state: "CLAIMED",
          userId: input.claim.userId
        }
      });
      return updated.count === 1;
    },

    async commitJobSuccess(input) {
      if (!sha256.test(input.acceptedResultHash) || !validStage(input.stage)) return false;
      return client.$transaction(async (tx) => {
        const sourceMatches = await memorySourceJobSnapshotMatches(tx, input.claim);
        const lease = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "MemoryJob"
          WHERE "id" = ${input.claim.id}
            AND "userId" = ${input.claim.userId}
            AND "state" = 'CLAIMED'::"MemoryJobState"
            AND "leaseToken" = ${input.claim.claimToken}
            AND "leaseExpiresAt" > ${input.now}
            AND EXISTS (
              SELECT 1 FROM "User" AS owner_user
              WHERE owner_user."id" = "MemoryJob"."userId"
                AND owner_user."status" = 'active'::"UserStatus"
            )
          FOR UPDATE
        `);
        if (!lease[0]) return false;
        if (!sourceMatches) {
          const staled = await tx.memoryJob.updateMany({
            data: {
              completedAt: input.now,
              errorCode: "memory_source_stale",
              errorMessage: null,
              leaseExpiresAt: null,
              leaseToken: null,
              nextAttemptAt: null,
              state: "STALE",
              updatedAt: input.now
            },
            where: {
              id: input.claim.id,
              leaseExpiresAt: { gt: input.now },
              leaseToken: input.claim.claimToken,
              state: "CLAIMED",
              userId: input.claim.userId
            }
          });
          return staled.count === 1;
        }
        await input.apply?.(tx, input.claim);
        const updated = await tx.memoryJob.updateMany({
          data: {
            acceptedResultHash: input.acceptedResultHash,
            completedAt: input.now,
            errorCode: null,
            errorMessage: null,
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            stage: input.stage,
            state: "SUCCEEDED",
            updatedAt: input.now
          },
          where: {
            id: input.claim.id,
            leaseExpiresAt: { gt: input.now },
            leaseToken: input.claim.claimToken,
            state: "CLAIMED",
            userId: input.claim.userId
          }
        });
        return updated.count === 1;
      });
    },

    async requeueDueJobs(input) {
      if (input.kinds.length === 0) return 0;
      const updated = await client.memoryJob.updateMany({
        data: { nextAttemptAt: null, state: "QUEUED", updatedAt: input.now },
        where: {
          kind: { in: [...input.kinds] },
          nextAttemptAt: { lte: input.now },
          state: "RETRYABLE_FAILED"
        }
      });
      return updated.count;
    },

    async cancelUnavailableJobOwners(input) {
      if (input.kinds.length === 0) return 0;
      return client.$executeRaw(Prisma.sql`
        UPDATE "MemoryJob" AS job
        SET
          "state" = 'CANCELLED'::"MemoryJobState",
          "completedAt" = ${input.now},
          "leaseToken" = NULL,
          "leaseExpiresAt" = NULL,
          "nextAttemptAt" = NULL,
          "errorCode" = 'memory_owner_unavailable',
          "updatedAt" = ${input.now}
        WHERE job."kind" IN (${jobKindList(input.kinds)})
          AND (
            job."state" IN (
              'QUEUED'::"MemoryJobState",
              'RETRYABLE_FAILED'::"MemoryJobState",
              'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
            )
            OR (
              job."state" = 'CLAIMED'::"MemoryJobState"
              AND job."leaseExpiresAt" <= ${input.now}
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM "User" AS owner_user
            WHERE owner_user."id" = job."userId"
              AND owner_user."status" = 'active'::"UserStatus"
          )
      `);
    },

    async listWaitingJobs(input) {
      if (input.kinds.length === 0) return [];
      return client.$queryRaw<WaitingJobRow[]>(Prisma.sql`
        SELECT
          job."id", job."userId", job."chatId", job."activeLeafMessageId",
          job."branchGeneration", job."sourceRevision", job."sourceHash",
          job."kind"::text AS "kind", job."stage", job."attemptCount",
          job."pipelineVersion", job."memoryGenerationSnapshot",
          job."memoryRevisionSnapshot", job."idempotencyFingerprint"
        FROM "MemoryJob" AS job
        INNER JOIN "User" AS owner_user ON owner_user."id" = job."userId"
        WHERE job."kind" IN (${jobKindList(input.kinds)})
          AND job."state" = 'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
          AND owner_user."status" = 'active'::"UserStatus"
        ORDER BY job."createdAt", job."id"
        LIMIT ${input.limit}
      `);
    },

    async resolveWaitingJob(input) {
      if (!validDecision(input.decision)) return false;
      if (input.decision.status === "WAITING_FOR_EGRESS_CONSENT") return false;
      const terminal = input.decision.status === "STALE" ||
        input.decision.status === "CANCELLED";
      const updated = await client.memoryJob.updateMany({
        data: input.decision.status === "READY"
          ? {
              errorCode: null,
              nextAttemptAt: null,
              state: "QUEUED",
              updatedAt: input.now
            }
          : {
              completedAt: input.now,
              errorCode: input.decision.errorCode,
              nextAttemptAt: null,
              state: terminal ? input.decision.status : "QUEUED",
              updatedAt: input.now
            },
        where: {
          id: input.job.id,
          state: "WAITING_FOR_EGRESS_CONSENT",
          userId: input.job.userId
        }
      });
      return updated.count === 1;
    },

    async claimDeletion(input) {
      if (input.operations.length === 0) return null;
      return client.$transaction(async (tx) => {
        const lastOwner = await lockFairnessCursor(tx, DELETION_CURSOR);
        const candidateCtes = deletionCandidateCtes(
          input.operations,
          input.now,
          lastOwner
        );
        const rows = await tx.$queryRaw<DeletionClaimRow[]>(Prisma.sql`
          WITH ${candidateCtes}, claimed AS (
            UPDATE "MemoryDeletionOutbox" AS deletion
            SET
              "state" = 'RUNNING'::"MemoryDeletionState",
              "attemptCount" = deletion."attemptCount" + 1,
              "leaseToken" = ${input.claimToken},
              "leaseExpiresAt" = ${input.leaseExpiresAt},
              "nextAttemptAt" = NULL,
              "errorCode" = NULL,
              "updatedAt" = ${input.now}
            FROM candidate
            WHERE deletion."id" = candidate."id"
            RETURNING
              deletion."id", deletion."userId", deletion."operation"::text AS "operation",
              deletion."targetType", deletion."targetId", deletion."memoryGeneration",
              deletion."attemptCount", deletion."leaseToken" AS "claimToken",
              deletion."leaseExpiresAt", candidate."priorState"
          )
          SELECT * FROM claimed
        `);
        const row = rows[0];
        if (!row) return null;
        const advanced = await tx.$executeRaw(Prisma.sql`
          UPDATE "DocumentProcessingFairnessCursor"
          SET "lastGrantedOwnerUserId" = ${row.userId}, "updatedAt" = ${input.now}
          WHERE "pipeline" = ${DELETION_CURSOR}
        `);
        if (advanced !== 1) throw new Error("memory_deletion_fairness_cursor_lost");
        const { priorState, ...claim } = row;
        return {
          ...claim,
          recoveredLease: priorState === "RUNNING",
          resumedFromBlocked: priorState === "BLOCKED_REQUIRES_ADMIN"
        } as MemoryDeletionClaim;
      });
    },

    async heartbeatDeletion(input) {
      const updated = await client.memoryDeletionOutbox.updateMany({
        data: { leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now },
        where: {
          id: input.claim.id,
          leaseExpiresAt: { gt: input.now },
          leaseToken: input.claim.claimToken,
          state: "RUNNING",
          userId: input.claim.userId
        }
      });
      return updated.count === 1;
    },

    async retryDeletion(input) {
      if (!isMemoryCoordinatorErrorCode(input.errorCode)) return false;
      const updated = await client.memoryDeletionOutbox.updateMany({
        data: {
          errorCode: input.errorCode,
          lastAuditAt: input.now,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: input.nextAttemptAt,
          state: input.blocked ? "BLOCKED_REQUIRES_ADMIN" : "RETRY_WAIT",
          updatedAt: input.now
        },
        where: {
          id: input.claim.id,
          leaseExpiresAt: { gt: input.now },
          leaseToken: input.claim.claimToken,
          state: "RUNNING",
          userId: input.claim.userId
        }
      });
      return updated.count === 1;
    },

    async commitDeletionSuccess(input) {
      return client.$transaction(async (tx) => {
        const lease = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "MemoryDeletionOutbox"
          WHERE "id" = ${input.claim.id}
            AND "userId" = ${input.claim.userId}
            AND "state" = 'RUNNING'::"MemoryDeletionState"
            AND "leaseToken" = ${input.claim.claimToken}
            AND "leaseExpiresAt" > ${input.now}
          FOR UPDATE
        `);
        if (!lease[0]) return false;
        await input.apply?.(tx, input.claim);
        const updated = await tx.memoryDeletionOutbox.updateMany({
          data: {
            completedAt: input.now,
            errorCode: null,
            lastAuditAt: input.now,
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            state: "SUCCEEDED",
            updatedAt: input.now
          },
          where: {
            id: input.claim.id,
            leaseExpiresAt: { gt: input.now },
            leaseToken: input.claim.claimToken,
            state: "RUNNING",
            userId: input.claim.userId
          }
        });
        return updated.count === 1;
      });
    }
  });
}
