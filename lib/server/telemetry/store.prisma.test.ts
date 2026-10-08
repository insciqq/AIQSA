// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../observability";
import { prisma } from "../prisma";
import {
  TELEMETRY_DURATION_BUCKETS, telemetryDurationBucket, type TelemetryCounterDelta, type TelemetryIncidentInput
} from "./aggregator";
import { createTelemetryRecorder } from "./recorder";
import {
  createPrismaTelemetryStore, TELEMETRY_INCIDENT_KEY_DAY_ROWS, TELEMETRY_INCIDENT_MAX_ROWS, telemetryDimensionHash,
  telemetryWriteIsPermanent
} from "./store";

// Every row this file writes carries its own version or connection, and only
// those rows are removed after each case, so no case sees another's rows.
const VERSION = `telemetry-test-${randomUUID()}`;
const CONNECTION = `telemetry-test-${randomBytes(8).toString("hex")}`;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const store = createPrismaTelemetryStore(prisma);
const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const BUCKET = new Date(currentHour - 2 * HOUR_MS);
const currentDay = Math.floor(Date.now() / DAY_MS) * DAY_MS;

/** Bulk-inserts `rows` incidents `stepMs` apart from `start`; `spread` > 1
 * cycles the code through that many distinct keys. */
async function insertIncidents(input: Readonly<{
  rows: number; start: number; stepMs: number; code: string; spread?: number;
  event?: string; subsystem?: string | null; fingerprint?: string | null;
}>): Promise<void> {
  const details = input.fingerprint ? { error_fingerprint: input.fingerprint } : {};
  const spread = input.spread ?? 1;
  await prisma.$executeRaw`
    INSERT INTO "TelemetryIncident" (
      "id", "occurredAt", "role", "event", "level", "appVersion", "instanceId", "code", "subsystem", "connectionId", "details"
    )
    SELECT gen_random_uuid()::text,
      (${new Date(input.start)}::timestamptz AT TIME ZONE 'UTC') + make_interval(secs => series * ${input.stepMs / 1000}::float8),
      'app', ${input.event ?? "provider_operation"}::text, 'error', ${VERSION}::text, ${"a".repeat(32)}::text,
      CASE WHEN ${spread}::int = 1 THEN ${input.code}::text ELSE ${input.code}::text || '_' || (series % ${spread}::int) END,
      ${input.subsystem ?? null}::text, ${CONNECTION}::text, ${JSON.stringify(details)}::jsonb
    FROM generate_series(0, ${input.rows - 1}::int) AS series`;
}

function delta(input: Readonly<{
  code: string; count?: number; durationMs?: number; at?: number; bucket?: Date; event?: string;
  dimensions?: Record<string, string | number | boolean>; level?: TelemetryCounterDelta["level"];
}>): TelemetryCounterDelta {
  const bucket = input.bucket ?? BUCKET;
  const seen = new Date(bucket.getTime() + (input.at ?? 0));
  const durationBuckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  if (input.durationMs !== undefined) durationBuckets[telemetryDurationBucket(input.durationMs)] = 1;
  return {
    bucketStart: bucket, role: "app", event: input.event ?? "provider_operation", level: input.level ?? "error",
    appVersion: VERSION, dimensions: input.dimensions ?? { code: input.code, connectionId: CONNECTION },
    count: input.count ?? 1, valueSum: 0, durationCount: input.durationMs === undefined ? 0 : 1,
    durationSumMs: input.durationMs ?? 0, durationMaxMs: input.durationMs ?? null, durationBuckets,
    firstSeenAt: seen, lastSeenAt: seen
  };
}

function incident(input: Readonly<{ at: number; code?: string; runId?: string; traceId?: string; level?: "error" | "fatal" }>): TelemetryIncidentInput {
  return {
    occurredAt: new Date(input.at), role: "app", event: "provider_operation", level: input.level ?? "error",
    appVersion: VERSION, instanceId: "a".repeat(32), code: input.code ?? "provider_http_dns_failed", subsystem: null,
    connectionId: CONNECTION, runId: input.runId ?? null, traceId: input.traceId ?? null,
    details: { httpStatus: 401, stage: "answer" }
  };
}

async function removeOwnRows(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "TelemetryCounter" WHERE "appVersion" = ${VERSION} OR "dimensions" ->> 'connectionId' = ${CONNECTION}`;
  await prisma.$executeRaw`DELETE FROM "TelemetryIncident" WHERE "appVersion" = ${VERSION} OR "connectionId" = ${CONNECTION}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await removeOwnRows();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Prisma telemetry store", () => {
  it("sums concurrent writers into one row per key", async () => {
    const codes = Array.from({ length: 40 }, (_, index) => `code_${String(index).padStart(2, "0")}`);
    // Six processes flush overlapping keys at once, each in its own order.
    await Promise.all(Array.from({ length: 6 }, (_, writer) => store.write({
      counters: (writer % 2 === 0 ? codes : [...codes].reverse())
        .map((code) => delta({ code, count: writer + 1, durationMs: (writer + 1) * 100, at: writer * 1_000 })),
      incidents: [],
      lostObservations: 0
    })));

    const [shape] = await prisma.$queryRaw<Array<{ rows: number; keys: number }>>`
      SELECT count(*)::int AS rows, count(DISTINCT "dimensionHash")::int AS keys
      FROM "TelemetryCounter" WHERE "appVersion" = ${VERSION}`;
    expect(shape).toEqual({ rows: 40, keys: 40 });
    const groups = await store.readCounters({ from: BUCKET, to: new Date(currentHour), roles: ["app"],
      dimensions: { connectionId: CONNECTION }, groupBy: ["bucket", "code"] });
    expect(groups).toHaveLength(40);
    for (const group of groups) {
      expect(group).toEqual({
        group: { bucket: BUCKET, code: expect.stringMatching(/^code_\d{2}$/u) },
        count: 21, valueSum: 0, durationCount: 6, durationSumMs: 2_100, durationMaxMs: 600,
        durationBuckets: [1, 1, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0],
        firstSeenAt: BUCKET, lastSeenAt: new Date(BUCKET.getTime() + 5_000)
      });
    }
    const [stored] = await prisma.$queryRaw<Array<{ dimensionHash: string; dimensions: unknown }>>`
      SELECT "dimensionHash", "dimensions" FROM "TelemetryCounter"
      WHERE "appVersion" = ${VERSION} AND "dimensions" ->> 'code' = 'code_00'`;
    expect(stored).toEqual({
      dimensionHash: telemetryDimensionHash({ code: "code_00", connectionId: CONNECTION }),
      dimensions: { code: "code_00", connectionId: CONNECTION }
    });
  });

  it("reads counters by range, filters and hour or day groups", async () => {
    const earlier = new Date(BUCKET.getTime() - HOUR_MS);
    await store.write({
      counters: [
        delta({ code: "provider_http_dns_failed", bucket: earlier, dimensions: { code: "provider_http_dns_failed", connectionId: CONNECTION, httpStatus: 503 } }),
        delta({ code: "provider_http_dns_failed", count: 2, dimensions: { code: "provider_http_dns_failed", connectionId: CONNECTION, httpStatus: 503 } }),
        delta({ code: "completed", level: "info", count: 5, durationMs: 40 }),
        delta({ code: "overflow", event: "http.request_completed", level: "warn", count: 3, dimensions: { overflow: true } })
      ],
      incidents: [],
      lostObservations: 0
    });
    const range = { from: earlier, to: new Date(currentHour) };
    const failures = await store.readCounters({ ...range, events: ["provider_operation"], levels: ["error"],
      dimensions: { connectionId: CONNECTION, httpStatus: 503 }, groupBy: ["bucket", "httpStatus"] });
    expect(failures.map((group) => [group.group.bucket, group.group.httpStatus, group.count]))
      .toEqual([[earlier, 503, 1], [BUCKET, 503, 2]]);
    const daily = await store.readCounters({ ...range, events: ["provider_operation"],
      dimensions: { connectionId: CONNECTION }, groupBy: ["bucket", "level"], interval: "day" });
    expect(daily.reduce((sum, group) => sum + group.count, 0)).toBe(8);
    for (const group of daily) {
      const day = group.group.bucket as Date;
      expect(day.getTime() % DAY_MS).toBe(0);
    }
    // Readers group by overflow to show totals that lost their dimensions.
    const grouped = await store.readCounters({ ...range, events: ["http.request_completed"], roles: ["app"],
      groupBy: ["appVersion", "overflow"] });
    expect(grouped.find((group) => group.group.appVersion === VERSION)).toMatchObject({ group: { overflow: true }, count: 3 });
    expect(await store.readCounters({ from: new Date(currentHour + DAY_MS), to: new Date(currentHour + 2 * DAY_MS),
      events: ["provider_operation"] })).toEqual([]);
  });

  it("pages incidents newest first with filters and an exact run or trace match", async () => {
    const base = BUCKET.getTime();
    const runId = `run-${randomBytes(6).toString("hex")}`;
    const traceId = randomBytes(16).toString("hex");
    await store.write({
      counters: [],
      incidents: [
        incident({ at: base + 1_000 }),
        incident({ at: base + 2_000, runId }),
        incident({ at: base + 3_000, traceId, level: "fatal" }),
        incident({ at: base + 3_000, code: "provider_http_server_error" }),
        incident({ at: base + 4_000 })
      ],
      lostObservations: 0
    });
    const first = await store.readIncidents({ connectionIds: [CONNECTION], limit: 2 });
    expect(first.items.map((item) => item.occurredAt.getTime() - base)).toEqual([4_000, 3_000]);
    const second = await store.readIncidents({ connectionIds: [CONNECTION], limit: 2, cursor: first.nextCursor });
    const third = await store.readIncidents({ connectionIds: [CONNECTION], limit: 2, cursor: second.nextCursor });
    const pages = [...first.items, ...second.items, ...third.items];
    expect(pages.map((item) => item.occurredAt.getTime() - base)).toEqual([4_000, 3_000, 3_000, 2_000, 1_000]);
    expect(new Set(pages.map((item) => item.id)).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    expect(pages[0]).toMatchObject({ role: "app", event: "provider_operation", appVersion: VERSION,
      instanceId: "a".repeat(32), connectionId: CONNECTION, details: { httpStatus: 401, stage: "answer" } });

    expect((await store.readIncidents({ runId })).items.map((item) => item.runId)).toEqual([runId]);
    expect((await store.readIncidents({ traceId })).items).toEqual([expect.objectContaining({ traceId, level: "fatal" })]);
    expect((await store.readIncidents({ connectionIds: [CONNECTION], codes: ["provider_http_server_error"] })).items)
      .toHaveLength(1);
    expect((await store.readIncidents({ connectionIds: [CONNECTION], levels: ["fatal"],
      from: new Date(base + 3_000), to: new Date(base + 3_001) })).items).toHaveLength(1);
  });

  it("deletes only rows past the retention cutoffs", async () => {
    const now = new Date(currentHour);
    const expiredBucket = new Date(currentHour - 31 * DAY_MS);
    const keptBucket = new Date(currentHour - 29 * DAY_MS);
    await store.write({
      counters: [delta({ code: "expired", bucket: expiredBucket }), delta({ code: "kept", bucket: keptBucket })],
      incidents: [incident({ at: currentHour - 31 * DAY_MS }), incident({ at: currentHour - 20 * DAY_MS })],
      lostObservations: 0
    });
    const deleted = await store.deleteExpired(now);
    expect(deleted.counters).toBeGreaterThanOrEqual(1);
    expect(deleted.incidents).toBeGreaterThanOrEqual(1);
    const counters = await prisma.$queryRaw<Array<{ code: string }>>`
      SELECT "dimensions" ->> 'code' AS code FROM "TelemetryCounter" WHERE "appVersion" = ${VERSION}`;
    expect(counters).toEqual([{ code: "kept" }]);
    const incidents = await prisma.$queryRaw<Array<{ occurredAt: Date }>>`
      SELECT "occurredAt" FROM "TelemetryIncident" WHERE "appVersion" = ${VERSION}`;
    expect(incidents).toEqual([{ occurredAt: new Date(currentHour - 20 * DAY_MS) }]);
  });

  it("trims one key's storm to the day's first and latest incidents in one pass, keeping every other key", async () => {
    const day = currentDay - 2 * DAY_MS;
    const stormStep = 4_000;
    const storm = { code: "storm", fingerprint: "aaaaaaaaaaaa" };
    await insertIncidents({ ...storm, rows: 20_000, start: day, stepMs: stormStep });
    // Five keys that each differ from the storm in exactly one part, inside its span.
    const others = [
      { ...storm, fingerprint: "bbbbbbbbbbbb" },
      { ...storm, fingerprint: null },
      { ...storm, subsystem: "jobs" },
      { ...storm, event: "run_execution" },
      { ...storm, code: "other" }
    ];
    for (const other of others) await insertIncidents({ ...other, rows: 10, start: day + 3 * HOUR_MS, stepMs: 60_000 });
    // A fingerprint-less storm (NULLs share one key) and the storm's next day.
    await insertIncidents({ code: "quiet_storm", rows: 300, start: day, stepMs: 1_000 });
    await insertIncidents({ ...storm, rows: 150, start: day + DAY_MS, stepMs: 1_000 });

    const deleted = await store.deleteExpired(new Date(currentHour));
    expect(deleted.incidents).toBeGreaterThanOrEqual(19_800 + 100);

    const groups = await prisma.$queryRaw<Array<{ key: string; rows: number }>>`
      SELECT concat_ws('|', "event", "code", coalesce("subsystem", '-'), coalesce("details" ->> 'error_fingerprint', '-'),
        to_char(date_trunc('day', "occurredAt"), 'YYYY-MM-DD')) AS key, count(*)::int AS rows
      FROM "TelemetryIncident" WHERE "appVersion" = ${VERSION} GROUP BY 1 ORDER BY 1`;
    const dayLabel = (time: number) => new Date(time).toISOString().slice(0, 10);
    expect(Object.fromEntries(groups.map((group) => [group.key, group.rows]))).toEqual({
      [`provider_operation|storm|-|aaaaaaaaaaaa|${dayLabel(day)}`]: TELEMETRY_INCIDENT_KEY_DAY_ROWS,
      [`provider_operation|storm|-|aaaaaaaaaaaa|${dayLabel(day + DAY_MS)}`]: 150,
      [`provider_operation|storm|-|bbbbbbbbbbbb|${dayLabel(day)}`]: 10,
      [`provider_operation|storm|-|-|${dayLabel(day)}`]: 10,
      [`provider_operation|storm|jobs|aaaaaaaaaaaa|${dayLabel(day)}`]: 10,
      [`run_execution|storm|-|aaaaaaaaaaaa|${dayLabel(day)}`]: 10,
      [`provider_operation|other|-|aaaaaaaaaaaa|${dayLabel(day)}`]: 10,
      [`provider_operation|quiet_storm|-|-|${dayLabel(day)}`]: TELEMETRY_INCIDENT_KEY_DAY_ROWS
    });

    const kept = await prisma.$queryRaw<Array<{ occurredAt: Date }>>`
      SELECT "occurredAt" FROM "TelemetryIncident"
      WHERE "appVersion" = ${VERSION} AND "code" = 'storm' AND "subsystem" IS NULL AND "event" = 'provider_operation'
        AND "details" ->> 'error_fingerprint' = 'aaaaaaaaaaaa' AND "occurredAt" < (${new Date(day + DAY_MS)}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "occurredAt"`;
    const positions = [...Array.from({ length: 100 }, (_, index) => index), ...Array.from({ length: 100 }, (_, index) => 19_900 + index)];
    expect(kept.map((row) => row.occurredAt.getTime())).toEqual(positions.map((position) => day + position * stormStep));
  });

  it("trims a storm before the global cap, so the cap never evicts other keys because of it", async () => {
    // Older incidents of many keys plus a newer storm exceed the cap; trimmed
    // first, they fit, and the cap leaves the older keys alone.
    await insertIncidents({ code: "steady", spread: 450, rows: 45_000, start: currentDay - 3 * DAY_MS, stepMs: 1_000 });
    await insertIncidents({ code: "storm", rows: 20_000, start: currentDay - 2 * DAY_MS, stepMs: 4_000 });
    await store.deleteExpired(new Date(currentHour));
    const counts = await prisma.$queryRaw<Array<{ steady: number; storm: number }>>`
      SELECT count(*) FILTER (WHERE starts_with("code", 'steady_'))::int AS steady, count(*) FILTER (WHERE "code" = 'storm')::int AS storm
      FROM "TelemetryIncident" WHERE "appVersion" = ${VERSION}`;
    expect(counts).toEqual([{ steady: 45_000, storm: TELEMETRY_INCIDENT_KEY_DAY_ROWS }]);
  });

  it("keeps only the newest incidents beyond the row bound", async () => {
    const newest = currentHour - HOUR_MS;
    const surplus = 5;
    const rows = TELEMETRY_INCIDENT_MAX_ROWS + surplus;
    // A thousand keys of about fifty incidents each: below the daily key bound, so only the cap applies.
    await insertIncidents({ code: "cap", spread: 1_000, rows, start: newest - (rows - 1), stepMs: 1 });
    const deleted = await store.deleteExpired(new Date(currentHour));
    expect(deleted.incidents).toBeGreaterThanOrEqual(surplus);
    const [total] = await prisma.$queryRaw<Array<{ rows: number }>>`SELECT count(*)::int AS rows FROM "TelemetryIncident"`;
    expect(total!.rows).toBeLessThanOrEqual(TELEMETRY_INCIDENT_MAX_ROWS);
    const [own] = await prisma.$queryRaw<Array<{ rows: number; newest: Date }>>`
      SELECT count(*)::int AS rows, max("occurredAt") AS newest FROM "TelemetryIncident" WHERE "appVersion" = ${VERSION}`;
    expect(own!.newest).toEqual(new Date(newest));
    expect(own!.rows).toBeLessThanOrEqual(TELEMETRY_INCIDENT_MAX_ROWS);
  });

  it("rejects a value no writer produces as a permanent failure, writing nothing", async () => {
    const broken = { ...delta({ code: "broken" }), lastSeenAt: new Date(BUCKET.getTime() + 2 * HOUR_MS) };
    const error = await store.write({ counters: [delta({ code: "valid" }), broken], incidents: [], lostObservations: 0 })
      .catch((reason: unknown) => reason);
    expect(telemetryWriteIsPermanent(error)).toBe(true);
    const [shape] = await prisma.$queryRaw<Array<{ rows: number }>>`
      SELECT count(*)::int AS rows FROM "TelemetryCounter" WHERE "appVersion" = ${VERSION}`;
    expect(shape).toEqual({ rows: 0 });
  });

  it("records this process's logged events as hourly counters and incidents within one flush", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const recorder = createTelemetryRecorder({ store, retention: false });
    recorder.start();
    try {
      for (const duration of [120, 4_000]) {
        logEvent("provider_operation", { outcome: "failed", code: "provider_http_dns_failed", providerFamily: "openai",
          connectionId: CONNECTION, providerModelId: "model-1", stage: "answer", httpStatus: 401, duration_ms: duration });
      }
      logEvent("provider_operation", { outcome: "completed", connectionId: CONNECTION, stage: "answer", duration_ms: 90 });
      await recorder.flush();
    } finally {
      await recorder.stop();
    }
    const hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const groups = await store.readCounters({ from: new Date(hour.getTime() - HOUR_MS), to: new Date(hour.getTime() + HOUR_MS),
      events: ["provider_operation"], dimensions: { connectionId: CONNECTION }, groupBy: ["level", "outcome", "httpStatus"] });
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: { level: "error", outcome: "failed", httpStatus: 401 }, count: 2,
        durationCount: 2, durationSumMs: 4_120, durationMaxMs: 4_000 }),
      expect.objectContaining({ group: { level: "info", outcome: "completed", httpStatus: null }, count: 1 })
    ]));
    const incidents = await store.readIncidents({ connectionIds: [CONNECTION] });
    expect(incidents.items).toHaveLength(2);
    expect(incidents.items[0]).toMatchObject({ code: "provider_http_dns_failed", level: "error",
      details: expect.objectContaining({ httpStatus: 401, providerFamily: "openai" }) });
  });
});
