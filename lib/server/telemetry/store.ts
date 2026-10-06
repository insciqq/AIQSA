import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import {
  TELEMETRY_DIMENSIONS, TELEMETRY_DURATION_BUCKETS, TELEMETRY_LEVELS, telemetryDimensionsJson,
  type TelemetryBatch, type TelemetryCounterDelta, type TelemetryDimension, type TelemetryDimensionValue,
  type TelemetryDimensions, type TelemetryIncidentInput, type TelemetryIncidentLevel, type TelemetryLevel
} from "./aggregator";

/** Retention owned by code (Persistence): counters for 30 days; incidents for
 * 14 days and never beyond the newest 50,000 rows. */
export const TELEMETRY_COUNTER_RETENTION_MS = 30 * 24 * 3_600_000;
export const TELEMETRY_INCIDENT_RETENTION_MS = 14 * 24 * 3_600_000;
export const TELEMETRY_INCIDENT_MAX_ROWS = 50_000;
const RETENTION_BATCH_ROWS = 1_000;
const RETENTION_MAX_BATCHES = 20;
const ROWS_PER_STATEMENT = 500;

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
  traceId?: string;
  /** Opaque position from a previous page. */
  cursor?: string | null;
  limit?: number;
}>;

export type TelemetryIncident = TelemetryIncidentInput & Readonly<{ id: string }>;
export type TelemetryIncidentPage = Readonly<{ items: readonly TelemetryIncident[]; nextCursor: string | null }>;

export type TelemetryRetentionResult = Readonly<{ counters: number; incidents: number }>;

export type TelemetryStore = Readonly<{
  /** Adds one batch in one transaction; concurrent writers sum per key. */
  write(batch: TelemetryBatch): Promise<void>;
  deleteExpired(now: Date): Promise<TelemetryRetentionResult>;
  readCounters(query: TelemetryCounterQuery): Promise<readonly TelemetryCounterGroup[]>;
  readIncidents(query: TelemetryIncidentQuery): Promise<TelemetryIncidentPage>;
}>;

export type TelemetryDatabase = Pick<PrismaClient, "$executeRaw" | "$queryRaw" | "$transaction">;

export class TelemetryQueryError extends Error {
  readonly code = "telemetry_query_invalid";
  constructor() {
    super("telemetry_query_invalid");
    this.name = "TelemetryQueryError";
  }
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
      "code", "subsystem", "connectionId", "runId", "traceId", "details"
    ) VALUES ${Prisma.join(incidents.map((incident) => Prisma.sql`(
      ${randomUUID()}, ${utc(incident.occurredAt)}, ${incident.role}, ${incident.event}, ${incident.level},
      ${incident.appVersion}, ${incident.instanceId}, ${incident.code}, ${incident.subsystem},
      ${incident.connectionId}, ${incident.runId}, ${incident.traceId}, ${JSON.stringify(incident.details)}::jsonb
    )`))}
  `;
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
  if (query.traceId !== undefined) {
    if (typeof query.traceId !== "string" || !tracePattern.test(query.traceId)) invalid();
    conditions.push(Prisma.sql`"traceId" = ${query.traceId}`);
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

export function createPrismaTelemetryStore(db: TelemetryDatabase): TelemetryStore {
  const deleteInBatches = async (statement: Prisma.Sql): Promise<number> => {
    let total = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const deleted = await db.$executeRaw(statement);
      total += deleted;
      if (deleted < RETENTION_BATCH_ROWS) break;
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
        const counters = await deleteInBatches(Prisma.sql`
          DELETE FROM "TelemetryCounter"
          WHERE ("bucketStart", "role", "event", "level", "appVersion", "dimensionHash") IN (
            SELECT "bucketStart", "role", "event", "level", "appVersion", "dimensionHash"
            FROM "TelemetryCounter"
            WHERE "bucketStart" < ${utc(new Date(time - TELEMETRY_COUNTER_RETENTION_MS))}
            ORDER BY "bucketStart"
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        const expired = await deleteInBatches(Prisma.sql`
          DELETE FROM "TelemetryIncident"
          WHERE "id" IN (
            SELECT "id" FROM "TelemetryIncident"
            WHERE "occurredAt" < ${utc(new Date(time - TELEMETRY_INCIDENT_RETENTION_MS))}
            ORDER BY "occurredAt", "id"
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        const surplus = await deleteInBatches(Prisma.sql`
          DELETE FROM "TelemetryIncident"
          WHERE "id" IN (
            SELECT "id" FROM "TelemetryIncident"
            ORDER BY "occurredAt" DESC, "id" DESC
            OFFSET ${TELEMETRY_INCIDENT_MAX_ROWS}
            LIMIT ${RETENTION_BATCH_ROWS}
          )
        `);
        return { counters, incidents: expired + surplus };
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    },

    async readCounters(query: TelemetryCounterQuery): Promise<readonly TelemetryCounterGroup[]> {
      const conditions = counterConditions(query);
      const groupBy = query.groupBy ?? [];
      if (!Array.isArray(groupBy) || groupBy.length > 8 || new Set(groupBy).size !== groupBy.length ||
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
          SELECT "id", "occurredAt", "role", "event", "level", "appVersion", "instanceId",
            "code", "subsystem", "connectionId", "runId", "traceId", "details"
          FROM "TelemetryIncident"
          ${conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty}
          ORDER BY "occurredAt" DESC, "id" DESC
          LIMIT ${pageSize + 1}
        `);
        const items = rows.slice(0, pageSize).map((row): TelemetryIncident => Object.freeze({
          ...row,
          level: row.level === "fatal" ? "fatal" : "error",
          details: Object.freeze(details(row.details))
        }));
        const last = items.at(-1);
        return { items, nextCursor: rows.length > pageSize && last ? encodeCursor(last) : null };
      } catch (error) {
        return retainDatabaseFailure(error);
      }
    }
  });
}
