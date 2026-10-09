import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeRunReference, runReferenceRange } from "../../contracts/runReference";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import {
  TELEMETRY_DIMENSIONS, TELEMETRY_DURATION_BUCKETS, TELEMETRY_LEVELS, telemetryDimensionsJson,
  type TelemetryBatch, type TelemetryCounterDelta, type TelemetryDimension, type TelemetryDimensionValue,
  type TelemetryDimensions, type TelemetryIncidentInput, type TelemetryIncidentLevel, type TelemetryLevel
} from "./aggregator";

/** Retention owned by code (Persistence): counters and incidents for 30 days;
 * per UTC day and incident key at most 200 incidents (the day's first and
 * latest 100); never beyond the newest 50,000 incidents. */
export const TELEMETRY_COUNTER_RETENTION_MS = 30 * 24 * 3_600_000;
export const TELEMETRY_INCIDENT_RETENTION_MS = 30 * 24 * 3_600_000;
export const TELEMETRY_INCIDENT_KEY_DAY_ROWS = 200;
export const TELEMETRY_INCIDENT_MAX_ROWS = 50_000;
const RETENTION_BATCH_ROWS = 1_000;
const RETENTION_MAX_BATCHES = 20;
const ROWS_PER_STATEMENT = 500;
const KEY_DAY_EDGE_ROWS = TELEMETRY_INCIDENT_KEY_DAY_ROWS / 2;
/** One incident key per UTC day: a repeating error. Distinct fingerprints are
 * distinct keys; NULLs compare equal within a window partition. */
const incidentKey = Prisma.sql`"event", "code", "subsystem", "connectionId", "details" ->> 'error_fingerprint'`;
const incidentKeyDay = Prisma.sql`${incidentKey}, date_trunc('day', "occurredAt")`;
const incidentColumns = Prisma.sql`"id", "occurredAt", "role", "event", "level", "appVersion", "instanceId",
  "code", "subsystem", "connectionId", "runId", "traceId", "userId", "details"`;
/** Group keys one counter read may combine. */
const MAX_GROUP_KEYS = 16;

export const TELEMETRY_GROUP_KEYS = Object.freeze(
  ["bucket", "role", "event", "level", "appVersion", "overflow", ...TELEMETRY_DIMENSIONS] as const
);
export type TelemetryGroupKey = (typeof TELEMETRY_GROUP_KEYS)[number];
export type TelemetryGroupValue = TelemetryDimensionValue | Date | null;

export type TelemetryCounterQuery = Readonly<{
  /** Inclusive start and exclusive end of the hourly buckets to read. */
  from: Date;
  to: Date;
  events?: readonly string[];
  levels?: readonly TelemetryLevel[];
  roles?: readonly string[];
  /** Exact dimension values every counted key must carry. */
  dimensions?: Readonly<Partial<Record<TelemetryDimension, string | number>>>;
  groupBy?: readonly TelemetryGroupKey[];
  /** Width of a `bucket` group (UTC). */
  interval?: "hour" | "day";
  limit?: number;
}>;

export type TelemetryCounterGroup = Readonly<{
  group: Readonly<Partial<Record<TelemetryGroupKey, TelemetryGroupValue>>>;
  count: number;
  valueSum: number;
  durationCount: number;
  durationSumMs: number;
  durationMaxMs: number | null;
  durationBuckets: readonly number[];
  firstSeenAt: Date;
  lastSeenAt: Date;
}>;

export type TelemetryIncidentQuery = Readonly<{
  from?: Date;
  to?: Date;
  events?: readonly string[];
  codes?: readonly string[];
  subsystems?: readonly string[];
  connectionIds?: readonly string[];
  levels?: readonly TelemetryIncidentLevel[];
  runId?: string;
  /** A normalized run reference (`normalizeRunReference`): incidents of every run id starting with it. */
  runIdPrefix?: string;
  traceId?: string;
  /** Incidents of one internal user id. */
  userId?: string;
  /** Opaque position from a previous page. */
  cursor?: string | null;
  limit?: number;
}>;

export type TelemetryIncident = TelemetryIncidentInput & Readonly<{ id: string }>;
export type TelemetryIncidentPage = Readonly<{ items: readonly TelemetryIncident[]; nextCursor: string | null }>;

/** A range of incidents: inclusive start, exclusive end. */
export type TelemetryIncidentRange = Readonly<{ from: Date; to: Date }>;

/**
 * Retained incidents of one group with their distinct user and run ids.
 * Incidents are a rate-limited, trimmed sample of the failures, so each count
 * is a lower bound of the failure's true reach.
 */
export type TelemetryIncidentReach = Readonly<{ incidents: number; users: number; runs: number }>;

/** The incident key retention trims by. */
export type TelemetryIncidentKey = Readonly<{
  event: string; code: string | null; subsystem: string | null; connectionId: string | null; fingerprint: string | null;
}>;

export type TelemetryIncidentKeyReach = TelemetryIncidentReach & Readonly<{
  key: TelemetryIncidentKey; firstAt: Date; lastAt: Date;
}>;

export type TelemetryRetentionResult = Readonly<{ counters: number; incidents: number }>;

export type TelemetryStore = Readonly<{
  /** Adds one batch in one transaction; concurrent writers sum per key. */
  write(batch: TelemetryBatch): Promise<void>;
  deleteExpired(now: Date): Promise<TelemetryRetentionResult>;
  readCounters(query: TelemetryCounterQuery): Promise<readonly TelemetryCounterGroup[]>;
  readIncidents(query: TelemetryIncidentQuery): Promise<TelemetryIncidentPage>;
  /** Retained incidents per run id (at most 64 ids); ids without incidents are absent. */
  countIncidentsByRun(runIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Reach per error fingerprint (at most 64) over a range; fingerprints without incidents are absent. */
  countIncidentReachByFingerprint(
    query: TelemetryIncidentRange & Readonly<{ fingerprints: readonly string[] }>
  ): Promise<ReadonlyMap<string, TelemetryIncidentReach>>;
  /** Reach per incident key over a range, most incidents first (at most `limit`, default 100). */
  countIncidentReachByKey(query: TelemetryIncidentRange & Readonly<{ limit?: number }>): Promise<readonly TelemetryIncidentKeyReach[]>;
  /**
   * The first incident of each incident key within a range, newest first, at
   * most `limit` (default 100, at most 1,000); `truncated` when more keys exist.
   */
  readFirstIncidentPerKey(
    query: TelemetryIncidentRange & Readonly<{ limit?: number }>
  ): Promise<Readonly<{ items: readonly TelemetryIncident[]; truncated: boolean }>>;
}>;

export type TelemetryDatabase = Pick<PrismaClient, "$executeRaw" | "$queryRaw" | "$transaction">;

export class TelemetryQueryError extends Error {
  readonly code = "telemetry_query_invalid";
  constructor() {
    super("telemetry_query_invalid");
    this.name = "TelemetryQueryError";
  }
}

/**
 * Clears a deleted account's id from its incidents inside the deleting
 * transaction: telemetry keeps no foreign key on users, so that a write never
 * fails on a deleted account. One indexed statement over a bounded table.
 */
export function clearTelemetryIncidentUser(tx: Pick<PrismaClient, "$executeRaw">, userId: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`UPDATE "TelemetryIncident" SET "userId" = NULL WHERE "userId" = ${userId}`);
}

/** A rejected value (SQLSTATE class 22 or 23) fails the same way on every
 * retry, so its batch is dropped instead of blocking all later telemetry. */
export function telemetryWriteIsPermanent(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010" &&
    /^2[23]/u.test(String(error.meta?.code ?? ""));
}

export function telemetryDimensionHash(dimensions: TelemetryDimensions): string {
  return createHash("sha256").update(telemetryDimensionsJson(dimensions)).digest("hex");
}

const levels = new Set<string>(TELEMETRY_LEVELS);
const groupKeys = new Set<string>(TELEMETRY_GROUP_KEYS);
const dimensionKeys = new Set<string>(TELEMETRY_DIMENSIONS);
const columns: Readonly<Record<string, string>> = { role: "role", event: "event", level: "level", appVersion: "appVersion" };
const eventPattern = /^[a-z][a-z0-9_.]{0,63}$/u;
const namePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const tracePattern = /^[0-9a-f]{32}$/u;
const fingerprintPattern = /^[0-9a-f]{12}$/u;
const printable = /^[\x20-\x7e]{1,512}$/u;

const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;
const bucketIndexes = Array.from({ length: TELEMETRY_DURATION_BUCKETS }, (_, index) => index + 1);
const mergedBuckets = Prisma.raw(bucketIndexes
  .map((index) => `"TelemetryCounter"."durationBuckets"[${index}] + EXCLUDED."durationBuckets"[${index}]`).join(", "));
const summedBuckets = Prisma.raw(bucketIndexes.map((index) => `SUM("durationBuckets"[${index}])::bigint`).join(", "));

function invalid(): never {
  throw new TelemetryQueryError();
}

function validDate(value: unknown): Date {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : invalid();
}

function list(values: readonly string[] | undefined, pattern: RegExp): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > 64 ||
    !values.every((value) => typeof value === "string" && pattern.test(value))) invalid();
  return values;
}

function limit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : invalid();
}

function number(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

function sortedRows<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return rows.map((row) => ({ key: key(row), row }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    .map(({ row }) => row);
}

function counterRow(delta: TelemetryCounterDelta, hash: string): Prisma.Sql {
  return Prisma.sql`(
    ${utc(delta.bucketStart)}, ${delta.role}, ${delta.event}, ${delta.level}, ${delta.appVersion}, ${hash},
    ${telemetryDimensionsJson(delta.dimensions)}::jsonb, ${delta.count}::bigint, ${delta.valueSum}::bigint,
    ${delta.durationCount}::bigint, ${Math.round(delta.durationSumMs)}::bigint,
    ${delta.durationMaxMs === null ? null : Math.round(delta.durationMaxMs)}::bigint,
    ${delta.durationBuckets.map((value) => Math.round(value))}::bigint[],
    ${utc(delta.firstSeenAt)}, ${utc(delta.lastSeenAt)}
  )`;
}

function upsertCounters(rows: readonly Prisma.Sql[]): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "TelemetryCounter" (
      "bucketStart", "role", "event", "level", "appVersion", "dimensionHash", "dimensions",
      "count", "valueSum", "durationCount", "durationSumMs", "durationMaxMs", "durationBuckets",
      "firstSeenAt", "lastSeenAt"
    ) VALUES ${Prisma.join(rows)}
    ON CONFLICT ("bucketStart", "role", "event", "level", "appVersion", "dimensionHash") DO UPDATE SET
      "count" = "TelemetryCounter"."count" + EXCLUDED."count",
      "valueSum" = "TelemetryCounter"."valueSum" + EXCLUDED."valueSum",
      "durationCount" = "TelemetryCounter"."durationCount" + EXCLUDED."durationCount",
      "durationSumMs" = "TelemetryCounter"."durationSumMs" + EXCLUDED."durationSumMs",
      "durationMaxMs" = GREATEST("TelemetryCounter"."durationMaxMs", EXCLUDED."durationMaxMs"),
      "durationBuckets" = ARRAY[${mergedBuckets}]::bigint[],
      "firstSeenAt" = LEAST("TelemetryCounter"."firstSeenAt", EXCLUDED."firstSeenAt"),
      "lastSeenAt" = GREATEST("TelemetryCounter"."lastSeenAt", EXCLUDED."lastSeenAt")
  `;
}

function insertIncidents(incidents: readonly TelemetryIncidentInput[]): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "TelemetryIncident" (
      "id", "occurredAt", "role", "event", "level", "appVersion", "instanceId",
      "code", "subsystem", "connectionId", "runId", "traceId", "userId", "details"
    ) VALUES ${Prisma.join(incidents.map((incident) => Prisma.sql`(
      ${randomUUID()}, ${utc(incident.occurredAt)}, ${incident.role}, ${incident.event}, ${incident.level},
      ${incident.appVersion}, ${incident.instanceId}, ${incident.code}, ${incident.subsystem},
      ${incident.connectionId}, ${incident.runId}, ${incident.traceId}, ${incident.userId},
      ${JSON.stringify(incident.details)}::jsonb
    )`))}
  `;
}

function incidentRange(query: TelemetryIncidentRange): Prisma.Sql {
  const from = validDate(query.from);
  const to = validDate(query.to);
  if (from.getTime() >= to.getTime()) invalid();
  return Prisma.sql`"occurredAt" >= ${utc(from)} AND "occurredAt" < ${utc(to)}`;
}

function reach(row: Readonly<{ incidents: unknown; users: unknown; runs: unknown }>): TelemetryIncidentReach {
  return Object.freeze({ incidents: number(row.incidents), users: number(row.users), runs: number(row.runs) });
}

function chunks<T>(rows: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += ROWS_PER_STATEMENT) result.push(rows.slice(index, index + ROWS_PER_STATEMENT));
  return result;
}

function groupExpression(key: TelemetryGroupKey, interval: "hour" | "day"): Prisma.Sql {
  if (key === "bucket") return interval === "day" ? Prisma.sql`date_trunc('day', "bucketStart")` : Prisma.sql`"bucketStart"`;
  return Object.hasOwn(columns, key) ? Prisma.raw(`"${columns[key]}"`) : Prisma.sql`"dimensions" -> ${key}`;
}

function counterConditions(query: TelemetryCounterQuery): Prisma.Sql[] {
  const from = validDate(query.from);
  const to = validDate(query.to);
  if (from.getTime() >= to.getTime()) invalid();
  const conditions = [Prisma.sql`"bucketStart" >= ${utc(from)}`, Prisma.sql`"bucketStart" < ${utc(to)}`];
  const events = list(query.events, eventPattern);
  const roles = list(query.roles, namePattern);
  if (query.levels !== undefined && (!Array.isArray(query.levels) || query.levels.length === 0 ||
    !query.levels.every((level) => levels.has(level)))) invalid();
  if (events) conditions.push(Prisma.sql`"event" = ANY(${events}::text[])`);
  if (roles) conditions.push(Prisma.sql`"role" = ANY(${roles}::text[])`);
  if (query.levels) conditions.push(Prisma.sql`"level" = ANY(${query.levels}::text[])`);
  if (query.dimensions !== undefined) {
    const entries = Object.entries(query.dimensions);
    if (entries.length === 0 || !entries.every(([key, value]) => dimensionKeys.has(key) &&
      (typeof value === "string" && printable.test(value) || typeof value === "number" && Number.isSafeInteger(value)))) invalid();
    conditions.push(Prisma.sql`"dimensions" @> ${JSON.stringify(Object.fromEntries(entries))}::jsonb`);
  }
  return conditions;
}

type CounterRow = Record<string, unknown> & {
  count: unknown; valueSum: unknown; durationCount: unknown; durationSumMs: unknown; durationMaxMs: unknown;
  durationBuckets: unknown; firstSeenAt: Date; lastSeenAt: Date;
};

type IncidentRow = Omit<TelemetryIncident, "details" | "level"> & { level: string; details: unknown };

function encodeCursor(incident: Pick<TelemetryIncident, "id" | "occurredAt">): string {
  return Buffer.from(JSON.stringify([incident.occurredAt.toISOString(), incident.id])).toString("base64url");
}

function decodeCursor(cursor: string): Readonly<{ occurredAt: Date; id: string }> {
  try {
    if (cursor.length > 256) invalid();
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) invalid();
    const [time, id] = value as unknown[];
    if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(time) ||
      typeof id !== "string" || !/^[0-9a-f-]{36}$/u.test(id)) invalid();
    return { occurredAt: validDate(new Date(time)), id };
  } catch {
    return invalid();
  }
}

function incidentConditions(query: TelemetryIncidentQuery): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (query.from !== undefined) conditions.push(Prisma.sql`"occurredAt" >= ${utc(validDate(query.from))}`);
  if (query.to !== undefined) conditions.push(Prisma.sql`"occurredAt" < ${utc(validDate(query.to))}`);
  const filters: ReadonlyArray<readonly [string, readonly string[] | undefined]> = [
    ["event", list(query.events, eventPattern)],
    ["code", list(query.codes, codePattern)],
    ["subsystem", list(query.subsystems, namePattern)],
    ["connectionId", list(query.connectionIds, identifierPattern)],
    ["level", list(query.levels, /^(?:error|fatal)$/u)]
  ];
  for (const [column, values] of filters) {
    if (values) conditions.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ANY(${values}::text[])`);
  }
  if (query.runId !== undefined) {
    if (typeof query.runId !== "string" || !identifierPattern.test(query.runId)) invalid();
    conditions.push(Prisma.sql`"runId" = ${query.runId}`);
  }
  if (query.runIdPrefix !== undefined) {
    const prefix = query.runIdPrefix;
    if (typeof prefix !== "string" || normalizeRunReference(prefix) !== prefix) invalid();
    const range = runReferenceRange(prefix);
    conditions.push(Prisma.sql`"runId" >= ${range.lower} AND "runId" < ${range.upper} AND starts_with("runId", ${prefix})`);
  }
  if (query.traceId !== undefined) {
    if (typeof query.traceId !== "string" || !tracePattern.test(query.traceId)) invalid();
    conditions.push(Prisma.sql`"traceId" = ${query.traceId}`);
  }
  if (query.userId !== undefined) {
    if (typeof query.userId !== "string" || !identifierPattern.test(query.userId)) invalid();
    conditions.push(Prisma.sql`"userId" = ${query.userId}`);
  }
  if (query.cursor !== undefined && query.cursor !== null) {
    if (typeof query.cursor !== "string") invalid();
    const position = decodeCursor(query.cursor);
    conditions.push(Prisma.sql`("occurredAt", "id") < (${utc(position.occurredAt)}, ${position.id})`);
  }
  return conditions;
}

function details(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean"));
}

function incidentFromRow(row: IncidentRow): TelemetryIncident {
  return Object.freeze({
    ...row,
    level: row.level === "fatal" ? "fatal" : "error",
    details: Object.freeze(details(row.details))
  });
}

export function createPrismaTelemetryStore(db: TelemetryDatabase): TelemetryStore {
  /** Repeats a statement over at most one batch of rows until a batch comes up short. */
  const inBatches = async (statement: Prisma.Sql): Promise<number> => {
    let total = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const affected = await db.$executeRaw(statement);
      total += affected;
      if (affected < RETENTION_BATCH_ROWS) break;
    }
    return total;
  };

  /**
   * Deletes a storm's surplus: per UTC day and incident key, rows with more than
   * the edge count of rows both before and after them in one snapshot. Writers
   * may add rows meanwhile and passes may overlap, yet no snapshot ever holds
   * that many rows before the day's overall first ones or after its latest
   * ones, so those always stay. One ranking per pass, then bounded deletes by
   * id in a stable order.
   */
  const trimRepeatedIncidents = async (): Promise<number> => {
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM (
        SELECT "id",
          row_number() OVER (PARTITION BY ${incidentKeyDay} ORDER BY "occurredAt", "id") AS "position",
          count(*) OVER (PARTITION BY ${incidentKeyDay}) AS "rows"
        FROM "TelemetryIncident"
      ) AS "ranked"
      WHERE "position" > ${KEY_DAY_EDGE_ROWS} AND "position" <= "rows" - ${KEY_DAY_EDGE_ROWS}
      LIMIT ${RETENTION_BATCH_ROWS * RETENTION_MAX_BATCHES}
    `);
    const ids = rows.map((row) => row.id).sort();
    let total = 0;
    for (let index = 0; index < ids.length; index += RETENTION_BATCH_ROWS) {
      total += await db.$executeRaw(Prisma.sql`
        DELETE FROM "TelemetryIncident" WHERE "id" = ANY(${ids.slice(index, index + RETENTION_BATCH_ROWS)}::text[])
      `);
    }
    return total;
  };

  return Object.freeze({
    async write(batch: TelemetryBatch): Promise<void> {
      // One global key order for every writer: concurrent flushes from several
      // processes lock shared keys in the same order and cannot deadlock.
      const counters = sortedRows(batch.counters.map((delta) => ({ delta, hash: telemetryDimensionHash(delta.dimensions) })),
        ({ delta, hash }) => [delta.bucketStart.toISOString(), delta.role, delta.event, delta.level, delta.appVersion, hash].join("\u0000"));
      const statements = [
        ...chunks(counters).map((rows) => upsertCounters(rows.map(({ delta, hash }) => counterRow(delta, hash)))),
        ...chunks(batch.incidents).map(insertIncidents)
      ];
      if (statements.length === 0) return;
      try {
        await db.$transaction(statements.map((statement) => db.$executeRaw(statement)));
      } catch (error) {
        retainDatabaseFailure(error);
      }
    },

    async deleteExpired(now: Date): Promise<TelemetryRetentionResult> {
      const time = validDate(now).getTime();
      try {
        const counters = await inBatches(Prisma.sql`
          DELETE FROM "TelemetryCounter"
          WHERE ("bucketStart", "role", "event", "level", "appVersion", "dimensionHash") IN (
            SELECT "bucketStart", "role", "event", "level", "appVersion", "dimensionHash"
            FROM "TelemetryCounter"
            WHERE "bucketStart" < ${utc(new Date(time - TELEMETRY_COUNTER_RETENTION_MS))}
            ORDER BY "bucketStart"
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        const expired = await inBatches(Prisma.sql`
          DELETE FROM "TelemetryIncident"
          WHERE "id" IN (
            SELECT "id" FROM "TelemetryIncident"
            WHERE "occurredAt" < ${utc(new Date(time - TELEMETRY_INCIDENT_RETENTION_MS))}
            ORDER BY "occurredAt", "id"
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        // Age, then a storm's surplus, then the global cap: the cap stays the
        // last resort and no longer evicts other errors' incidents for a storm.
        const trimmed = await trimRepeatedIncidents();
        const surplus = await inBatches(Prisma.sql`
          DELETE FROM "TelemetryIncident"
          WHERE "id" IN (
            SELECT "id" FROM "TelemetryIncident"
            ORDER BY "occurredAt" DESC, "id" DESC
            OFFSET ${TELEMETRY_INCIDENT_MAX_ROWS}
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        // Account deletion clears its user's ids in its own transaction; this
        // clears any a process still held in its batch and wrote afterwards.
        await inBatches(Prisma.sql`
          UPDATE "TelemetryIncident" SET "userId" = NULL
          WHERE "id" IN (
            SELECT incident."id" FROM "TelemetryIncident" AS incident
            WHERE incident."userId" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM "User" AS account WHERE account."id" = incident."userId")
            ORDER BY incident."id"
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        return { counters, incidents: expired + trimmed + surplus };
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async readCounters(query: TelemetryCounterQuery): Promise<readonly TelemetryCounterGroup[]> {
      const conditions = counterConditions(query);
      const groupBy = query.groupBy ?? [];
      if (!Array.isArray(groupBy) || groupBy.length > MAX_GROUP_KEYS || new Set(groupBy).size !== groupBy.length ||
        !groupBy.every((key) => groupKeys.has(key))) invalid();
      const interval = query.interval ?? "hour";
      if (interval !== "hour" && interval !== "day") invalid();
      const rows = limit(query.limit, 1_000, 5_000);
      const selected = groupBy.map((key, index) => Prisma.sql`${groupExpression(key, interval)} AS ${Prisma.raw(`"g${index}"`)}`);
      const positions = groupBy.map((_, index) => String(index + 1));
      const countPosition = String(groupBy.length + 1);
      const bucketPosition = groupBy.indexOf("bucket");
      const order = bucketPosition === -1
        ? [`${countPosition} DESC`, ...positions]
        : [String(bucketPosition + 1), `${countPosition} DESC`, ...positions.filter((_, index) => index !== bucketPosition)];
      try {
        const result = await db.$queryRaw<CounterRow[]>(Prisma.sql`
          SELECT
            ${Prisma.join([...selected, Prisma.sql`SUM("count")::bigint AS "count"`], ", ")},
            SUM("valueSum")::bigint AS "valueSum",
            SUM("durationCount")::bigint AS "durationCount",
            SUM("durationSumMs")::bigint AS "durationSumMs",
            MAX("durationMaxMs") AS "durationMaxMs",
            ARRAY[${summedBuckets}]::bigint[] AS "durationBuckets",
            MIN("firstSeenAt") AS "firstSeenAt",
            MAX("lastSeenAt") AS "lastSeenAt"
          FROM "TelemetryCounter"
          WHERE ${Prisma.join(conditions, " AND ")}
          ${groupBy.length > 0 ? Prisma.sql`GROUP BY ${Prisma.raw(positions.join(", "))}` : Prisma.empty}
          ORDER BY ${Prisma.raw(order.join(", "))}
          LIMIT ${rows}
        `);
        return result.filter((row) => row.count !== null).map((row) => Object.freeze({
          group: Object.freeze(Object.fromEntries(groupBy.map((key, index) => {
            const value = row[`g${index}`];
            return [key, value instanceof Date || typeof value === "string" || typeof value === "number" ||
              typeof value === "boolean" ? value : null];
          }))),
          count: number(row.count),
          valueSum: number(row.valueSum),
          durationCount: number(row.durationCount),
          durationSumMs: number(row.durationSumMs),
          durationMaxMs: row.durationMaxMs === null ? null : number(row.durationMaxMs),
          durationBuckets: Object.freeze(Array.isArray(row.durationBuckets) ? row.durationBuckets.map(number) : []),
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt
        }));
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async readIncidents(query: TelemetryIncidentQuery): Promise<TelemetryIncidentPage> {
      const conditions = incidentConditions(query);
      const pageSize = limit(query.limit, 50, 200);
      try {
        const rows = await db.$queryRaw<IncidentRow[]>(Prisma.sql`
          SELECT ${incidentColumns}
          FROM "TelemetryIncident"
          ${conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty}
          ORDER BY "occurredAt" DESC, "id" DESC
          LIMIT ${pageSize + 1}
        `);
        const items = rows.slice(0, pageSize).map(incidentFromRow);
        const last = items.at(-1);
        return { items, nextCursor: rows.length > pageSize && last ? encodeCursor(last) : null };
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async countIncidentsByRun(runIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
      const ids = list(runIds, identifierPattern) ?? invalid();
      try {
        const rows = await db.$queryRaw<Array<{ runId: string; count: bigint | number }>>(Prisma.sql`
          SELECT "runId", COUNT(*)::bigint AS "count"
          FROM "TelemetryIncident"
          WHERE "runId" = ANY(${ids}::text[])
          GROUP BY "runId"
        `);
        return new Map(rows.map((row) => [row.runId, number(row.count)]));
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async countIncidentReachByFingerprint(
      query: TelemetryIncidentRange & Readonly<{ fingerprints: readonly string[] }>
    ): Promise<ReadonlyMap<string, TelemetryIncidentReach>> {
      const range = incidentRange(query);
      const fingerprints = list(query.fingerprints, fingerprintPattern) ?? invalid();
      try {
        const rows = await db.$queryRaw<Array<{ fingerprint: string; incidents: unknown; users: unknown; runs: unknown }>>(Prisma.sql`
          SELECT "details" ->> 'error_fingerprint' AS "fingerprint", COUNT(*)::bigint AS "incidents",
            COUNT(DISTINCT "userId")::bigint AS "users", COUNT(DISTINCT "runId")::bigint AS "runs"
          FROM "TelemetryIncident"
          WHERE ${range} AND "details" ->> 'error_fingerprint' = ANY(${fingerprints}::text[])
          GROUP BY 1
        `);
        return new Map(rows.map((row) => [row.fingerprint, reach(row)]));
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async countIncidentReachByKey(
      query: TelemetryIncidentRange & Readonly<{ limit?: number }>
    ): Promise<readonly TelemetryIncidentKeyReach[]> {
      const range = incidentRange(query);
      const rows = limit(query.limit, 100, 1_000);
      try {
        const result = await db.$queryRaw<Array<TelemetryIncidentKey & {
          incidents: unknown; users: unknown; runs: unknown; firstAt: Date; lastAt: Date;
        }>>(Prisma.sql`
          SELECT "event", "code", "subsystem", "connectionId", "details" ->> 'error_fingerprint' AS "fingerprint",
            COUNT(*)::bigint AS "incidents", COUNT(DISTINCT "userId")::bigint AS "users",
            COUNT(DISTINCT "runId")::bigint AS "runs", MIN("occurredAt") AS "firstAt", MAX("occurredAt") AS "lastAt"
          FROM "TelemetryIncident"
          WHERE ${range}
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY "incidents" DESC, "lastAt" DESC, 1, 2, 3, 4, 5
          LIMIT ${rows}
        `);
        return result.map((row) => Object.freeze({
          key: Object.freeze({ event: row.event, code: row.code, subsystem: row.subsystem, connectionId: row.connectionId,
            fingerprint: row.fingerprint }),
          ...reach(row),
          firstAt: row.firstAt,
          lastAt: row.lastAt
        }));
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async readFirstIncidentPerKey(
      query: TelemetryIncidentRange & Readonly<{ limit?: number }>
    ): Promise<Readonly<{ items: readonly TelemetryIncident[]; truncated: boolean }>> {
      const range = incidentRange(query);
      const rows = limit(query.limit, 100, 1_000);
      try {
        const result = await db.$queryRaw<IncidentRow[]>(Prisma.sql`
          SELECT ${incidentColumns} FROM (
            SELECT DISTINCT ON (${incidentKey}) ${incidentColumns}
            FROM "TelemetryIncident"
            WHERE ${range}
            ORDER BY ${incidentKey}, "occurredAt", "id"
          ) AS "first"
          ORDER BY "occurredAt" DESC, "id" DESC
          LIMIT ${rows + 1}
        `);
        return { items: result.slice(0, rows).map(incidentFromRow), truncated: result.length > rows };
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    }
  });
}
