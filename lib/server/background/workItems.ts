import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Claims on `BackgroundWorkItem`: one row per duty and item, holding the lease of the worker processing the
 * item, its attempts and backoff, and its completion. The obligation is never here (it lives on the item's own
 * rows), so the row only decides who works on an item now and when a failed item may be tried again.
 */

/** A claim outlives the slowest item step (a Workspace VM stop, a batch of object deletes) with a wide margin. */
export const BACKGROUND_WORK_LEASE_MS = 10 * 60 * 1_000;
export const BACKGROUND_WORK_RETRY_BASE_MS = 15 * 1_000;
export const BACKGROUND_WORK_RETRY_MAX_MS = 60 * 60 * 1_000;
/** A completed row answers its owner's status reads for a week, then goes. */
export const BACKGROUND_WORK_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type BackgroundWorkClient = Readonly<{
  $executeRaw: Prisma.TransactionClient["$executeRaw"];
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
}>;

export type BackgroundWorkClaim = Readonly<{
  /** Attempts so far, this one included. */
  attempt: number;
  duty: string;
  itemId: string;
  leaseExpiresAt: Date;
  token: string;
  userId: string;
}>;

const CODE = /^[a-z][a-z0-9_]{0,63}$/u;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertItem(input: Readonly<{ duty: string; itemId: string; now: Date; userId: string }>): void {
  if (
    !CODE.test(input.duty) ||
    input.itemId.length === 0 || input.itemId.length > 256 ||
    input.userId.length === 0 || input.userId.length > 256 ||
    !validDate(input.now)
  ) {
    throw new Error("background_work_item_invalid");
  }
}

/** The backoff after a failed attempt: doubling from the base, capped. */
export function backgroundWorkRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  return Math.min(BACKGROUND_WORK_RETRY_MAX_MS, BACKGROUND_WORK_RETRY_BASE_MS * 2 ** exponent);
}

/**
 * Takes the item for this worker, or returns null when another worker holds a live lease, the item waits out
 * its backoff, or it already completed. One statement: concurrent claimants serialize on the row's key, and
 * only the one whose condition still holds gets it. An expired lease (a crashed worker) is taken over.
 */
export async function claimBackgroundWorkItem(
  client: BackgroundWorkClient,
  input: Readonly<{ duty: string; itemId: string; now: Date; userId: string }>
): Promise<BackgroundWorkClaim | null> {
  assertItem(input);
  const token = randomUUID();
  const leaseExpiresAt = new Date(input.now.getTime() + BACKGROUND_WORK_LEASE_MS);
  const rows = await client.$queryRaw<Array<{ attemptCount: number; userId: string }>>(Prisma.sql`
    INSERT INTO "BackgroundWorkItem" (
      "duty", "itemId", "userId", "leaseToken", "leaseExpiresAt", "attemptCount", "createdAt", "updatedAt"
    )
    VALUES (
      ${input.duty}, ${input.itemId}, ${input.userId}, ${token}, ${leaseExpiresAt}, 1, ${input.now}, ${input.now}
    )
    ON CONFLICT ("duty", "itemId") DO UPDATE SET
      "leaseToken" = EXCLUDED."leaseToken",
      "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
      "attemptCount" = "BackgroundWorkItem"."attemptCount" + 1,
      "nextAttemptAt" = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "BackgroundWorkItem"."completedAt" IS NULL
      AND "BackgroundWorkItem"."userId" = EXCLUDED."userId"
      AND ("BackgroundWorkItem"."leaseToken" IS NULL OR "BackgroundWorkItem"."leaseExpiresAt" <= ${input.now})
      AND ("BackgroundWorkItem"."nextAttemptAt" IS NULL OR "BackgroundWorkItem"."nextAttemptAt" <= ${input.now})
    RETURNING "attemptCount", "userId"
  `);
  const row = rows[0];
  if (!row) return null;
  return Object.freeze({
    attempt: row.attemptCount,
    duty: input.duty,
    itemId: input.itemId,
    leaseExpiresAt,
    token,
    userId: row.userId
  });
}

/**
 * Marks the claimed item completed. Call it inside the transaction that finishes the item, so the completion
 * and the work commit together; false means the lease was lost and the transaction must not commit.
 */
export async function completeBackgroundWorkItem(
  tx: BackgroundWorkClient,
  claim: BackgroundWorkClaim,
  now: Date
): Promise<boolean> {
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "BackgroundWorkItem"
    SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL,
      "lastErrorCode" = NULL, "completedAt" = ${now}, "updatedAt" = ${now}
    WHERE "duty" = ${claim.duty} AND "itemId" = ${claim.itemId} AND "leaseToken" = ${claim.token}
  `);
  return updated === 1;
}

/** Gives the item up after a failed attempt: it may be claimed again once its backoff has passed. */
export async function failBackgroundWorkItem(
  client: BackgroundWorkClient,
  claim: BackgroundWorkClaim,
  input: Readonly<{ code: string; now: Date }>
): Promise<void> {
  const code = CODE.test(input.code) ? input.code : "background_work_failed";
  const nextAttemptAt = new Date(input.now.getTime() + backgroundWorkRetryDelayMs(claim.attempt));
  await client.$executeRaw(Prisma.sql`
    UPDATE "BackgroundWorkItem"
    SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = ${nextAttemptAt},
      "lastErrorCode" = ${code}, "updatedAt" = ${input.now}
    WHERE "duty" = ${claim.duty} AND "itemId" = ${claim.itemId} AND "leaseToken" = ${claim.token}
  `);
}

/**
 * Gives the item up without counting the attempt or waiting (worker shutdown): the next worker may take it at
 * once, so a stop never leaves an item half-claimed until its lease expires.
 */
export async function releaseBackgroundWorkItem(
  client: BackgroundWorkClient,
  claim: BackgroundWorkClaim,
  now: Date
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE "BackgroundWorkItem"
    SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL,
      "attemptCount" = GREATEST("attemptCount" - 1, 0), "updatedAt" = ${now}
    WHERE "duty" = ${claim.duty} AND "itemId" = ${claim.itemId} AND "leaseToken" = ${claim.token}
  `);
}

/**
 * A discovery filter: true when the work row of the item (`itemColumn`) neither holds a live lease, waits out a
 * backoff nor completed, so a pass reads only items it could claim now and a failing item never starves the rest.
 */
export function backgroundWorkItemClaimableSql(
  duty: string,
  itemColumn: Prisma.Sql,
  now: Date
): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "BackgroundWorkItem" AS work
    WHERE work."duty" = ${duty}
      AND work."itemId" = ${itemColumn}
      AND (
        work."completedAt" IS NOT NULL
        OR (work."leaseToken" IS NOT NULL AND work."leaseExpiresAt" > ${now})
        OR work."nextAttemptAt" > ${now}
      )
  )`;
}

/** Removes completed rows of a duty past their retention; bounded by the duty's own volume. */
export async function pruneCompletedBackgroundWorkItems(
  client: BackgroundWorkClient,
  input: Readonly<{ duty: string; now: Date }>
): Promise<number> {
  const cutoff = new Date(input.now.getTime() - BACKGROUND_WORK_COMPLETED_RETENTION_MS);
  return client.$executeRaw(Prisma.sql`
    DELETE FROM "BackgroundWorkItem"
    WHERE "duty" = ${input.duty} AND "completedAt" IS NOT NULL AND "completedAt" < ${cutoff}
  `);
}
