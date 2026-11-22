import { describe, expect, it } from "vitest";
import { pastChatDayStart, pastChatTimestamp, pastChatTimeZone, pastChatTurnRange } from "./dates";

describe("past-chat days and times in the turn's zone", () => {
  it("starts a day at the zone's midnight, across a daylight saving change", () => {
    expect(pastChatDayStart("2026-11-11", "Europe/Moscow").toISOString()).toBe("2026-11-10T21:00:00.000Z");
    expect(pastChatDayStart("2026-03-29", "Europe/Berlin").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(pastChatDayStart("2026-03-30", "Europe/Berlin").toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(pastChatTurnRange({ after: "2026-11-01", before: null }, "UTC")).toEqual({ from: new Date("2026-11-01T00:00:00Z"), until: null });
  });

  it("writes times with the zone's offset to the second, and UTC for an unknown zone", () => {
    const instant = new Date("2026-11-20T11:05:09.987Z");
    expect(pastChatTimestamp(instant, "Europe/Moscow")).toBe("2026-11-20T14:05:09+03:00");
    expect(pastChatTimestamp(instant, "America/St_Johns")).toBe("2026-11-20T07:35:09-03:30");
    expect(pastChatTimestamp(instant, "UTC")).toBe("2026-11-20T11:05:09Z");
    expect(pastChatTimestamp(instant, "Not/AZone")).toBe("2026-11-20T11:05:09Z");
    expect(pastChatTimeZone(undefined)).toBe("UTC");
  });
});
