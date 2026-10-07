import { describe, expect, it } from "vitest";
import type { UserUsageLimitStatus } from "@/lib/contracts/usageLimits";
import {
  formatUsageResetTime,
  usageLimitNextChange,
  usageLimitNotice,
  usageLimitsSettingsView
} from "./usageLimitStatus";

const format = { locale: "en-US", now: new Date("2026-10-07T12:00:00.000Z"), timeZone: "UTC" };

type StatusOverrides = Omit<Partial<UserUsageLimitStatus>, "messages"> & {
  messages?: Partial<UserUsageLimitStatus["messages"]>;
};

function status(overrides: StatusOverrides = {}): UserUsageLimitStatus {
  const { messages, ...rest } = overrides;
  return {
    installationExhausted: false,
    monthlyBudgetMicros: null,
    monthSpentMicros: 0,
    periodStart: "2026-10-01T00:00:00.000Z",
    resetsAt: "2026-11-01T00:00:00.000Z",
    ...rest,
    messages: {
      dayFreesAt: null,
      hourFreesAt: null,
      lastDay: 0,
      lastHour: 0,
      perDay: null,
      perHour: null,
      ...messages
    }
  };
}

describe("usage limit notice", () => {
  it("says nothing without limits, without a status or below the warning share", () => {
    expect(usageLimitNotice(null, format)).toBeNull();
    expect(usageLimitNotice(status({ messages: { lastDay: 500, lastHour: 90 }, monthSpentMicros: 9_000_000 }), format)).toBeNull();
    expect(usageLimitNotice(status({ monthlyBudgetMicros: 10_000_000, monthSpentMicros: 7_990_000 }), format)).toBeNull();
    expect(usageLimitNotice(status({ messages: { lastHour: 23, perHour: 30 } }), format)).toBeNull();
  });

  it("cautions from 80% of the budget and names the month reset", () => {
    expect(usageLimitNotice(status({ monthlyBudgetMicros: 10_000_000, monthSpentMicros: 8_000_000 }), format)).toEqual({
      text: "You've used ≈ $8.00 of your $10.00 monthly budget. It resets on Nov 1 at 12:00 AM.",
      tone: "caution"
    });
  });

  it("cautions from 80% of each message window and lets the fuller window speak", () => {
    expect(usageLimitNotice(status({ messages: { lastHour: 24, perHour: 30 } }), format)).toEqual({
      text: "You've sent 24 of 30 messages allowed in the last hour.",
      tone: "caution"
    });
    expect(usageLimitNotice(status({
      messages: { lastDay: 190, lastHour: 24, perDay: 200, perHour: 30 }
    }), format)?.text).toBe("You've sent 190 of 200 messages allowed in the last 24 hours.");
  });

  it("explains a reached budget with the reset date", () => {
    expect(usageLimitNotice(status({ monthlyBudgetMicros: 10_000_000, monthSpentMicros: 10_250_000 }), format)).toEqual({
      text: "You've used your monthly budget (≈ $10.25 of $10.00). New messages resume on Nov 1 at 12:00 AM.",
      tone: "critical"
    });
    expect(usageLimitNotice(status({ monthlyBudgetMicros: 0 }), format)).toEqual({
      text: "Your monthly budget is $0.00, so new messages are unavailable. Ask your administrator to raise it.",
      tone: "critical"
    });
  });

  it("explains a reached message window with the time it frees, the later one when both are full", () => {
    expect(usageLimitNotice(status({
      messages: { hourFreesAt: "2026-10-07T12:20:00.000Z", lastHour: 30, perHour: 30 }
    }), format)).toEqual({
      text: "You've sent 30 of 30 messages allowed in the last hour. You can send again at 12:20 PM.",
      tone: "critical"
    });
    expect(usageLimitNotice(status({
      messages: {
        dayFreesAt: "2026-10-08T09:15:00.000Z",
        hourFreesAt: "2026-10-07T12:20:00.000Z",
        lastDay: 200,
        lastHour: 30,
        perDay: 200,
        perHour: 30
      }
    }), format)?.text).toBe("You've sent 200 of 200 messages allowed in the last 24 hours. You can send again on Oct 8 at 9:15 AM.");
    expect(usageLimitNotice(status({ messages: { perDay: 0 } }), format)?.text)
      .toBe("Your administrator allows no messages per day. Ask them to raise the limit.");
  });

  it("puts the shared cap first, even for a user without personal limits", () => {
    expect(usageLimitNotice(status({ installationExhausted: true, monthlyBudgetMicros: 10_000_000, monthSpentMicros: 20_000_000 }), format)).toEqual({
      text: "New messages are paused: the shared monthly usage limit is reached. It resets on Nov 1 at 12:00 AM, or sooner if your administrator raises it.",
      tone: "critical"
    });
  });

  it("formats reset times in the viewer's zone and locale", () => {
    const pacific = { ...format, timeZone: "America/Los_Angeles" };
    expect(formatUsageResetTime("2026-11-01T00:00:00.000Z", pacific)).toBe("on Oct 31 at 5:00 PM");
    expect(formatUsageResetTime("2026-10-07T12:20:00.000Z", { ...format, locale: "en-GB" })).toBe("at 12:20");
  });
});

describe("usage limits in Settings", () => {
  it("stays hidden when no limit applies", () => {
    expect(usageLimitsSettingsView(status({ messages: { lastHour: 4 }, monthSpentMicros: 3_000_000 }), format)).toBeNull();
  });

  it("mirrors the budget, the meter share and both message windows", () => {
    expect(usageLimitsSettingsView(status({
      messages: { lastDay: 40, lastHour: 12, perDay: 200, perHour: 30 },
      monthlyBudgetMicros: 10_000_000,
      monthSpentMicros: 3_200_000
    }), format)).toEqual({
      budget: { percent: 32, resets: "Resets on Nov 1 at 12:00 AM. Months follow UTC.", text: "≈ $3.20 of $10.00", tone: "ok" },
      installation: null,
      messages: { text: "12 of 30 in the last hour · 40 of 200 in the last 24 hours", tone: "ok" }
    });
  });

  it("keeps the tone of the fullest window and caps the meter at a full bar", () => {
    const view = usageLimitsSettingsView(status({
      messages: { lastDay: 200, lastHour: 3, perDay: 200, perHour: 30 },
      monthlyBudgetMicros: 1_000_000,
      monthSpentMicros: 1_400_000
    }), format);
    expect(view?.budget).toMatchObject({ percent: 100, text: "≈ $1.40 of $1.00", tone: "critical" });
    expect(view?.messages?.tone).toBe("critical");
    expect(usageLimitsSettingsView(status({ monthlyBudgetMicros: 0 }), format)?.budget)
      .toMatchObject({ percent: 100, text: "$0.00 of $0.00", tone: "critical" });
  });

  it("reports a reached shared cap without any installation amount", () => {
    const view = usageLimitsSettingsView(status({ installationExhausted: true }), format);
    expect(view).toEqual({
      budget: null,
      installation: "New messages are paused for everyone: the shared monthly usage limit is reached. It resets on Nov 1 at 12:00 AM.",
      messages: null
    });
  });
});

describe("next usage limit change", () => {
  it("is the earliest instant a reached limit frees up", () => {
    expect(usageLimitNextChange(status({ messages: { lastHour: 12, perHour: 30 } }))).toBeNull();
    expect(usageLimitNextChange(status({
      messages: { dayFreesAt: "2026-10-08T09:15:00.000Z", hourFreesAt: "2026-10-07T12:20:00.000Z", lastDay: 200, lastHour: 30, perDay: 200, perHour: 30 }
    }))).toBe("2026-10-07T12:20:00.000Z");
    expect(usageLimitNextChange(status({ monthlyBudgetMicros: 1, monthSpentMicros: 1 }))).toBe("2026-11-01T00:00:00.000Z");
    expect(usageLimitNextChange(status({ monthlyBudgetMicros: 0 }))).toBeNull();
  });
});
