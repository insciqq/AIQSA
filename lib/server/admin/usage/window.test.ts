import { describe, expect, it } from "vitest";
import { planUsageWindow, usageDayKey, usageLocalDate, validUsageTimeZone } from "./window";

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

describe("usage window planning", () => {
  it("accepts IANA zones only", () => {
    for (const zone of ["Europe/Moscow", "UTC", "Etc/GMT+3", "America/Argentina/Buenos_Aires"]) {
      expect(validUsageTimeZone(zone)).toBe(zone);
    }
    for (const zone of ["", "+03:00", "GMT+3", "Mars/Phobos", `Europe/${"A".repeat(60)}`, 3, null, "Europe/../x"]) {
      expect(validUsageTimeZone(zone)).toBeNull();
    }
  });

  it("starts rolling periods at the local day and keeps day buckets across a DST change", () => {
    // Berlin leaves summer time on 2026-10-25 at 03:00 local.
    const plan = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-27T10:00:00.000Z"), period: "7d", timeZone: "Europe/Berlin" });
    expect(plan.bucket).toBe("day");
    expect(iso(plan.from)).toBe("2026-10-20T22:00:00.000Z");
    expect(iso(plan.to)).toBe("2026-10-27T10:00:00.000Z");
    expect(plan.buckets.map((bucket) => bucket.key)).toEqual([
      "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"
    ]);
    expect(plan.buckets.slice(3, 6).map((bucket) => iso(bucket.start))).toEqual([
      "2026-10-23T22:00:00.000Z", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"
    ]);
    // Seven local days earlier, at the same wall time (11:00, then still summer time).
    expect(iso(plan.previous?.from)).toBe("2026-10-13T22:00:00.000Z");
    expect(iso(plan.previous?.to)).toBe("2026-10-20T09:00:00.000Z");
  });

  it("resolves a skipped local midnight to the first instant of that day", () => {
    // Santiago skips 00:00-01:00 on 2026-09-06.
    const plan = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-09-07T15:00:00.000Z"), period: "7d", timeZone: "America/Santiago" });
    const skipped = plan.buckets.find((bucket) => bucket.key === "2026-09-06");
    expect(iso(skipped?.start)).toBe("2026-09-06T04:00:00.000Z");
    expect(usageLocalDate(skipped!.start, "America/Santiago")).toEqual({ year: 2026, month: 9, day: 6 });
    expect(plan.buckets).toHaveLength(7);
  });

  it("covers the default period with thirty local days", () => {
    const plan = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:30:00.000Z"), period: "30d", timeZone: "UTC" });
    expect(plan.buckets).toHaveLength(30);
    expect(iso(plan.from)).toBe("2026-09-08T00:00:00.000Z");
    expect(iso(plan.previous?.from)).toBe("2026-08-09T00:00:00.000Z");
    expect(iso(plan.previous?.to)).toBe("2026-09-07T12:30:00.000Z");
    const ninety = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:30:00.000Z"), period: "90d", timeZone: "UTC" });
    expect(ninety.buckets).toHaveLength(90);
  });

  it("compares this month with the same elapsed part of the previous month", () => {
    const mid = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-03-15T12:00:00.000Z"), period: "this_month", timeZone: "UTC" });
    expect(iso(mid.from)).toBe("2026-03-01T00:00:00.000Z");
    expect(mid.buckets).toHaveLength(15);
    expect(mid.previous).toEqual({ from: new Date("2026-02-01T00:00:00.000Z"), to: new Date("2026-02-15T12:00:00.000Z") });
    // February has no 30th: the whole previous month compares.
    const late = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-03-30T12:00:00.000Z"), period: "this_month", timeZone: "UTC" });
    expect(late.previous).toEqual({ from: new Date("2026-02-01T00:00:00.000Z"), to: new Date("2026-03-01T00:00:00.000Z") });
  });

  it("uses whole local months for the last month", () => {
    const plan = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-01-10T08:00:00.000Z"), period: "last_month", timeZone: "Asia/Tokyo" });
    expect(iso(plan.from)).toBe("2025-11-30T15:00:00.000Z");
    expect(iso(plan.to)).toBe("2025-12-31T15:00:00.000Z");
    expect(plan.buckets).toHaveLength(31);
    expect(plan.previous).toEqual({ from: new Date("2025-10-31T15:00:00.000Z"), to: new Date("2025-11-30T15:00:00.000Z") });
  });

  it("uses month buckets for twelve months and all time", () => {
    const year = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:00:00.000Z"), period: "12m", timeZone: "UTC" });
    expect(year.bucket).toBe("month");
    expect(year.buckets.map((bucket) => bucket.key)).toEqual([
      "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
      "2026-09", "2026-10"
    ]);
    expect(year.previous).toEqual({ from: new Date("2024-11-01T00:00:00.000Z"), to: new Date("2025-10-07T12:00:00.000Z") });

    const all = planUsageWindow({
      earliestUsageAt: new Date("2024-05-17T09:00:00.000Z"), now: new Date("2026-10-07T12:00:00.000Z"), period: "all", timeZone: "UTC"
    });
    expect(iso(all.from)).toBe("2024-05-01T00:00:00.000Z");
    expect(all.buckets).toHaveLength(30);
    expect(all.previous).toBeNull();

    const empty = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:00:00.000Z"), period: "all", timeZone: "UTC" });
    expect(empty).toMatchObject({ bucket: "month", buckets: [], from: null, previous: null });
  });

  it("names local dates with zero padding", () => {
    expect(usageDayKey({ year: 2026, month: 3, day: 7 })).toBe("2026-03-07");
    expect(usageLocalDate(new Date("2026-10-06T22:30:00.000Z"), "Europe/Moscow")).toEqual({ year: 2026, month: 10, day: 7 });
  });
});
