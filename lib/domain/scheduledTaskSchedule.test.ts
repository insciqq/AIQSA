import { describe, expect, it } from "vitest";
import type { ScheduledTaskSchedule } from "../contracts/scheduledTasks";
import {
  describeScheduledTaskSchedule,
  nextOccurrenceAfter,
  sameScheduledTaskSchedule,
  scheduledTaskMinutesToTime,
  scheduledTaskTimeToMinutes,
  scheduledTaskWeekdayMask,
  scheduledTaskWeekdaysFromMask,
  validScheduledTaskTimeZone,
  validateScheduledTaskSchedule
} from "./scheduledTaskSchedule";

function sequence(schedule: ScheduledTaskSchedule, timeZone: string, from: string, count: number): string[] {
  const instants: string[] = [];
  let after = new Date(from);
  for (let index = 0; index < count; index += 1) {
    const next = nextOccurrenceAfter(schedule, timeZone, after);
    if (!next) break;
    instants.push(next.toISOString());
    after = next;
  }
  return instants;
}

describe("scheduled task occurrences", () => {
  it("runs a fixed-offset zone daily and strictly after the given instant", () => {
    const daily = { kind: "daily", time: "09:00" } as const;
    expect(nextOccurrenceAfter(daily, "Europe/Moscow", new Date("2026-06-01T05:59:59.999Z"))?.toISOString())
      .toBe("2026-06-01T06:00:00.000Z");
    expect(nextOccurrenceAfter(daily, "Europe/Moscow", new Date("2026-06-01T06:00:00.000Z"))?.toISOString())
      .toBe("2026-06-02T06:00:00.000Z");
    expect(sequence(daily, "Europe/Moscow", "2026-12-30T12:00:00Z", 3)).toEqual([
      "2026-12-31T06:00:00.000Z", "2027-01-01T06:00:00.000Z", "2027-01-02T06:00:00.000Z"
    ]);
  });

  it("shifts a skipped New York time forward by the gap and runs a repeated time once, at its earlier instant", () => {
    expect(sequence({ kind: "daily", time: "02:30" }, "America/New_York", "2026-03-06T12:00:00Z", 3)).toEqual([
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:30:00.000Z", // 02:30 does not exist: 03:30 EDT
      "2026-03-09T06:30:00.000Z" // 02:30 EDT
    ]);
    const repeated = { kind: "daily", time: "01:30" } as const;
    expect(sequence(repeated, "America/New_York", "2026-10-31T12:00:00Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z", // first 01:30 (EDT)
      "2026-11-02T06:30:00.000Z" // never the second 01:30 (EST) of 1 November
    ]);
    expect(nextOccurrenceAfter(repeated, "America/New_York", new Date("2026-11-01T06:00:00Z"))?.toISOString())
      .toBe("2026-11-02T06:30:00.000Z");
  });

  it("handles Lord Howe's 30-minute transitions in both directions", () => {
    expect(sequence({ kind: "daily", time: "02:15" }, "Australia/Lord_Howe", "2026-10-02T00:00:00Z", 3)).toEqual([
      "2026-10-02T15:45:00.000Z", // 02:15 +10:30
      "2026-10-03T15:45:00.000Z", // 02:15 skipped: 02:45 +11:00
      "2026-10-04T15:15:00.000Z" // 02:15 +11:00
    ]);
    expect(sequence({ kind: "daily", time: "01:45" }, "Australia/Lord_Howe", "2026-04-03T00:00:00Z", 3)).toEqual([
      "2026-04-03T14:45:00.000Z", // 01:45 +11:00
      "2026-04-04T14:45:00.000Z", // repeated 01:45: the earlier, +11:00
      "2026-04-05T15:15:00.000Z" // 01:45 +10:30
    ]);
  });

  it("runs a monthly day past the month's end on its last day, including leap years", () => {
    const monthly = { kind: "monthly", time: "08:00", dayOfMonth: 31 } as const;
    expect(sequence(monthly, "UTC", "2026-01-31T12:00:00Z", 4)).toEqual([
      "2026-02-28T08:00:00.000Z", "2026-03-31T08:00:00.000Z", "2026-04-30T08:00:00.000Z", "2026-05-31T08:00:00.000Z"
    ]);
    expect(nextOccurrenceAfter(monthly, "UTC", new Date("2028-01-31T12:00:00Z"))?.toISOString()).toBe("2028-02-29T08:00:00.000Z");
    expect(nextOccurrenceAfter({ kind: "monthly", time: "08:00", dayOfMonth: 30 }, "UTC", new Date("2027-02-01T00:00:00Z"))
      ?.toISOString()).toBe("2027-02-28T08:00:00.000Z");
    expect(nextOccurrenceAfter({ kind: "monthly", time: "23:59", dayOfMonth: 1 }, "Europe/Moscow", new Date("2026-10-04T00:00:00Z"))
      ?.toISOString()).toBe("2026-11-01T20:59:00.000Z");
  });

  it("follows weekly masks across the week boundary", () => {
    // 9 October 2026 is a Friday.
    expect(nextOccurrenceAfter({ kind: "weekly", time: "18:30", days: ["mon", "wed"] }, "Europe/Moscow",
      new Date("2026-10-09T12:00:00Z"))?.toISOString()).toBe("2026-10-12T15:30:00.000Z");
    expect(sequence({ kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, "UTC",
      "2026-10-09T09:00:00Z", 2)).toEqual(["2026-10-12T09:00:00.000Z", "2026-10-13T09:00:00.000Z"]);
    expect(sequence({ kind: "weekly", time: "00:00", days: ["sun"] }, "UTC", "2026-10-04T00:00:00Z", 2))
      .toEqual(["2026-10-11T00:00:00.000Z", "2026-10-18T00:00:00.000Z"]);
  });

  it("returns a once instant only while it is still ahead", () => {
    const once = { kind: "once", date: "2026-10-12", time: "10:00" } as const;
    expect(nextOccurrenceAfter(once, "Europe/Moscow", new Date("2026-10-12T06:59:59.999Z"))?.toISOString())
      .toBe("2026-10-12T07:00:00.000Z");
    expect(nextOccurrenceAfter(once, "Europe/Moscow", new Date("2026-10-12T07:00:00.000Z"))).toBeNull();
    expect(nextOccurrenceAfter(once, "Europe/Moscow", new Date("2027-01-01T00:00:00Z"))).toBeNull();
    expect(nextOccurrenceAfter({ kind: "once", date: "2026-03-08", time: "02:30" }, "America/New_York",
      new Date("2026-01-01T00:00:00Z"))?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(() => nextOccurrenceAfter(once, "Europe/Moscow", new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("scheduled task schedule validation", () => {
  it("accepts resolvable IANA zones as written and refuses offsets and unknown names", () => {
    expect(validScheduledTaskTimeZone("Europe/Kyiv")).toBe("Europe/Kyiv");
    expect(validScheduledTaskTimeZone("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(validScheduledTaskTimeZone("UTC")).toBe("UTC");
    for (const zone of ["+03:00", "Mars/Olympus", "", " UTC", `Europe/${"x".repeat(60)}`, 3]) {
      expect(validScheduledTaskTimeZone(zone)).toBeNull();
    }
  });

  it("reports the schedule before the zone and normalizes weekly days", () => {
    expect(validateScheduledTaskSchedule({ kind: "weekly", time: "07:05", days: ["fri", "mon"] }, "Europe/Moscow")).toEqual({
      ok: true, schedule: { kind: "weekly", time: "07:05", days: ["mon", "fri"] }, timeZone: "Europe/Moscow"
    });
    expect(validateScheduledTaskSchedule({ kind: "daily", time: "07:05" }, "Mars/Olympus"))
      .toEqual({ ok: false, code: "scheduled_task_time_zone_invalid" });
    for (const schedule of [
      { kind: "daily", time: "24:00" }, { kind: "daily", time: "9:00" }, { kind: "daily", time: "09:00", extra: true },
      { kind: "once", date: "2026-02-29", time: "09:00" }, { kind: "once", date: "2026-13-01", time: "09:00" },
      { kind: "weekly", time: "09:00", days: [] }, { kind: "weekly", time: "09:00", days: ["mon", "mon"] },
      { kind: "weekly", time: "09:00", days: ["monday"] }, { kind: "monthly", time: "09:00", dayOfMonth: 0 },
      { kind: "monthly", time: "09:00", dayOfMonth: 32 }, { kind: "monthly", time: "09:00", dayOfMonth: 1.5 },
      { kind: "hourly", time: "09:00" }, null, "daily"
    ]) {
      expect(validateScheduledTaskSchedule(schedule, "Mars/Olympus")).toEqual({ ok: false, code: "scheduled_task_schedule_invalid" });
    }
  });

  it("maps times, weekday masks and schedule identity", () => {
    expect(scheduledTaskTimeToMinutes("23:59")).toBe(1439);
    expect(scheduledTaskMinutesToTime(545)).toBe("09:05");
    expect(scheduledTaskWeekdayMask(["mon", "sun"])).toBe(0b1000001);
    expect(scheduledTaskWeekdaysFromMask(0b0011111)).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(sameScheduledTaskSchedule({ kind: "weekly", time: "09:00", days: ["mon", "fri"] },
      { kind: "weekly", time: "09:00", days: ["fri", "mon"] })).toBe(true);
    expect(sameScheduledTaskSchedule({ kind: "daily", time: "09:00" }, { kind: "weekly", time: "09:00", days: ["mon"] })).toBe(false);
    expect(sameScheduledTaskSchedule({ kind: "monthly", time: "09:00", dayOfMonth: 1 },
      { kind: "monthly", time: "09:00", dayOfMonth: 2 })).toBe(false);
  });
});

describe("scheduled task summaries", () => {
  it("describes every kind in English", () => {
    expect(describeScheduledTaskSchedule({ kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }))
      .toBe("Every weekday at 09:00");
    expect(describeScheduledTaskSchedule({ kind: "weekly", time: "18:30", days: ["mon", "wed"] })).toBe("Every Mon, Wed at 18:30");
    expect(describeScheduledTaskSchedule({ kind: "weekly", time: "07:00", days: [...["sun", "sat", "fri", "thu", "wed", "tue", "mon"] as const] }))
      .toBe("Every day at 07:00");
    expect(describeScheduledTaskSchedule({ kind: "daily", time: "07:00" })).toBe("Every day at 07:00");
    expect(describeScheduledTaskSchedule({ kind: "monthly", time: "08:00", dayOfMonth: 31 })).toBe("Monthly on day 31 at 08:00");
    expect(describeScheduledTaskSchedule({ kind: "once", date: "2026-10-12", time: "10:00" })).toBe("Once on 12 Oct 2026 at 10:00");
  });
});
