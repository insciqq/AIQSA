import { Prisma, type PrismaClient } from "@prisma/client";
import { validateIanaTimeZone } from "../../../domain/promptTemplates";
import { retainDatabaseFailure } from "../../observability/databaseFailure";

/**
 * The time zone a Telegram run carries: the product keeps no per-user zone,
 * but every browser send reports one and the accepted run records it in
 * `normalizedRequest.prompt.baseline` (`timeZoneSource: "client"`). The
 * user's most recent such zone among their latest runs is reused, so "now"
 * and a schedule the model sets from Telegram follow the user's clock rather
 * than UTC. Scheduled-task runs are skipped: they carry the task's zone, not
 * where the user is. None found, or not a zone this runtime resolves: null,
 * and the run keeps the recorded UTC fallback.
 */

/** Newest runs examined per read; bounds the work on a user with no browser zone at all. */
export const TELEGRAM_TIME_ZONE_RUN_WINDOW = 20;

export type TelegramTimeZoneStore = Readonly<{
  latestClientTimeZone(userId: string): Promise<string | null>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first baseline, newest first, whose zone the browser reported and the runtime resolves. */
export function pickClientTimeZone(baselines: readonly unknown[]): string | null {
  for (const baseline of baselines) {
    if (!isRecord(baseline) || baseline.timeZoneSource !== "client") continue;
    const zone = validateIanaTimeZone(baseline.timeZone);
    if (zone) return zone;
  }
  return null;
}

export function createPrismaTelegramTimeZoneStore(prisma: Pick<PrismaClient, "$queryRaw">): TelegramTimeZoneStore {
  return Object.freeze({
    async latestClientTimeZone(userId: string) {
      // One backward range scan of ModelRun(userId, createdAt); only the small
      // baseline object of each request leaves the database.
      const rows = await prisma.$queryRaw<Array<{ baseline: unknown }>>(Prisma.sql`
        SELECT "normalizedRequest" #> '{prompt,baseline}' AS "baseline"
        FROM "ModelRun"
        WHERE "userId" = ${userId} AND "scheduledTaskId" IS NULL
        ORDER BY "createdAt" DESC
        LIMIT ${TELEGRAM_TIME_ZONE_RUN_WINDOW}
      `).catch(retainDatabaseFailure);
      return pickClientTimeZone(rows.map((row) => row.baseline));
    }
  });
}
