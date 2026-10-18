import { describe, expect, it } from "vitest";
import { adminHealthEventCategory } from "@/lib/contracts/adminHealth";
import {
  TELEMETRY_DURATION_BUCKETS, TELEMETRY_LEGACY_DURATION_BOUNDS_MS, telemetryDurationBucket, telemetryDurationBucketsInCurrentLayout
} from "../../telemetry/aggregator";
import {
  adminHealthFailureClass,
  adminHealthIncidentFrom,
  adminHealthP95,
  adminHealthQuantile,
  adminHealthWindow
} from "./projection";

describe("admin health projection", () => {
  it("covers whole UTC buckets ending with the current one and drops a previous period past retention", () => {
    const now = new Date("2026-10-07T12:34:56.000Z");
    const day = adminHealthWindow("24h", now);
    expect(day.interval).toBe("hour");
    expect(day.buckets).toHaveLength(24);
    expect(day.from.toISOString()).toBe("2026-10-06T13:00:00.000Z");
    expect(day.to.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect(day.previous).toEqual({ from: new Date("2026-10-05T13:00:00.000Z"), to: day.from });

    const week = adminHealthWindow("7d", now);
    expect(week.interval).toBe("day");
    expect(week.buckets.map((bucket) => bucket.toISOString())[0]).toBe("2026-10-01T00:00:00.000Z");
    expect(week.to.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(week.previous?.from.toISOString()).toBe("2026-09-24T00:00:00.000Z");

    const fortnight = adminHealthWindow("14d", now);
    expect(fortnight.interval).toBe("day");
    expect(fortnight.buckets).toHaveLength(14);
    expect(fortnight.from.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(fortnight.to.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(fortnight.previous).toEqual({ from: new Date("2026-09-10T00:00:00.000Z"), to: fortnight.from });

    const month = adminHealthWindow("30d", now);
    expect(month.buckets).toHaveLength(30);
    expect(month.previous).toBeNull();
    expect(adminHealthIncidentFrom("7d", now).toISOString()).toBe("2026-09-30T12:34:56.000Z");
    expect(adminHealthIncidentFrom("14d", now).toISOString()).toBe("2026-09-23T12:34:56.000Z");
  });

  it("puts every error event in exactly one category", () => {
    expect(adminHealthEventCategory("provider_operation")).toBe("providers");
    expect(adminHealthEventCategory("http.request_completed")).toBe("requests");
    expect(adminHealthEventCategory("http.request_failed")).toBe("requests");
    expect(adminHealthEventCategory("run_execution")).toBe("runs");
    expect(adminHealthEventCategory("run_recovery")).toBe("background");
    expect(adminHealthEventCategory("job_attempt")).toBe("background");
    expect(adminHealthEventCategory("tool_execution")).toBe("tools");
    expect(adminHealthEventCategory("tool_call")).toBe("tools");
    expect(adminHealthEventCategory("process.failure")).toBe("other");
  });

  it("classifies provider failures by code first, then status, then reason", () => {
    expect(adminHealthFailureClass("provider_auth_rejected", 401, "http")).toBe("key_rejected");
    expect(adminHealthFailureClass("provider_response_failed", 403, "http")).toBe("key_rejected");
    expect(adminHealthFailureClass("provider_quota_exhausted", 402, "http")).toBe("quota");
    expect(adminHealthFailureClass("provider_rate_limited", 429, "http")).toBe("quota");
    expect(adminHealthFailureClass("provider_quota_exhausted", 400, "http")).toBe("quota");
    expect(adminHealthFailureClass("provider_server_error", 503, "http")).toBe("provider_error");
    // An Agent request whose stream named an upstream failure, without a status.
    expect(adminHealthFailureClass("agent_provider_failed", null, "upstream")).toBe("provider_error");
    expect(adminHealthFailureClass("provider_request_timed_out", null, "deadline")).toBe("timeout");
    expect(adminHealthFailureClass("vision_analysis_timeout", null, null)).toBe("timeout");
    expect(adminHealthFailureClass("provider_http_dns_failed", null, "network")).toBe("network");
    expect(adminHealthFailureClass("provider_response_invalid_json", null, "invalid_response")).toBe("other");
    expect(adminHealthFailureClass(null, null, null)).toBe("other");
  });

  it("estimates p95 as the histogram bucket bound, capped by the maximum", () => {
    expect(adminHealthP95(histogram({}), null)).toBeNull();
    // 100 operations: 94 under 100 ms, 6 in (1000, 2500] -> p95 bound 2500, capped by max 1800.
    expect(adminHealthP95(histogram({ 0: 94, 4: 6 }), 1_800)).toBe(1_800);
    expect(adminHealthP95(histogram({ 0: 96, 4: 4 }), 1_800)).toBe(100);
    // The open last bucket (over 30 min) reports the observed maximum.
    expect(adminHealthP95(histogram({ 0: 1, 18: 19 }), 2_412_000)).toBe(2_412_000);
    // Runs between 2 and 30 min keep their own bounds instead of collapsing.
    expect(adminHealthP95(histogram({ 0: 1, 15: 19 }), 1_000_000)).toBe(900_000);
    // The median of the same kind of histogram, as a bucket bound capped by the maximum.
    expect(adminHealthQuantile(histogram({ 0: 94, 4: 6 }), 1_800, 0.5)).toBe(100);
    expect(adminHealthQuantile(histogram({ 0: 10, 4: 90 }), 1_800, 0.5)).toBe(1_800);
  });

  it("keeps the percentiles of counters written in the earlier 12-bucket layout, alone or mixed with new ones", () => {
    const legacyBounds = TELEMETRY_LEGACY_DURATION_BOUNDS_MS[12]!;
    // The computation before the finer buckets, over the earlier layout.
    const legacyQuantile = (buckets: readonly number[], maxMs: number, quantile: number) => {
      const target = Math.ceil(buckets.reduce((sum, value) => sum + value, 0) * quantile);
      let seen = 0;
      for (let index = 0; index < buckets.length; index += 1) {
        seen += buckets[index]!;
        if (seen < target) continue;
        const bound = legacyBounds[index];
        return bound === undefined ? maxMs : Math.min(bound, maxMs);
      }
      return maxMs;
    };
    const legacyBucket = (duration: number) => {
      const index = legacyBounds.findIndex((bound) => duration <= bound);
      return index === -1 ? legacyBounds.length : index;
    };
    const legacyDurations = [50_000, 70_000, 200_000, 400_000];
    const legacy = new Array<number>(12).fill(0);
    for (const duration of legacyDurations) legacy[legacyBucket(duration)]! += 1;
    for (const quantile of [0.5, 0.95]) {
      expect(adminHealthQuantile(telemetryDurationBucketsInCurrentLayout(legacy), 400_000, quantile))
        .toBe(legacyQuantile(legacy, 400_000, quantile));
    }
    // Old and new rows of one group sum per current bucket; each percentile stays an upper bound.
    const recent = histogram({});
    for (const duration of [40_000, 80_000, 700_000, 1_000_000]) recent[telemetryDurationBucket(duration)]! += 1;
    const merged = telemetryDurationBucketsInCurrentLayout(legacy).map((value, index) => value + recent[index]!);
    expect(adminHealthQuantile(merged, 1_000_000, 0.5)).toBe(120_000);
    expect(adminHealthQuantile(merged, 1_000_000, 0.95)).toBe(1_000_000);
    const sorted = [...legacyDurations, 40_000, 80_000, 700_000, 1_000_000].sort((left, right) => left - right);
    expect(adminHealthQuantile(merged, 1_000_000, 0.5)).toBeGreaterThanOrEqual(sorted[3]!);
  });
});

function histogram(counts: Readonly<Record<number, number>>): number[] {
  const buckets = new Array<number>(TELEMETRY_DURATION_BUCKETS).fill(0);
  for (const [index, count] of Object.entries(counts)) buckets[Number(index)] = count;
  return buckets;
}
