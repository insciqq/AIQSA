import { Prisma, type PrismaClient } from "@prisma/client";
import {
  DISCORD_ACTIVITY_ROWS_MAX, discordAdminActivitySchema, discordMessageLink, type DiscordActivityRow, type DiscordActivityStats,
  type DiscordAdminActivity
} from "../../contracts/discord";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { logEvent } from "../observability";
import { databaseFailureCode, retainDatabaseFailure } from "../observability/databaseFailure";

/**
 * The Discord journal read back (PRD D-28, D-34): aggregates over
 * `DiscordReply` rows of a window, and the administrator's Activity (24 h and
 * 7 d summaries and the latest rows). Everything here is ids, codes, counts
 * and delays; the only name is the author's display snapshot in the
 * administrator's rows, never in the monitoring projection.
 *
 * Definitions shared by Activity, the monitoring projection, the metrics and
 * the `discord_failures_rising` attention rule:
 * - a request is a question row received in the window;
 * - a failure is a row that ended `failed` or `unknown` without a limit hit
 *   (limit hits are counted by kind on their own, never as failures);
 * - "not found" is a delivered answer that cited no source;
 * - a stage's delay counts from `receivedAt`;
 * - ratings count when they were given.
 * Aggregates leave out test-mode requests (PRD D-36): they are synthetic
 * checks, not people's experience. Rows keep them, labelled `test`.
 */

export type DiscordJournalWindow = Readonly<{ since: Date; until: Date }>;
export type DiscordLatency = Readonly<{ p50Ms: number | null; p95Ms: number | null }>;

export type DiscordJournalStats = Readonly<{
  requests: number;
  delivered: number;
  failed: number;
  interrupted: number;
  failuresByCode: readonly Readonly<{ code: string; count: number }>[];
  limitHits: Readonly<{ author: number; thread: number; key: number }>;
  notFound: number;
  ratingsUp: number;
  ratingsDown: number;
  latency: Readonly<{ acked: DiscordLatency; admitted: DiscordLatency; firstStatus: DiscordLatency; delivered: DiscordLatency }>;
  compactions: number;
  subagents: number;
}>;

export type DiscordJournalDb = Pick<PrismaClient, "$queryRaw" | "discordReply">;

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const FAILURES_BY_CODE_MAX = 100;
const HOUR_MS = 3_600_000;

/** The SQL condition of a failure: ended badly, and not a limit hit. */
export const DISCORD_FAILURE_SQL = Prisma.sql`"state" IN ('failed', 'unknown') AND "limitKind" IS NULL`;

type StatsRow = {
  requests: number; delivered: number; failed: number; interrupted: number; limitAuthor: number; limitThread: number; limitKey: number;
  notFound: number; compactions: number; subagents: number;
  ackedP50: number | null; ackedP95: number | null; admittedP50: number | null; admittedP95: number | null;
  firstStatusP50: number | null; firstStatusP95: number | null; deliveredP50: number | null; deliveredP95: number | null;
};

function delayMs(column: string): Prisma.Sql {
  return Prisma.sql`GREATEST(0, EXTRACT(EPOCH FROM (${Prisma.raw(`"${column}"`)} - "receivedAt")) * 1000)`;
}

function percentiles(column: string, alias: string): Prisma.Sql {
  const delay = delayMs(column);
  const present = Prisma.raw(`"${column}" IS NOT NULL`);
  return Prisma.sql`
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${delay}) FILTER (WHERE ${present}))::float8 AS ${Prisma.raw(`"${alias}P50"`)},
    (percentile_cont(0.95) WITHIN GROUP (ORDER BY ${delay}) FILTER (WHERE ${present}))::float8 AS ${Prisma.raw(`"${alias}P95"`)}`;
}

function ms(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.max(0, Math.round(value));
}

function count(value: number | bigint | null): number {
  return value === null ? 0 : Number(value);
}

/** Aggregates of one window, test-mode requests left out. */
export async function readDiscordJournalStats(db: DiscordJournalDb, window: DiscordJournalWindow): Promise<DiscordJournalStats> {
  const inWindow = Prisma.sql`"receivedAt" >= ${window.since} AND "receivedAt" < ${window.until} AND "test" = false`;
  try {
    const [totals] = await db.$queryRaw<StatsRow[]>(Prisma.sql`
      SELECT
        count(*)::int AS "requests",
        (count(*) FILTER (WHERE "state" = 'delivered'))::int AS "delivered",
        (count(*) FILTER (WHERE ${DISCORD_FAILURE_SQL}))::int AS "failed",
        (count(*) FILTER (WHERE "state" = 'interrupted'))::int AS "interrupted",
        (count(*) FILTER (WHERE "limitKind" = 'author'))::int AS "limitAuthor",
        (count(*) FILTER (WHERE "limitKind" = 'thread'))::int AS "limitThread",
        (count(*) FILTER (WHERE "limitKind" = 'key'))::int AS "limitKey",
        (count(*) FILTER (WHERE "state" = 'delivered' AND "sources" = 0))::int AS "notFound",
        coalesce(sum("compactions"), 0)::float8 AS "compactions",
        coalesce(sum("subagents"), 0)::float8 AS "subagents",
        ${percentiles("ackAt", "acked")},
        ${percentiles("admittedAt", "admitted")},
        ${percentiles("firstStatusAt", "firstStatus")},
        ${percentiles("deliveredAt", "delivered")}
      FROM "DiscordReply"
      WHERE ${inWindow}`);
    const failures = await db.$queryRaw<Array<{ code: string; count: number }>>(Prisma.sql`
      SELECT "code", count(*)::int AS "count"
      FROM "DiscordReply"
      WHERE ${inWindow} AND ${DISCORD_FAILURE_SQL} AND "code" IS NOT NULL
      GROUP BY "code"
      ORDER BY count(*) DESC, "code" ASC
      LIMIT ${FAILURES_BY_CODE_MAX}`);
    const [ratings] = await db.$queryRaw<Array<{ up: number; down: number }>>(Prisma.sql`
      SELECT (count(*) FILTER (WHERE r."value" = 1))::int AS "up", (count(*) FILTER (WHERE r."value" = -1))::int AS "down"
      FROM "DiscordAnswerRating" r
      JOIN "DiscordReply" q ON q."questionMessageId" = r."replyId"
      WHERE r."createdAt" >= ${window.since} AND r."createdAt" < ${window.until} AND q."test" = false`);
    const row = totals!;
    return {
      compactions: count(row.compactions),
      delivered: count(row.delivered),
      failed: count(row.failed),
      failuresByCode: failures.filter((entry) => CODE_PATTERN.test(entry.code)).map((entry) => ({ code: entry.code, count: count(entry.count) })),
      interrupted: count(row.interrupted),
      latency: {
        acked: { p50Ms: ms(row.ackedP50), p95Ms: ms(row.ackedP95) },
        admitted: { p50Ms: ms(row.admittedP50), p95Ms: ms(row.admittedP95) },
        delivered: { p50Ms: ms(row.deliveredP50), p95Ms: ms(row.deliveredP95) },
        firstStatus: { p50Ms: ms(row.firstStatusP50), p95Ms: ms(row.firstStatusP95) }
      },
      limitHits: { author: count(row.limitAuthor), key: count(row.limitKey), thread: count(row.limitThread) },
      notFound: count(row.notFound),
      ratingsDown: count(ratings?.down ?? 0),
      ratingsUp: count(ratings?.up ?? 0),
      requests: count(row.requests),
      subagents: count(row.subagents)
    };
  } catch (error) {
    return retainDatabaseFailure(error);
  }
}

export function discordActivityStats(stats: DiscordJournalStats): DiscordActivityStats {
  return {
    delivered: stats.delivered, failed: stats.failed, failuresByCode: [...stats.failuresByCode], interrupted: stats.interrupted,
    latency: { ...stats.latency.delivered }, limitHits: { ...stats.limitHits }, notFound: stats.notFound, ratingsDown: stats.ratingsDown,
    ratingsUp: stats.ratingsUp, requests: stats.requests
  };
}

/** A delivered question's delay from arrival to its answer; null for every other ending. */
export function discordDeliveredLatencyMs(row: Readonly<{ receivedAt: Date; deliveredAt: Date | null }>): number | null {
  return row.deliveredAt ? Math.max(0, row.deliveredAt.getTime() - row.receivedAt.getTime()) : null;
}

/** The latest questions received before `until`, newest first, with their channel's display name when one is known. */
export async function readDiscordActivityRows(db: Pick<PrismaClient, "discordReply">, input: Readonly<{
  until: Date; limit?: number; channelNames?: ReadonlyMap<string, string>;
}>): Promise<DiscordActivityRow[]> {
  const rows = await db.discordReply.findMany({
    orderBy: [{ receivedAt: "desc" }, { questionMessageId: "desc" }],
    select: {
      authorName: true, channelId: true, code: true, conversation: { select: { parentChannelId: true } }, deliveredAt: true, discordUserId: true,
      guildId: true, kind: true, questionMessageId: true, receivedAt: true, state: true, test: true
    },
    take: Math.max(1, Math.min(input.limit ?? DISCORD_ACTIVITY_ROWS_MAX, DISCORD_ACTIVITY_ROWS_MAX)),
    where: { receivedAt: { lt: input.until } }
  }).catch(retainDatabaseFailure);
  const names = input.channelNames ?? new Map<string, string>();
  return rows.map((row) => {
    const channelId = row.channelId.toString();
    const guildId = row.guildId?.toString() ?? null;
    const parentId = row.conversation?.parentChannelId?.toString() ?? null;
    return {
      authorId: row.discordUserId.toString(),
      authorName: row.authorName.trim() || "Discord user",
      channelId,
      // A question in a thread is shown under the thread's channel.
      channelName: names.get(channelId) ?? (parentId ? names.get(parentId) : undefined) ?? null,
      code: row.code && CODE_PATTERN.test(row.code) ? row.code : null,
      guildId,
      kind: row.kind,
      latencyMs: discordDeliveredLatencyMs(row),
      messageLink: discordMessageLink(guildId, channelId, row.questionMessageId.toString()),
      questionMessageId: row.questionMessageId.toString(),
      receivedAt: row.receivedAt.toISOString(),
      state: row.state,
      test: row.test
    };
  });
}

/** The administrator's Activity: summaries of the last 24 hours and 7 days, and the latest rows. */
export async function readDiscordAdminActivity(db: DiscordJournalDb, input: Readonly<{
  now: Date; channelNames?: ReadonlyMap<string, string>;
}>): Promise<DiscordAdminActivity> {
  const until = new Date(input.now.getTime() + 1);
  const [last24h, last7d, rows] = await Promise.all([
    readDiscordJournalStats(db, { since: new Date(until.getTime() - 24 * HOUR_MS), until }),
    readDiscordJournalStats(db, { since: new Date(until.getTime() - 7 * 24 * HOUR_MS), until }),
    readDiscordActivityRows(db, { channelNames: input.channelNames, until })
  ]);
  return { last24h: discordActivityStats(last24h), last7d: discordActivityStats(last7d), rows };
}

// ---------------------------------------------------------------------------
// Routes

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

export function discordPrivateJson(body: unknown, status = 200): Response {
  return Response.json(body, { headers: PRIVATE_HEADERS, status });
}

/** Active administrators only; anything else is answered here. */
export async function requireDiscordAdmin(request: Request, resolveAuth: RequestAuthResolver): Promise<Readonly<{ userId: string }> | Response> {
  const session = await resolveAuth(request);
  if (!session) return discordPrivateJson({ error: "unauthorized" }, 401);
  if (session.user.status !== "active" || session.user.role !== "admin") return discordPrivateJson({ error: "forbidden" }, 403);
  return { userId: session.userId };
}

/** A read the route could not complete: content-free, with its database identity when it was one. */
export function discordReadFailed(error: unknown, stage: "read" | "write" = "read"): Response {
  logEvent("service_operation", {
    code: "discord_monitoring_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage, subsystem: "discord"
  });
  return discordPrivateJson({ error: "discord_monitoring_failed" }, 503);
}

/** `GET /api/admin/discord/activity`. */
export function createAdminDiscordActivityHandler(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  read(now: Date): Promise<DiscordAdminActivity>;
  now?: () => Date;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await requireDiscordAdmin(request, deps.resolveAuth);
    if (auth instanceof Response) return auth;
    try {
      const activity = discordAdminActivitySchema.parse(await deps.read(deps.now?.() ?? new Date()));
      return discordPrivateJson(activity);
    } catch (error) {
      return discordReadFailed(error);
    }
  };
}
