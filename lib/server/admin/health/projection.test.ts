import { describe, expect, it } from "vitest";
import { adminHealthEventCategory } from "@/lib/contracts/adminHealth";
import {
  adminHealthFailureClass,
  adminHealthIncidentFrom,
  adminHealthP95,
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
    expect(adminHealthFailureClass("provider_request_timed_out", null, "deadline")).toBe("timeout");
    expect(adminHealthFailureClass("vision_analysis_timeout", null, null)).toBe("timeout");
    expect(adminHealthFailureClass("provider_http_dns_failed", null, "network")).toBe("network");
    expect(adminHealthFailureClass("provider_response_invalid_json", null, "invalid_response")).toBe("other");
    expect(adminHealthFailureClass(null, null, null)).toBe("other");
  });

  it("estimates p95 as the histogram bucket bound, capped by the maximum", () => {
    expect(adminHealthP95([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], null)).toBeNull();
    // 100 operations: 94 under 100 ms, 6 in (1000, 2500] -> p95 bound 2500, capped by max 1800.
    expect(adminHealthP95([94, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0], 1_800)).toBe(1_800);
    expect(adminHealthP95([96, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0], 1_800)).toBe(100);
    // The open last bucket reports the observed maximum.
    expect(adminHealthP95([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19], 412_000)).toBe(412_000);
  });
});
