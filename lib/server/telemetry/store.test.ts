// @vitest-environment node
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TELEMETRY_DURATION_BUCKETS, type TelemetryBatch, type TelemetryCounterDelta } from "./aggregator";
import {
  createPrismaTelemetryStore, TelemetryQueryError, telemetryDimensionHash, telemetryWriteIsPermanent,
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
      instanceId: "a".repeat(32), code: null, subsystem: null, connectionId: null, runId: null, traceId: null, details: {}
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
    expect(db.$executeRaw).toHaveBeenCalledTimes(5);

    const busy = fakeDatabase();
    busy.db.$executeRaw.mockResolvedValue(1_000);
    await expect(busy.store.deleteExpired(new Date())).resolves.toEqual({ counters: 20_000, incidents: 40_000 });
    expect(busy.db.$executeRaw).toHaveBeenCalledTimes(60);
  });

  it("rejects malformed reads before any query", async () => {
    const { db, store } = fakeDatabase();
    const range = { from: new Date(HOUR.getTime() - 86_400_000), to: HOUR };
    for (const query of [
      { ...range, from: HOUR },
      { ...range, from: new Date(Number.NaN) },
      { ...range, groupBy: ["run_id"] },
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
      { traceId: "0".repeat(31) },
      { levels: ["warn"] },
      { limit: 201 }
    ]) {
      await expect(store.readIncidents(query as never)).rejects.toBeInstanceOf(TelemetryQueryError);
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
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
