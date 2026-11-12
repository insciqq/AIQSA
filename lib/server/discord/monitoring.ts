import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  DISCORD_MCP_SERVER_LABEL_MAX, DISCORD_MONITORING_KEYS_MAX, DISCORD_MONITORING_WINDOW_MAX_DAYS, DISCORD_PROBLEM_ROWS_MAX, discordMessageLink,
  discordMonitoringKeyCreatedSchema, discordMonitoringKeyListSchema, discordMonitoringTelemetrySchema, type DiscordMonitoringKey,
  type DiscordMonitoringTelemetry, type DiscordProblemRow
} from "../../contracts/discord";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import {
  DISCORD_FAILURE_SQL, discordPrivateJson, discordReadFailed, readDiscordJournalStats, requireDiscordAdmin, type DiscordJournalDb,
  type DiscordJournalWindow
} from "./activity";

/**
 * Discord telemetry for the installation's own monitoring (PRD D-34, D-36,
 * O-30, O-32), outside administrator sign-in:
 *
 * - Monitoring keys: created in Admin → Discord → Monitoring, the secret shown
 *   once and only its SHA-256 kept, at most five active, revocable, with the
 *   time of last use.
 * - `GET /api/monitoring/discord?since=&until=` (a window of at most 31 days,
 *   the last 24 hours by default): the journal's aggregates and up to 500
 *   problem rows.
 * - `GET /api/monitoring/discord/metrics`: Prometheus text over the last hour.
 *
 * Both take `Authorization: Bearer <key>`; a missing, malformed, unknown or
 * revoked key gets one indistinguishable 404. Responses hold Discord ids,
 * AIQSA chat ids, codes, counts, delays and installation MCP servers by their
 * administrator-chosen names, never people's names, text or MCP server ids
 * (a public projection, `agent_docs/ARCHITECTURE.md`). Test-mode requests are
 * left out of the aggregates and of the failure ratio, and labelled
 * `test="true"` where the metrics count requests.
 */

export const DISCORD_MONITORING_SECRET_PATTERN = /^aiqsa_dmk_[A-Za-z0-9_-]{32,64}$/u;
/** `lastUsedAt` moves at most once a minute per key, so a scraper does not write on every read. */
const LAST_USED_RESOLUTION_MS = 60_000;
const KEY_LIST_MAX = 50;
const DEFAULT_WINDOW_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const INTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;

// ---------------------------------------------------------------------------
// Keys

export type DiscordMonitoringKeyStore = Readonly<{
  /** Active keys first, then revoked ones, newest first; never a hash. */
  list(): Promise<DiscordMonitoringKey[]>;
  /** `limit` while five keys are active. */
  create(input: Readonly<{ keyHash: string; createdByUserId: string; now: Date }>): Promise<DiscordMonitoringKey | "limit">;
  /** False for a key that does not exist; revoking a revoked key keeps its first revocation. */
  revoke(input: Readonly<{ id: string; now: Date }>): Promise<boolean>;
  /** Whether the secret is an active key's, compared in constant time; a match records its use. */
  verify(secret: string, now: Date): Promise<boolean>;
}>;

export function hashDiscordMonitoringSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newDiscordMonitoringSecret(): string {
  return `aiqsa_dmk_${randomBytes(32).toString("base64url")}`;
}

type KeyRow = Readonly<{ id: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }>;

function keyOf(row: KeyRow): DiscordMonitoringKey {
  return {
    createdAt: row.createdAt.toISOString(), id: row.id, lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null
  };
}

const keySelect = { createdAt: true, id: true, lastUsedAt: true, revokedAt: true } satisfies Prisma.DiscordMonitoringKeySelect;

/** The index of the candidate `hash` equals, or -1; every candidate is compared, each in constant time. */
export function matchesDiscordKeyHash(hash: string, candidates: readonly string[]): number {
  const actual = Buffer.from(hash, "hex");
  let found = -1;
  candidates.forEach((candidate, index) => {
    const expected = Buffer.from(candidate, "hex");
    if (expected.length === actual.length && timingSafeEqual(actual, expected) && found === -1) found = index;
  });
  return found;
}

export function createPrismaDiscordMonitoringKeyStore(prisma: Pick<PrismaClient, "$transaction" | "discordMonitoringKey">): DiscordMonitoringKeyStore {
  return Object.freeze({
    async list() {
      const rows = await prisma.discordMonitoringKey.findMany({
        orderBy: [{ revokedAt: { nulls: "first", sort: "desc" } }, { createdAt: "desc" }, { id: "asc" }], select: keySelect, take: KEY_LIST_MAX
      }).catch(retainDatabaseFailure);
      return rows.map(keyOf);
    },

    async create({ createdByUserId, keyHash, now }) {
      return prisma.$transaction(async (tx) => {
        // One creation at a time, so concurrent creates cannot pass the cap together.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('aiqsa:discord-monitoring-keys', 0))::text AS "lock"`;
        const active = await tx.discordMonitoringKey.count({ where: { revokedAt: null } });
        if (active >= DISCORD_MONITORING_KEYS_MAX) return "limit" as const;
        return keyOf(await tx.discordMonitoringKey.create({ data: { createdAt: now, createdByUserId, keyHash }, select: keySelect }));
      }).catch(retainDatabaseFailure);
    },

    async revoke({ id, now }) {
      const found = await prisma.discordMonitoringKey.findUnique({ select: { revokedAt: true }, where: { id } }).catch(retainDatabaseFailure);
      if (!found) return false;
      if (!found.revokedAt) {
        await prisma.discordMonitoringKey.updateMany({ data: { revokedAt: now }, where: { id, revokedAt: null } }).catch(retainDatabaseFailure);
      }
      return true;
    },

    async verify(secret, now) {
      if (!DISCORD_MONITORING_SECRET_PATTERN.test(secret)) return false;
      const active = await prisma.discordMonitoringKey.findMany({
        orderBy: { createdAt: "asc" }, select: { id: true, keyHash: true }, take: KEY_LIST_MAX, where: { revokedAt: null }
      }).catch(retainDatabaseFailure);
      const index = matchesDiscordKeyHash(hashDiscordMonitoringSecret(secret), active.map((row) => row.keyHash));
      if (index === -1) return false;
      await prisma.discordMonitoringKey.updateMany({
        data: { lastUsedAt: now },
        where: {
          id: active[index]!.id, revokedAt: null,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_RESOLUTION_MS) } }]
        }
      }).catch(retainDatabaseFailure);
      return true;
    }
  });
}

// ---------------------------------------------------------------------------
// Telemetry

type ProblemQueryRow = {
  questionMessageId: string; receivedAt: Date; guildId: string | null; channelId: string; chatId: string | null; code: string | null;
  limitKind: string | null; state: string; sources: number | null; test: boolean; latencyMs: number | null; ratedDown: boolean;
};

function problemKind(row: ProblemQueryRow, slowMs: number | null): DiscordProblemRow["kind"] | null {
  if (row.limitKind !== null) return "limit";
  if (row.state === "failed" || row.state === "unknown") return "failed";
  if (row.state === "interrupted") return "interrupted";
  if (row.ratedDown) return "rated_down";
  if (row.state === "delivered" && row.sources === 0) return "not_found";
  if (slowMs !== null && row.latencyMs !== null && row.latencyMs > slowMs) return "slow";
  return null;
}

function limitKindOf(value: string | null): DiscordProblemRow["limitKind"] {
  return value === "author" || value === "thread" || value === "key" ? value : null;
}

/**
 * Problem rows of a window, newest first: failures, interruptions, limit hits,
 * 👎, answers that cited nothing, and deliveries slower than `slowMs` (the
 * window's p95). Each row is listed once, under its most telling kind; test
 * rows are included and labelled.
 */
export async function readDiscordProblemRows(db: Pick<PrismaClient, "$queryRaw">, window: DiscordJournalWindow, slowMs: number | null,
  limit = DISCORD_PROBLEM_ROWS_MAX): Promise<DiscordProblemRow[]> {
  const delivered = Prisma.sql`GREATEST(0, EXTRACT(EPOCH FROM (q."deliveredAt" - q."receivedAt")) * 1000)`;
  const ratedDown = Prisma.sql`EXISTS (SELECT 1 FROM "DiscordAnswerRating" r WHERE r."replyId" = q."questionMessageId" AND r."value" = -1)`;
  const slow = slowMs === null ? Prisma.empty : Prisma.sql`OR (q."deliveredAt" IS NOT NULL AND ${delivered} > ${slowMs}::float8)`;
  const rows = await db.$queryRaw<ProblemQueryRow[]>(Prisma.sql`
    SELECT
      q."questionMessageId"::text AS "questionMessageId", q."receivedAt", q."guildId"::text AS "guildId", q."channelId"::text AS "channelId",
      coalesce(c."chatId", m."chatId") AS "chatId", q."code", q."limitKind"::text AS "limitKind", q."state"::text AS "state", q."sources",
      q."test",
      CASE WHEN q."deliveredAt" IS NULL THEN NULL ELSE ${delivered}::float8 END AS "latencyMs",
      ${ratedDown} AS "ratedDown"
    FROM "DiscordReply" q
    LEFT JOIN "DiscordConversation" c ON c."id" = q."conversationId"
    LEFT JOIN "ModelRun" m ON m."id" = q."runId"
    WHERE q."receivedAt" >= ${window.since} AND q."receivedAt" < ${window.until}
      AND (q."state" IN ('failed', 'unknown', 'interrupted') OR q."limitKind" IS NOT NULL OR (q."state" = 'delivered' AND q."sources" = 0)
        OR ${ratedDown} ${slow})
    ORDER BY q."receivedAt" DESC, q."questionMessageId" DESC
    LIMIT ${Math.max(1, Math.min(limit, DISCORD_PROBLEM_ROWS_MAX))}`).catch(retainDatabaseFailure);
  return rows.flatMap((row) => {
    const kind = problemKind(row, slowMs);
    if (!kind) return [];
    return [{
      channelId: row.channelId,
      chatId: row.chatId && INTERNAL_ID.test(row.chatId) ? row.chatId : null,
      code: row.code && CODE_PATTERN.test(row.code) ? row.code : null,
      guildId: row.guildId,
      kind,
      latencyMs: row.latencyMs === null ? null : Math.max(0, Math.round(row.latencyMs)),
      limitKind: limitKindOf(row.limitKind),
      messageLink: discordMessageLink(row.guildId, row.channelId, row.questionMessageId),
      questionMessageId: row.questionMessageId,
      receivedAt: row.receivedAt.toISOString(),
      test: row.test
    }];
  });
}

/** A server's name as the projection shows it: control and formatting characters out, bounded; `other` when nothing is left. */
export function discordMcpServerLabel(name: string | null): string {
  const cleaned = Array.from((name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim())
    .slice(0, DISCORD_MCP_SERVER_LABEL_MAX).join("").trim();
  return cleaned || "other";
}

/**
 * MCP calls and errors by server over the window's non-test requests, busiest
 * first. The journal keeps server ids; the projection names an installation
 * server by its administrator's display name, read now (a renamed server shows
 * its current name), sums a deleted server's counts under `other` and a
 * personal server's under `personal`, so no id leaves the installation.
 */
export async function readDiscordMcpTotals(db: Pick<PrismaClient, "$queryRaw">, window: DiscordJournalWindow): Promise<DiscordMonitoringTelemetry["mcpByServer"]> {
  const number = (field: "calls" | "errors") => Prisma.raw(
    `CASE WHEN jsonb_typeof(e."value" -> '${field}') = 'number' THEN (e."value" ->> '${field}')::numeric ELSE 0 END`);
  const rows = await db.$queryRaw<Array<{ kind: "installation" | "personal" | "other"; name: string | null; calls: number; errors: number }>>(Prisma.sql`
    SELECT
      CASE WHEN s."id" IS NULL THEN 'other' WHEN s."ownerUserId" IS NOT NULL THEN 'personal' ELSE 'installation' END AS "kind",
      CASE WHEN s."id" IS NOT NULL AND s."ownerUserId" IS NULL THEN s."displayName" END AS "name",
      sum(${number("calls")})::float8 AS "calls", sum(${number("errors")})::float8 AS "errors"
    FROM "DiscordReply" q
    CROSS JOIN LATERAL jsonb_each(q."mcpByServer") e
    LEFT JOIN "McpServer" s ON s."id" = e."key"
    WHERE q."receivedAt" >= ${window.since} AND q."receivedAt" < ${window.until} AND q."test" = false AND q."mcpByServer" IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 3 DESC, 2 ASC
    LIMIT 1000`).catch(retainDatabaseFailure);
  const totals = new Map<string, { calls: number; errors: number }>();
  for (const row of rows) {
    const server = row.kind === "installation" ? discordMcpServerLabel(row.name) : row.kind;
    const entry = totals.get(server) ?? { calls: 0, errors: 0 };
    entry.calls += Math.max(0, Math.round(Number(row.calls)));
    entry.errors += Math.max(0, Math.round(Number(row.errors)));
    totals.set(server, entry);
  }
  return [...totals].map(([server, counts]) => ({ calls: counts.calls, errors: counts.errors, server }))
    .sort((left, right) => right.calls - left.calls || (left.server < right.server ? -1 : left.server > right.server ? 1 : 0))
    .slice(0, 200);
}

/** The monitoring projection of one window. */
export async function readDiscordMonitoringTelemetry(db: DiscordJournalDb, window: DiscordJournalWindow, now: Date): Promise<DiscordMonitoringTelemetry> {
  const stats = await readDiscordJournalStats(db, window);
  const [problems, mcpByServer] = await Promise.all([
    readDiscordProblemRows(db, window, stats.latency.delivered.p95Ms),
    readDiscordMcpTotals(db, window)
  ]);
  return {
    compactions: stats.compactions,
    delivered: stats.delivered,
    failed: stats.failed,
    failuresByCode: [...stats.failuresByCode],
    generatedAt: now.toISOString(),
    interrupted: stats.interrupted,
    latency: {
      acked: { ...stats.latency.acked }, admitted: { ...stats.latency.admitted }, delivered: { ...stats.latency.delivered },
      firstStatus: { ...stats.latency.firstStatus }
    },
    limitHits: { ...stats.limitHits },
    mcpByServer,
    notFound: stats.notFound,
    problems,
    ratingsDown: stats.ratingsDown,
    ratingsUp: stats.ratingsUp,
    requests: stats.requests,
    since: window.since.toISOString(),
    subagents: stats.subagents,
    until: window.until.toISOString()
  };
}

// ---------------------------------------------------------------------------
// The last hour: metrics and the attention rule

export type DiscordHourCounts = Readonly<{
  requests: number;
  failures: number;
  limitHits: Readonly<{ author: number; thread: number; key: number }>;
  /** Delivered answers' p95 delay; null without one. */
  latencyP95Ms: number | null;
}>;

export type DiscordHourLoad = Readonly<{ people: DiscordHourCounts; test: DiscordHourCounts }>;

const EMPTY_HOUR: DiscordHourCounts = { failures: 0, latencyP95Ms: null, limitHits: { author: 0, key: 0, thread: 0 }, requests: 0 };

/** Requests, failures, limit hits and the p95 delay of the hour before `now`, people's and test-mode requests apart. */
export async function readDiscordHourLoad(db: Pick<PrismaClient, "$queryRaw">, now: Date): Promise<DiscordHourLoad> {
  const until = new Date(now.getTime() + 1);
  const since = new Date(until.getTime() - HOUR_MS);
  const rows = await db.$queryRaw<Array<{
    test: boolean; requests: number; failures: number; limitAuthor: number; limitThread: number; limitKey: number; p95: number | null;
  }>>(Prisma.sql`
    SELECT "test",
      count(*)::int AS "requests",
      (count(*) FILTER (WHERE ${DISCORD_FAILURE_SQL}))::int AS "failures",
      (count(*) FILTER (WHERE "limitKind" = 'author'))::int AS "limitAuthor",
      (count(*) FILTER (WHERE "limitKind" = 'thread'))::int AS "limitThread",
      (count(*) FILTER (WHERE "limitKind" = 'key'))::int AS "limitKey",
      (percentile_cont(0.95) WITHIN GROUP (ORDER BY GREATEST(0, EXTRACT(EPOCH FROM ("deliveredAt" - "receivedAt")) * 1000))
        FILTER (WHERE "deliveredAt" IS NOT NULL))::float8 AS "p95"
    FROM "DiscordReply"
    WHERE "receivedAt" >= ${since} AND "receivedAt" < ${until}
    GROUP BY "test"`).catch(retainDatabaseFailure);
  const of = (test: boolean): DiscordHourCounts => {
    const row = rows.find((entry) => entry.test === test);
    if (!row) return EMPTY_HOUR;
    return {
      failures: Number(row.failures),
      latencyP95Ms: row.p95 === null || !Number.isFinite(row.p95) ? null : Math.max(0, Math.round(row.p95)),
      limitHits: { author: Number(row.limitAuthor), key: Number(row.limitKey), thread: Number(row.limitThread) },
      requests: Number(row.requests)
    };
  };
  return { people: of(false), test: of(true) };
}

/** Failures among the hour's requests, test mode left out; 0 without requests. */
export function discordFailureRatio(counts: Pick<DiscordHourCounts, "requests" | "failures">): number {
  return counts.requests > 0 ? counts.failures / counts.requests : 0;
}

export type DiscordMetricsInput = Readonly<{
  enabled: boolean;
  connected: boolean;
  lastEventAt: Date | null;
  hour: DiscordHourLoad;
  now: Date;
}>;

function sample(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "NaN";
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1_000) / 1_000);
}

/** Prometheus text exposition (version 0.0.4) of the bot's state and its last hour. */
export function formatDiscordMetrics(input: DiscordMetricsInput): string {
  const lines: string[] = [];
  const metric = (name: string, help: string, samples: readonly (readonly [string, number | null])[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${sample(value)}`);
  };
  const byTest = (pick: (counts: DiscordHourCounts) => number) =>
    [[`{test="false"}`, pick(input.hour.people)], [`{test="true"}`, pick(input.hour.test)]] as const;
  metric("aiqsa_discord_enabled", "Whether the Discord bot is switched on (1) or off (0).", [["", input.enabled ? 1 : 0]]);
  metric("aiqsa_discord_gateway_connected", "Whether this AIQSA process holds a Discord gateway session (1) or not (0).",
    [["", input.connected ? 1 : 0]]);
  metric("aiqsa_discord_last_event_age_seconds", "Seconds since the last Discord gateway event this installation recorded; NaN before the first.",
    [["", input.lastEventAt ? Math.max(0, (input.now.getTime() - input.lastEventAt.getTime()) / 1_000) : null]]);
  metric("aiqsa_discord_requests_1h", "Discord questions received in the last hour.", byTest((counts) => counts.requests));
  metric("aiqsa_discord_failures_1h", "Discord questions in the last hour that ended failed or unknown, limit hits excluded.",
    byTest((counts) => counts.failures));
  metric("aiqsa_discord_failure_ratio_1h", "Failures among the last hour's Discord questions, test mode excluded; 0 without questions.",
    [["", discordFailureRatio(input.hour.people)]]);
  metric("aiqsa_discord_latency_p95_seconds_1h", "p95 seconds from a Discord question to its delivered answer in the last hour, test mode excluded; NaN without one.",
    [["", input.hour.people.latencyP95Ms === null ? null : input.hour.people.latencyP95Ms / 1_000]]);
  const limits: [string, number][] = [];
  for (const kind of ["author", "thread", "key"] as const) {
    limits.push([`{kind="${kind}",test="false"}`, input.hour.people.limitHits[kind]], [`{kind="${kind}",test="true"}`, input.hour.test.limitHits[kind]]);
  }
  metric("aiqsa_discord_limit_hits_1h", "Discord questions in the last hour refused or ended by an author, thread or model key limit.", limits);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Routes

const NOT_FOUND_HEADERS = { "cache-control": "no-store" };

/** The one answer to anything without a valid key, whatever was wrong with it. */
function notFound(): Response {
  return Response.json({ error: "not_found" }, { headers: NOT_FOUND_HEADERS, status: 404 });
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/u.exec(value);
  return match ? match[1]! : null;
}

/** `since`/`until` as ISO date-times; the last 24 hours by default; null for a window that is invalid or longer than 31 days. */
export function parseDiscordMonitoringWindow(params: URLSearchParams, now: Date): DiscordJournalWindow | null {
  const read = (name: string): Date | null | undefined => {
    const values = params.getAll(name);
    if (values.length === 0) return undefined;
    if (values.length > 1 || values[0]!.length > 40) return null;
    const ms = Date.parse(values[0]!);
    return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T/u.test(values[0]!) ? new Date(ms) : null;
  };
  const sinceValue = read("since");
  const untilValue = read("until");
  if (sinceValue === null || untilValue === null) return null;
  const until = untilValue ?? now;
  const since = sinceValue ?? new Date(until.getTime() - DEFAULT_WINDOW_MS);
  const span = until.getTime() - since.getTime();
  if (span <= 0 || span > DISCORD_MONITORING_WINDOW_MAX_DAYS * 86_400_000) return null;
  return { since, until };
}

export type DiscordMonitoringDeps = Readonly<{
  keys: Pick<DiscordMonitoringKeyStore, "verify">;
  telemetry(window: DiscordJournalWindow, now: Date): Promise<DiscordMonitoringTelemetry>;
  metrics(now: Date): Promise<string>;
  now?: () => Date;
}>;

/** `GET /api/monitoring/discord` and `GET /api/monitoring/discord/metrics`. */
export function createDiscordMonitoringHandlers(deps: DiscordMonitoringDeps) {
  const now = deps.now ?? (() => new Date());

  async function authorized(request: Request, at: Date): Promise<boolean | Response> {
    const secret = bearer(request);
    if (!secret || !DISCORD_MONITORING_SECRET_PATTERN.test(secret)) return false;
    try {
      return await deps.keys.verify(secret, at);
    } catch (error) {
      return discordReadFailed(error);
    }
  }

  return {
    async telemetry(request: Request): Promise<Response> {
      const at = now();
      const allowed = await authorized(request, at);
      if (allowed instanceof Response) return allowed;
      if (!allowed) return notFound();
      const window = parseDiscordMonitoringWindow(new URL(request.url).searchParams, at);
      if (!window) return discordPrivateJson({ error: "discord_monitoring_window_invalid" }, 400);
      try {
        return discordPrivateJson(discordMonitoringTelemetrySchema.parse(await deps.telemetry(window, at)));
      } catch (error) {
        return discordReadFailed(error);
      }
    },

    async metrics(request: Request): Promise<Response> {
      const at = now();
      const allowed = await authorized(request, at);
      if (allowed instanceof Response) return allowed;
      if (!allowed) return notFound();
      try {
        return new Response(await deps.metrics(at), {
          headers: { "cache-control": "private, no-store", "content-type": "text/plain; version=0.0.4; charset=utf-8" }, status: 200
        });
      } catch (error) {
        return discordReadFailed(error);
      }
    }
  };
}

/** `GET`/`POST /api/admin/discord/monitoring-keys` and `DELETE /api/admin/discord/monitoring-keys/[id]`. */
export function createAdminDiscordMonitoringKeyHandlers(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  keys: Omit<DiscordMonitoringKeyStore, "verify">;
  newSecret?: () => string;
  now?: () => Date;
}>) {
  const now = deps.now ?? (() => new Date());
  const newSecret = deps.newSecret ?? newDiscordMonitoringSecret;

  async function list(): Promise<Response> {
    return discordPrivateJson(discordMonitoringKeyListSchema.parse({ keys: await deps.keys.list() }));
  }

  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireDiscordAdmin(request, deps.resolveAuth);
      if (auth instanceof Response) return auth;
      try {
        return await list();
      } catch (error) {
        return discordReadFailed(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      const auth = await requireDiscordAdmin(request, deps.resolveAuth);
      if (auth instanceof Response) return auth;
      const secret = newSecret();
      try {
        const key = await deps.keys.create({ createdByUserId: auth.userId, keyHash: hashDiscordMonitoringSecret(secret), now: now() });
        if (key === "limit") return discordPrivateJson({ error: "discord_monitoring_key_limit" }, 409);
        return discordPrivateJson(discordMonitoringKeyCreatedSchema.parse({ key, secret }), 201);
      } catch (error) {
        return discordReadFailed(error, "write");
      }
    },

    async DELETE(request: Request, keyId: string): Promise<Response> {
      const auth = await requireDiscordAdmin(request, deps.resolveAuth);
      if (auth instanceof Response) return auth;
      if (!INTERNAL_ID.test(keyId)) return discordPrivateJson({ error: "not_found" }, 404);
      try {
        if (!await deps.keys.revoke({ id: keyId, now: now() })) return discordPrivateJson({ error: "not_found" }, 404);
        return await list();
      } catch (error) {
        return discordReadFailed(error, "write");
      }
    }
  };
}
