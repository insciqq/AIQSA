// @vitest-environment node
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TELEMETRY_DURATION_BUCKETS, type TelemetryBatch, type TelemetryCounterDelta } from "./aggregator";
import {
  clearTelemetryIncidentUser, createPrismaTelemetryStore, TelemetryQueryError, telemetryDimensionHash, telemetryWriteIsPermanent,
  type TelemetryDatabase
} from "./store";

const HOUR = new Date("2026-10-07T10:00:00.000Z");

function fakeDatabase(rows: unknown[] = []) {
  const statements: Prisma.Sql[] = [];
  const db = {
    $executeRaw: vi.fn(async (statement: Prisma.Sql) => { statements.push(statement); return 1; }),
    $queryRaw: vi.fn(async (statement: Prisma.Sql) => { statements.push(statement); return rows; }),
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
  };
  return { db, statements, store: createPrismaTelemetryStore(db as unknown as TelemetryDatabase) };
}

function counter(code: string, event = "provider_operation"): TelemetryCounterDelta {
  return {
    bucketStart: HOUR, role: "app", event, level: "error", appVersion: "0.3.7", dimensions: { code },
    count: 1, valueSum: 0, durationCount: 0, durationSumMs: 0, durationMaxMs: null,
    durationBuckets: new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0), firstSeenAt: HOUR, lastSeenAt: HOUR
  };
}

function batch(counters: TelemetryCounterDelta[], incidents = 0): TelemetryBatch {
  return {
    counters,
    incidents: Array.from({ length: incidents }, () => ({
      occurredAt: HOUR, role: "app", event: "provider_operation", level: "error" as const, appVersion: "0.3.7",
      instanceId: "a".repeat(32), code: null, subsystem: null, connectionId: null, runId: null, traceId: null,
      userId: null, details: {}
    })),
    lostObservations: 0
  };
}

describe("Prisma telemetry store", () => {
  it("adds a batch in one transaction with bounded statements in a writer-independent key order", async () => {
    const codes = Array.from({ length: 1_200 }, (_, index) => `code_${String(index).padStart(4, "0")}`);
    const forward = fakeDatabase();
    await forward.store.write(batch(codes.map((code) => counter(code)), 3));
    expect(forward.db.$transaction).toHaveBeenCalledOnce();
    expect(forward.statements.map((statement) => statement.sql.match(/^\s*INSERT INTO "(\w+)"/u)?.[1]))
      .toEqual(["TelemetryCounter", "TelemetryCounter", "TelemetryCounter", "TelemetryIncident"]);
    // PostgreSQL accepts at most 65,535 bind parameters per statement.
    for (const statement of forward.statements) expect(statement.values.length).toBeLessThan(65_535);

    const reversed = fakeDatabase();
    await reversed.store.write(batch([...codes].reverse().map((code) => counter(code))));
    expect(reversed.statements.slice(0, 3).map((statement) => statement.values))
      .toEqual(forward.statements.slice(0, 3).map((statement) => statement.values));
    expect(forward.statements.slice(0, 3).flatMap((statement) => statement.values))
      .toContain(telemetryDimensionHash({ code: codes[0]! }));

    const empty = fakeDatabase();
    await empty.store.write(batch([]));
    expect(empty.db.$transaction).not.toHaveBeenCalled();
  });

  it("deletes expired rows in bounded batches and stops at a short batch", async () => {
    const { db, store } = fakeDatabase();
    db.$executeRaw
      .mockResolvedValueOnce(1_000).mockResolvedValueOnce(1_000).mockResolvedValueOnce(7)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(12);
    await expect(store.deleteExpired(new Date("2026-10-07T10:00:00.000Z"))).resolves.toEqual({ counters: 2_007, incidents: 12 });
    // Counters (3), expired incidents, the cap, then deleted accounts' user ids.
    expect(db.$executeRaw).toHaveBeenCalledTimes(6);

    const busy = fakeDatabase();
    busy.db.$executeRaw.mockResolvedValue(1_000);
    await expect(busy.store.deleteExpired(new Date())).resolves.toEqual({ counters: 20_000, incidents: 40_000 });
    expect(busy.db.$executeRaw).toHaveBeenCalledTimes(80);
  });

  it("trims a storm's surplus by id after expiry and before the global cap, within the pass bound", async () => {
    const ids = Array.from({ length: 2_500 }, (_, index) => `00000000-0000-4000-8000-${String(2_499 - index).padStart(12, "0")}`);
    const { db, statements, store } = fakeDatabase(ids.map((id) => ({ id })));
    db.$executeRaw.mockImplementation(async (statement: Prisma.Sql) => {
      statements.push(statement);
      const list = statement.values.find(Array.isArray);
      return Array.isArray(list) ? list.length : 0;
    });
    await expect(store.deleteExpired(HOUR)).resolves.toEqual({ counters: 0, incidents: 2_500 });

    const kinds = statements.map((statement) => /^\s*SELECT "id" FROM \(/u.test(statement.sql) ? "rank"
      : /SET "userId" = NULL/u.test(statement.sql) ? "users"
      : /"id" = ANY/u.test(statement.sql) ? "trim"
      : /OFFSET/u.test(statement.sql) ? "cap"
      : /"occurredAt" </u.test(statement.sql) ? "expire" : "counters");
    expect(kinds).toEqual(["counters", "expire", "rank", "trim", "trim", "trim", "cap", "users"]);
    expect(statements.at(-1)!.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "User" AS account WHERE account\."id" = incident\."userId"\)/u);
    const ranking = statements[2]!;
    expect(ranking.sql).toContain(`"details" ->> 'error_fingerprint'`);
    expect(ranking.sql).toMatch(/PARTITION BY "event", "code", "subsystem", "connectionId", .*date_trunc\('day', "occurredAt"\)/su);
    expect(ranking.values).toEqual([100, 100, 20_000]);
    const deleted = statements.slice(3, 6).map((statement) => statement.values[0] as string[]);
    expect(deleted.map((chunk) => chunk.length)).toEqual([1_000, 1_000, 500]);
    expect(deleted.flat()).toEqual([...ids].sort());
  });

  it("rejects malformed reads before any query", async () => {
    const { db, store } = fakeDatabase();
    const range = { from: new Date(HOUR.getTime() - 86_400_000), to: HOUR };
    for (const query of [
      { ...range, from: HOUR },
      { ...range, from: new Date(Number.NaN) },
      { ...range, groupBy: ["run_id"] },
      { ...range, groupBy: ["user_id"] },
      { ...range, dimensions: { user_id: "user-1" } },
      { ...range, groupBy: ["code", "code"] },
      { ...range, events: ["DROP TABLE"] },
      { ...range, levels: ["debug"] },
      { ...range, dimensions: { run_id: "run-1" } },
      { ...range, dimensions: { code: "line\nbreak" } },
      { ...range, interval: "week" },
      { ...range, limit: 5_001 }
    ]) {
      await expect(store.readCounters(query as never)).rejects.toBeInstanceOf(TelemetryQueryError);
    }
    for (const query of [
      { cursor: "not-a-cursor" },
      { cursor: Buffer.from(JSON.stringify(["2026-10-07T10:00:00.000Z", "'; DROP"])).toString("base64url") },
      { runId: "run id" },
      { runIdPrefix: "3f2a9c1" },
      { runIdPrefix: "3F2A9C1E" },
      { runIdPrefix: "3f2a9c1e%" },
      { traceId: "0".repeat(31) },
      { userId: "user@example.test" },
      { levels: ["warn"] },
      { limit: 201 }
    ]) {
      await expect(store.readIncidents(query as never)).rejects.toBeInstanceOf(TelemetryQueryError);
    }
    for (const runIds of [[], ["run id"], Array.from({ length: 65 }, (_, index) => `run-${index}`)]) {
      await expect(store.countIncidentsByRun(runIds)).rejects.toBeInstanceOf(TelemetryQueryError);
    }
    for (const fingerprints of [[], ["0123456789AB"], ["0123456789a"], Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(12, "0"))]) {
      await expect(store.countIncidentReachByFingerprint({ ...range, fingerprints })).rejects.toBeInstanceOf(TelemetryQueryError);
    }
    await expect(store.countIncidentReachByFingerprint({ from: HOUR, to: HOUR, fingerprints: ["0123456789ab"] }))
      .rejects.toBeInstanceOf(TelemetryQueryError);
    for (const query of [{ from: HOUR, to: HOUR }, { ...range, limit: 0 }, { ...range, limit: 1_001 }, { from: new Date(Number.NaN), to: HOUR }]) {
      await expect(store.countIncidentReachByKey(query)).rejects.toBeInstanceOf(TelemetryQueryError);
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("matches a run reference through a bounded id range and counts incidents per run", async () => {
    const prefixed = fakeDatabase([]);
    await prefixed.store.readIncidents({ runIdPrefix: "3f2a9c1e" });
    const statement = prefixed.statements[0]!;
    expect(statement.text).toMatch(/"runId" >= \$1 AND "runId" < \$2 AND starts_with\("runId", \$3\)/u);
    expect(statement.values.slice(0, 3)).toEqual(["3f2a9c1e", "3f2a9c1eg", "3f2a9c1e"]);

    const counted = fakeDatabase([{ runId: "run-1", count: 3n }, { runId: "run-2", count: 1n }]);
    await expect(counted.store.countIncidentsByRun(["run-1", "run-2", "run-3"]))
      .resolves.toEqual(new Map([["run-1", 3], ["run-2", 1]]));
    expect(counted.statements[0]!.values).toEqual([["run-1", "run-2", "run-3"]]);
  });

  it("stores and filters an incident's user and counts distinct users and runs per fingerprint and incident key", async () => {
    const written = fakeDatabase();
    const attributed = { ...batch([], 1).incidents[0]!, runId: "run-1", userId: "user-1" };
    await written.store.write({ counters: [], incidents: [attributed], lostObservations: 0 });
    expect(written.statements[0]!.sql).toMatch(/"runId", "traceId", "userId", "details"/u);
    expect(written.statements[0]!.values).toEqual(expect.arrayContaining(["run-1", "user-1"]));

    const filtered = fakeDatabase([]);
    await filtered.store.readIncidents({ userId: "user-1" });
    expect(filtered.statements[0]!.text).toMatch(/"userId" = \$1/u);
    expect(filtered.statements[0]!.values[0]).toBe("user-1");

    const range = { from: new Date(HOUR.getTime() - 86_400_000), to: HOUR };
    const byFingerprint = fakeDatabase([{ fingerprint: "0123456789ab", incidents: 12n, users: 3n, runs: 5n }]);
    await expect(byFingerprint.store.countIncidentReachByFingerprint({ ...range, fingerprints: ["0123456789ab", "ba9876543210"] }))
      .resolves.toEqual(new Map([["0123456789ab", { incidents: 12, users: 3, runs: 5 }]]));
    const fingerprintQuery = byFingerprint.statements[0]!;
    expect(fingerprintQuery.sql).toMatch(/COUNT\(DISTINCT "userId"\).*COUNT\(DISTINCT "runId"\)/su);
    expect(fingerprintQuery.sql).toMatch(/"occurredAt" >= .* AND "occurredAt" < /su);
    expect(fingerprintQuery.values).toEqual([range.from, range.to, ["0123456789ab", "ba9876543210"]]);

    const firstAt = new Date(HOUR.getTime() - 3_600_000);
    const byKey = fakeDatabase([{ event: "job_attempt", code: "memory_job_failed", subsystem: "memory", connectionId: null,
      fingerprint: "0123456789ab", incidents: 40n, users: 40n, runs: 0n, firstAt, lastAt: HOUR }]);
    await expect(byKey.store.countIncidentReachByKey({ ...range, limit: 20 })).resolves.toEqual([{
      key: { event: "job_attempt", code: "memory_job_failed", subsystem: "memory", connectionId: null, fingerprint: "0123456789ab" },
      incidents: 40, users: 40, runs: 0, firstAt, lastAt: HOUR
    }]);
    expect(byKey.statements[0]!.sql).toMatch(/GROUP BY 1, 2, 3, 4, 5\s+ORDER BY "incidents" DESC/u);
    expect(byKey.statements[0]!.values).toEqual([range.from, range.to, 20]);
    await byKey.store.countIncidentReachByKey(range);
    expect(byKey.statements[1]!.values.at(-1)).toBe(100);
  });

  it("clears a deleted account's id from its incidents with one statement on the deleting client", async () => {
    const tx = { $executeRaw: vi.fn(async (statement: Prisma.Sql) => statement.values.length) };
    await expect(clearTelemetryIncidentUser(tx as unknown as TelemetryDatabase, "user-1")).resolves.toBe(1);
    const [statement] = tx.$executeRaw.mock.calls[0]!;
    expect(statement.text).toMatch(/^UPDATE "TelemetryIncident" SET "userId" = NULL WHERE "userId" = \$1$/u);
    expect(statement.values).toEqual(["user-1"]);
  });

  it("returns numeric groups for the requested keys and pages incidents newest first", async () => {
    const groups = fakeDatabase([
      { g0: new Date(HOUR), g1: "provider_http_dns_failed", g2: 503, count: 4n, valueSum: 0n, durationCount: 2n,
        durationSumMs: 900n, durationMaxMs: 800n, durationBuckets: Array.from({ length: 12 }, () => 1n),
        firstSeenAt: HOUR, lastSeenAt: HOUR }
    ]);
    await expect(groups.store.readCounters({ from: new Date(HOUR.getTime() - 3_600_000), to: HOUR,
      events: ["provider_operation"], groupBy: ["bucket", "code", "httpStatus"], dimensions: { outcome: "failed" } }))
      .resolves.toEqual([{ group: { bucket: HOUR, code: "provider_http_dns_failed", httpStatus: 503 },
        count: 4, valueSum: 0, durationCount: 2, durationSumMs: 900, durationMaxMs: 800,
        durationBuckets: new Array(12).fill(1), firstSeenAt: HOUR, lastSeenAt: HOUR }]);
    const none = fakeDatabase([{ count: null, durationBuckets: [null], firstSeenAt: null, lastSeenAt: null }]);
    await expect(none.store.readCounters({ from: new Date(0), to: HOUR })).resolves.toEqual([]);

    const incident = (id: string, minute: number) => ({
      id, occurredAt: new Date(HOUR.getTime() - minute * 60_000), role: "app", event: "provider_operation", level: "error",
      appVersion: "0.3.7", instanceId: "a".repeat(32), code: "provider_http_dns_failed", subsystem: null,
      connectionId: "connection-1", runId: "run-1", traceId: "b".repeat(32), details: { httpStatus: 401 }
    });
    const page = fakeDatabase([
      incident("00000000-0000-4000-8000-000000000003", 1),
      incident("00000000-0000-4000-8000-000000000002", 2),
      incident("00000000-0000-4000-8000-000000000001", 3)
    ]);
    const first = await page.store.readIncidents({ limit: 2, runId: "run-1" });
    expect(first.items.map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002"
    ]);
    expect(first.items[0]).toMatchObject({ level: "error", details: { httpStatus: 401 } });
    expect(first.nextCursor).toEqual(expect.any(String));
    await page.store.readIncidents({ limit: 2, cursor: first.nextCursor });
    expect(page.statements[1]!.values).toContain("00000000-0000-4000-8000-000000000002");
  });

  it("treats only rejected values as permanent write failures", () => {
    const known = (code: string, meta?: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError("detail", { code, clientVersion: "test", meta });
    expect(telemetryWriteIsPermanent(known("P2010", { code: "23514" }))).toBe(true);
    expect(telemetryWriteIsPermanent(known("P2010", { code: "22003" }))).toBe(true);
    expect(telemetryWriteIsPermanent(known("P2010", { code: "40P01" }))).toBe(false);
    expect(telemetryWriteIsPermanent(known("P1001"))).toBe(false);
    expect(telemetryWriteIsPermanent(new Error("23514"))).toBe(false);
  });
});
