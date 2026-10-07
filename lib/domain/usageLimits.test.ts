import { describe, expect, it } from "vitest";
import {
  decodeAdminUsageUserLimitsInput,
  decodeUsageLimitRefusal,
  formatMicrosAsUsdInput,
  parseUsdToMicros,
  type EffectiveUsageLimits
} from "../contracts/usageLimits";
import { decideUsageAdmission, resolveEffectiveUsageLimits, utcMonthPeriod, USAGE_HOUR_MS } from "./usageLimits";

const unset = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };

describe("utcMonthPeriod", () => {
  it("spans the UTC calendar month, including December rollover", () => {
    expect(utcMonthPeriod(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      periodStart: new Date("2026-12-01T00:00:00.000Z"),
      resetsAt: new Date("2027-01-01T00:00:00.000Z")
    });
  });
});

describe("resolveEffectiveUsageLimits", () => {
  const groups = [
    { groupId: "g-b", name: "Beta", limits: { ...unset, monthlyBudgetMicros: 5_000_000, messagesPerHour: 10 } },
    { groupId: "g-a", name: "Alpha", limits: { ...unset, monthlyBudgetMicros: 20_000_000 } },
    { groupId: "g-c", name: "Gamma", limits: unset }
  ];

  it("takes the most generous configured group and ignores unset groups", () => {
    const limits = resolveEffectiveUsageLimits({
      groups, installation: { ...unset, monthlyBudgetMicros: 1_000_000, messagesPerDay: 50 }, user: null
    });
    expect(limits.monthlyBudgetMicros).toEqual({ source: { groupId: "g-a", kind: "group", name: "Alpha" }, value: 20_000_000 });
    expect(limits.messagesPerHour).toEqual({ source: { groupId: "g-b", kind: "group", name: "Beta" }, value: 10 });
    expect(limits.messagesPerDay).toEqual({ source: { kind: "installation" }, value: 50 });
  });

  it("lets a set override field win, even below the group value, and keeps other fields inherited", () => {
    const limits = resolveEffectiveUsageLimits({
      groups, installation: unset,
      user: { ...unset, exempt: false, monthlyBudgetMicros: 2_000_000, userId: "u" }
    });
    expect(limits.monthlyBudgetMicros).toEqual({ source: { kind: "user" }, value: 2_000_000 });
    expect(limits.messagesPerHour.value).toBe(10);
  });

  it("drops every per-user limit for an exempt user", () => {
    const limits = resolveEffectiveUsageLimits({
      groups, installation: { ...unset, messagesPerDay: 5 },
      user: { ...unset, exempt: true, monthlyBudgetMicros: 1, userId: "u" }
    });
    expect(limits).toEqual({
      exempt: true,
      messagesPerDay: { source: null, value: null },
      messagesPerHour: { source: null, value: null },
      monthlyBudgetMicros: { source: null, value: null }
    });
  });

  it("breaks ties between equal groups by name", () => {
    const limits = resolveEffectiveUsageLimits({
      groups: [
        { groupId: "z", name: "Zeta", limits: { ...unset, messagesPerDay: 7 } },
        { groupId: "a", name: "Alpha", limits: { ...unset, messagesPerDay: 7 } }
      ],
      installation: unset, user: null
    });
    expect(limits.messagesPerDay.source).toEqual({ groupId: "a", kind: "group", name: "Alpha" });
  });
});

describe("decideUsageAdmission", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const effective = (overrides: Partial<Record<"budget" | "hour" | "day", number>>): EffectiveUsageLimits => ({
    exempt: false,
    messagesPerDay: overrides.day === undefined ? { source: null, value: null } : { source: { kind: "user" }, value: overrides.day },
    messagesPerHour: overrides.hour === undefined ? { source: null, value: null } : { source: { kind: "user" }, value: overrides.hour },
    monthlyBudgetMicros: overrides.budget === undefined ? { source: null, value: null } : { source: { kind: "user" }, value: overrides.budget }
  });
  const base = {
    effective: effective({}), installationCapMicros: null, installationSpentMicros: 0, interactive: true,
    lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null }, now, userSpentMicros: 0
  };

  it("admits without limits", () => {
    expect(decideUsageAdmission(base)).toEqual({ ok: true });
  });

  it("refuses the pooled cap first without disclosing installation amounts", () => {
    const decision = decideUsageAdmission({
      ...base, effective: effective({ budget: 1 }), installationCapMicros: 100, installationSpentMicros: 100, userSpentMicros: 5
    });
    expect(decision).toEqual({
      code: "installation_budget_exhausted",
      facts: { limit: null, resetsAt: "2026-11-01T00:00:00.000Z", scope: "installation", used: null, window: "month" },
      ok: false,
      retryAfterSeconds: 24 * 24 * 3600 + 12 * 3600
    });
  });

  it("refuses a reached user budget, including a zero budget", () => {
    const decision = decideUsageAdmission({ ...base, effective: effective({ budget: 0 }) });
    expect(decision).toMatchObject({ code: "usage_budget_exhausted", facts: { limit: 0, used: 0, window: "month" }, ok: false });
    expect(decideUsageAdmission({ ...base, effective: effective({ budget: 10 }), userSpentMicros: 9 })).toEqual({ ok: true });
  });

  it("applies message limits only to interactive runs and reports when the window frees", () => {
    const freesAt = new Date(now.getTime() + 15 * 60 * 1000);
    const facts = { ...base, effective: effective({ hour: 3 }), lastHour: { count: 3, freesAt } };
    expect(decideUsageAdmission(facts)).toEqual({
      code: "message_rate_limited",
      facts: { limit: 3, resetsAt: freesAt.toISOString(), scope: "user", used: 3, window: "hour" },
      ok: false,
      retryAfterSeconds: 900
    });
    expect(decideUsageAdmission({ ...facts, interactive: false })).toEqual({ ok: true });
  });

  it("checks the daily window after the hourly one and falls back to a full window for a zero limit", () => {
    const decision = decideUsageAdmission({ ...base, effective: effective({ day: 0, hour: 10 }), lastDay: { count: 0, freesAt: null } });
    expect(decision).toMatchObject({ code: "message_rate_limited", facts: { window: "day" }, retryAfterSeconds: 24 * 3600 });
    const hourly = decideUsageAdmission({
      ...base, effective: effective({ day: 0, hour: 0 }), lastHour: { count: 0, freesAt: null }
    });
    expect(hourly).toMatchObject({ facts: { window: "hour" }, retryAfterSeconds: USAGE_HOUR_MS / 1000 });
  });
});

describe("usage limit wire helpers", () => {
  it("parses exact USD text to micro-dollars", () => {
    expect(parseUsdToMicros("12")).toBe(12_000_000);
    expect(parseUsdToMicros(" $0.25 ")).toBe(250_000);
    expect(parseUsdToMicros("1.000001")).toBe(1_000_001);
    expect(parseUsdToMicros("0")).toBe(0);
    for (const invalid of ["", "-1", "1.0000001", "1e3", "abc", "1,5", "99999999"]) {
      expect(parseUsdToMicros(invalid)).toBeNull();
    }
  });

  it("formats micro-dollars back to editable text", () => {
    expect(formatMicrosAsUsdInput(12_000_000)).toBe("12");
    expect(formatMicrosAsUsdInput(12_500_000)).toBe("12.50");
    expect(formatMicrosAsUsdInput(250_000)).toBe("0.25");
    expect(formatMicrosAsUsdInput(1_000_001)).toBe("1.000001");
  });

  it("decodes user override input strictly", () => {
    expect(decodeAdminUsageUserLimitsInput({ ...unset, exempt: false })).toEqual({ ...unset, exempt: false, expectedVersion: null });
    expect(decodeAdminUsageUserLimitsInput({ ...unset, exempt: false, expectedVersion: 7 })).toEqual({ ...unset, exempt: false, expectedVersion: 7 });
    expect(decodeAdminUsageUserLimitsInput({ ...unset })).toBeNull();
    expect(decodeAdminUsageUserLimitsInput({ ...unset, exempt: false, messagesPerHour: -1 })).toBeNull();
    expect(decodeAdminUsageUserLimitsInput({ ...unset, exempt: false, userId: "x" })).toBeNull();
  });

  it("recognizes a refusal body", () => {
    const body = {
      error: "message_rate_limited",
      usageLimit: { limit: 3, resetsAt: "2026-10-07T12:15:00.000Z", scope: "user", used: 3, window: "hour" }
    };
    expect(decodeUsageLimitRefusal(body)).toEqual(body);
    expect(decodeUsageLimitRefusal({ error: "active_run_in_progress" })).toBeNull();
  });
});
