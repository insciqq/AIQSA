// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { TELEMETRY_DURATION_BUCKETS, telemetryDurationBucket, type TelemetryCounterDelta } from "../../telemetry/aggregator";
import { createPrismaTelemetryStore } from "../../telemetry/store";
import { createAdminHealthService } from "./service";

// Rows carry this file's own version and connection and only they are removed.
// Other rows in the database may add to shared totals, so totals are lower bounds.
const VERSION = `health-test-${randomUUID()}`;
const CONNECTION = `health-test-${randomBytes(8).toString("hex")}`;
const MODEL = `health-model-${randomBytes(8).toString("hex")}`;
const HOUR_MS = 3_600_000;
const BUCKET = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS);
const store = createPrismaTelemetryStore(prisma);
const service = createAdminHealthService({
  store,
  providerNames: async () => ({ connections: new Map([[CONNECTION, "Health test connection"]]), models: new Map() })
});

function delta(input: Readonly<{
  event: string; level: TelemetryCounterDelta["level"]; dimensions: Record<string, string | number>; count: number; durationMs?: number;
}>): TelemetryCounterDelta {
  const durationBuckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  if (input.durationMs !== undefined) durationBuckets[telemetryDurationBucket(input.durationMs)] = input.count;
  return {
    bucketStart: BUCKET, role: "app", event: input.event, level: input.level, appVersion: VERSION, dimensions: input.dimensions,
    count: input.count, valueSum: 0, durationCount: input.durationMs === undefined ? 0 : input.count,
    durationSumMs: (input.durationMs ?? 0) * input.count, durationMaxMs: input.durationMs ?? null, durationBuckets,
    firstSeenAt: BUCKET, lastSeenAt: new Date(BUCKET.getTime() + 60_000)
  };
}

afterEach(async () => {
  await prisma.$executeRaw`DELETE FROM "TelemetryCounter" WHERE "appVersion" = ${VERSION}`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("admin health service over PostgreSQL telemetry", () => {
  it("groups provider calls by connection, model and stage with numeric statuses and day buckets", async () => {
    const identity = { connectionId: CONNECTION, providerModelId: MODEL };
    await store.write({
      counters: [
        delta({ event: "provider_operation", level: "info", count: 18, durationMs: 400,
          dimensions: { ...identity, stage: "answer", outcome: "completed", action: "none" } }),
        delta({ event: "provider_operation", level: "error", count: 2, durationMs: 90,
          dimensions: { ...identity, stage: "answer", outcome: "failed", action: "none", code: "provider_auth_rejected", reason: "http", httpStatus: 401 } }),
        delta({ event: "provider_operation", level: "warn", count: 5,
          dimensions: { ...identity, stage: "retrieve", outcome: "failed", action: "retry", code: "provider_response_failed" } }),
        delta({ event: "tool_execution", level: "error", count: 3, durationMs: 120_000,
          dimensions: { ...identity, tool_kind: "vision", stage: "execution", outcome: "failed", code: "vision_analysis_timeout", reason: "deadline" } })
      ],
      incidents: [],
      lostObservations: 0
    });

    const health = await service.read("7d");
    const own = health.providers.filter((row) => row.connectionId === CONNECTION);
    expect(own.map((row) => [row.stage, row.operations, row.failures])).toEqual([["vision", 3, 3], ["answer", 20, 2]]);
    expect(own[1]).toMatchObject({ connectionName: "Health test connection", connectionState: "known", modelName: "Deleted model",
      failureRate: 0.1, p95Ms: 400, failuresByClass: expect.objectContaining({ key_rejected: 2 }) });
    expect(own[0]).toMatchObject({ failuresByClass: expect.objectContaining({ timeout: 3 }), p95Ms: 120_000 });

    const day = new Date(Date.UTC(BUCKET.getUTCFullYear(), BUCKET.getUTCMonth(), BUCKET.getUTCDate())).toISOString();
    const bucket = health.series.find((item) => item.start === day);
    expect(bucket?.counts.providers).toBeGreaterThanOrEqual(2);
    expect(bucket?.counts.tools).toBeGreaterThanOrEqual(3);
    expect(health.hasTelemetry).toBe(true);
  });
});
