import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ScheduledTaskRunTrigger, ScheduledTaskUnavailableSource } from "../../contracts/scheduledTasks";
import type { ScheduledTaskSettledState } from "../scheduledTasks/runnerPolicy";
import { unavailableSourcesWire } from "../scheduledTasks/sourceHealth";
import { notScheduledRunSql } from "./scheduledRunExclusion";
import type { ValidatedPushSubscription } from "./subscriptionRequest";

/** Devices one account keeps; registering another drops the least recently registered. */
export const BROWSER_PUSH_MAX_SUBSCRIPTIONS_PER_USER = 20;
/** Consecutive failed deliveries after which a subscription is dropped as dead. */
export const BROWSER_PUSH_MAX_CONSECUTIVE_FAILURES = 20;

export type RunPushEvent = Readonly<{
  chatId: string;
  kind: "run";
  status: "complete" | "error";
  title: string;
  userId: string;
}>;

export type OccurrencePushEvent = Readonly<{
  chatId: string | null;
  kind: "occurrence";
  reasonCode: string | null;
  state: ScheduledTaskSettledState;
  taskPauseReason: string | null;
  title: string;
  trigger: ScheduledTaskRunTrigger;
  /** The relevant sources the run could not reach; empty when it was complete. */
  unavailableSources: readonly ScheduledTaskUnavailableSource[];
  userId: string;
}>;

export type BrowserPushEvent = RunPushEvent | OccurrencePushEvent;

export type BrowserPushTarget = Readonly<{ auth: string; endpoint: string; id: string; p256dh: string; sessionId: string }>;

export type BrowserPushDeliveryOutcome = "delivered" | "failed" | "gone";

export type SaveBrowserPushSubscriptionResult = "disabled" | "saved" | "session_inactive";

export interface BrowserPushStore {
  /** Binds the device's subscription to the current account and session, while notifications are on. */
  saveSubscription(
    input: ValidatedPushSubscription & Readonly<{ sessionId: string; userId: string }>,
    now: Date
  ): Promise<SaveBrowserPushSubscriptionResult>;
  deleteSubscription(userId: string, endpoint: string): Promise<void>;
  /** Claims the single push of a finished ordinary chat run when its owner can receive one. */
  claimRun(runId: string, now: Date): Promise<RunPushEvent | null>;
  /** Claims the single push of a settled scheduled occurrence when its owner can receive one. */
  claimOccurrence(occurrenceId: string, now: Date): Promise<OccurrencePushEvent | null>;
  /** The owner's live subscriptions, rechecked at delivery time. */
  listTargets(userId: string, now: Date): Promise<readonly BrowserPushTarget[]>;
  recordDelivery(target: Pick<BrowserPushTarget, "endpoint" | "id">, outcome: BrowserPushDeliveryOutcome, now: Date): Promise<void>;
}

/** The account is active, has notifications on and at least one subscription of a live session. */
function ownerAcceptsSql(userId: Prisma.Sql, now: Date): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "User" AS push_owner
    INNER JOIN "UserSettings" AS push_settings ON push_settings."userId" = push_owner."id"
    WHERE push_owner."id" = ${userId}
      AND push_owner."status" = 'active'::"UserStatus"
      AND push_settings."browserNotificationsEnabled"
      AND EXISTS (
        SELECT 1
        FROM "BrowserPushSubscription" AS push_subscription
        INNER JOIN "AuthSession" AS push_session
          ON push_session."id" = push_subscription."sessionId" AND push_session."userId" = push_subscription."userId"
        WHERE push_subscription."userId" = push_owner."id"
          AND push_session."revokedAt" IS NULL AND push_session."expiresAt" > ${now}
      )
  )`;
}

function trigger(value: string): ScheduledTaskRunTrigger {
  return value === "manual" ? "manual" : "schedule";
}

export function createPrismaBrowserPushStore(prisma: PrismaClient): BrowserPushStore {
  return {
    async saveSubscription(input, now) {
      return prisma.$transaction(async (tx) => {
        // Shares the settings row with the settings writer, which removes every
        // subscription when notifications are turned off.
        const [settings] = await tx.$queryRaw<Array<{ enabled: boolean }>>(Prisma.sql`
          SELECT settings."browserNotificationsEnabled" AS "enabled"
          FROM "UserSettings" AS settings
          INNER JOIN "User" AS account ON account."id" = settings."userId"
          WHERE settings."userId" = ${input.userId} AND account."status" = 'active'::"UserStatus"
          FOR SHARE OF settings
        `);
        if (!settings?.enabled) return "disabled";
        // A concurrent revocation waits for this commit, then its trigger removes the row.
        const [session] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "AuthSession"
          WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
            AND "revokedAt" IS NULL AND "expiresAt" > ${now}
          FOR SHARE
        `);
        if (!session) return "session_inactive";
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "BrowserPushSubscription"
            ("id", "userId", "sessionId", "endpoint", "p256dh", "auth", "createdAt", "updatedAt")
          VALUES (${randomUUID()}, ${input.userId}, ${input.sessionId}, ${input.endpoint}, ${input.p256dh}, ${input.auth}, ${now}, ${now})
          ON CONFLICT ("endpoint") DO UPDATE SET
            "createdAt" = CASE WHEN "BrowserPushSubscription"."userId" = EXCLUDED."userId"
              THEN "BrowserPushSubscription"."createdAt" ELSE EXCLUDED."createdAt" END,
            "lastSuccessAt" = CASE WHEN "BrowserPushSubscription"."userId" = EXCLUDED."userId"
              THEN "BrowserPushSubscription"."lastSuccessAt" ELSE NULL END,
            "userId" = EXCLUDED."userId",
            "sessionId" = EXCLUDED."sessionId",
            "p256dh" = EXCLUDED."p256dh",
            "auth" = EXCLUDED."auth",
            "updatedAt" = EXCLUDED."updatedAt",
            "failureCount" = 0,
            "lastFailureAt" = NULL
        `);
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM "BrowserPushSubscription"
          WHERE "id" IN (
            SELECT "id" FROM "BrowserPushSubscription"
            WHERE "userId" = ${input.userId}
            ORDER BY "updatedAt" DESC, "id" DESC
            OFFSET ${BROWSER_PUSH_MAX_SUBSCRIPTIONS_PER_USER}
          )
        `);
        return "saved";
      });
    },

    async deleteSubscription(userId, endpoint) {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "BrowserPushSubscription" WHERE "userId" = ${userId} AND "endpoint" = ${endpoint}
      `);
    },

    async claimRun(runId, now) {
      const [row] = await prisma.$queryRaw<Array<{ chatId: string; status: string; title: string; userId: string }>>(Prisma.sql`
        WITH event AS (
          SELECT run."id", run."userId", run."chatId", run."status"::text AS "status", chat."title"
          FROM "ModelRun" AS run
          INNER JOIN "Chat" AS chat ON chat."id" = run."chatId" AND chat."userId" = run."userId"
          WHERE run."id" = ${runId}
            AND run."status" IN ('complete'::"ModelRunStatus", 'error'::"ModelRunStatus")
            AND chat."projectId" IS NULL
            AND chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
            AND chat."permanentDeletionAt" IS NULL
            AND ${notScheduledRunSql()}
            AND ${ownerAcceptsSql(Prisma.sql`run."userId"`, now)}
        ), claimed AS (
          INSERT INTO "BrowserPushDelivery" ("id", "runId", "claimedAt")
          SELECT ${randomUUID()}, event."id", ${now} FROM event
          ON CONFLICT ("runId") DO NOTHING
          RETURNING "runId"
        )
        SELECT event."userId", event."chatId", event."status", event."title"
        FROM event INNER JOIN claimed ON claimed."runId" = event."id"
      `);
      if (!row || (row.status !== "complete" && row.status !== "error")) return null;
      return { chatId: row.chatId, kind: "run", status: row.status, title: row.title, userId: row.userId };
    },

    async claimOccurrence(occurrenceId, now) {
      const [row] = await prisma.$queryRaw<Array<{
        chatId: string | null; reasonCode: string | null; state: ScheduledTaskSettledState;
        taskPauseReason: string | null; title: string; trigger: string; unavailableSources: Prisma.JsonValue | null; userId: string;
      }>>(Prisma.sql`
        WITH event AS (
          SELECT occurrence."id", occurrence."userId", occurrence."state"::text AS "state", occurrence."reasonCode",
            occurrence."trigger", COALESCE(occurrence."chatId", task."chatId") AS "chatId", task."title",
            task."pauseReason" AS "taskPauseReason", occurrence."unavailableSources"
          FROM "ScheduledTaskOccurrence" AS occurrence
          INNER JOIN "ScheduledTask" AS task ON task."id" = occurrence."taskId"
          WHERE occurrence."id" = ${occurrenceId}
            AND occurrence."state" IN ('COMPLETED'::"ScheduledTaskOccurrenceState",
              'FAILED'::"ScheduledTaskOccurrenceState", 'SKIPPED'::"ScheduledTaskOccurrenceState")
            AND ${ownerAcceptsSql(Prisma.sql`occurrence."userId"`, now)}
        ), claimed AS (
          INSERT INTO "BrowserPushDelivery" ("id", "occurrenceId", "claimedAt")
          SELECT ${randomUUID()}, event."id", ${now} FROM event
          ON CONFLICT ("occurrenceId") DO NOTHING
          RETURNING "occurrenceId"
        )
        SELECT event."userId", event."chatId", event."state", event."reasonCode", event."trigger", event."title",
          event."taskPauseReason", event."unavailableSources"
        FROM event INNER JOIN claimed ON claimed."occurrenceId" = event."id"
      `);
      return row ? {
        ...row, kind: "occurrence", trigger: trigger(row.trigger), unavailableSources: unavailableSourcesWire(row.unavailableSources)
      } : null;
    },

    async listTargets(userId, now) {
      return prisma.$queryRaw<BrowserPushTarget[]>(Prisma.sql`
        SELECT subscription."id", subscription."endpoint", subscription."p256dh", subscription."auth", subscription."sessionId"
        FROM "BrowserPushSubscription" AS subscription
        INNER JOIN "AuthSession" AS session
          ON session."id" = subscription."sessionId" AND session."userId" = subscription."userId"
        INNER JOIN "User" AS account ON account."id" = subscription."userId"
        INNER JOIN "UserSettings" AS settings ON settings."userId" = subscription."userId"
        WHERE subscription."userId" = ${userId}
          AND account."status" = 'active'::"UserStatus"
          AND settings."browserNotificationsEnabled"
          AND session."revokedAt" IS NULL AND session."expiresAt" > ${now}
        ORDER BY subscription."updatedAt" DESC, subscription."id" DESC
        LIMIT ${BROWSER_PUSH_MAX_SUBSCRIPTIONS_PER_USER}
      `);
    },

    async recordDelivery(target, outcome, now) {
      if (outcome === "gone") {
        await prisma.$executeRaw(Prisma.sql`
          DELETE FROM "BrowserPushSubscription" WHERE "id" = ${target.id} AND "endpoint" = ${target.endpoint}
        `);
        return;
      }
      if (outcome === "delivered") {
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "BrowserPushSubscription" SET "lastSuccessAt" = ${now}, "failureCount" = 0
          WHERE "id" = ${target.id} AND "endpoint" = ${target.endpoint}
        `);
        return;
      }
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "BrowserPushSubscription" SET "lastFailureAt" = ${now}, "failureCount" = "failureCount" + 1
        WHERE "id" = ${target.id} AND "endpoint" = ${target.endpoint}
      `);
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "BrowserPushSubscription"
        WHERE "id" = ${target.id} AND "failureCount" >= ${BROWSER_PUSH_MAX_CONSECUTIVE_FAILURES}
      `);
    }
  };
}
