import { describe, expect, it } from "vitest";
import type { AdminUsageLimitUserRow, EffectiveUsageLimits } from "@/lib/contracts/usageLimits";
import {
  budgetStateCounts,
  formatSpend,
  formatUsdLimit,
  limitSourceLabel,
  parseLimitDraft,
  sortUsersByBudgetShare,
  usageBudgetState
} from "./usageLimitsView";

const none = { source: null, value: null };
const unlimited: EffectiveUsageLimits = { exempt: false, messagesPerDay: none, messagesPerHour: none, monthlyBudgetMicros: none };

function row(userId: string, budget: number | null, spent: number, status = "active"): AdminUsageLimitUserRow {
  return {
    displayName: userId,
    effective: budget === null ? unlimited : { ...unlimited, monthlyBudgetMicros: { source: { kind: "installation" }, value: budget } },
    email: null,
    messagesLastDay: 0,
    messagesLastHour: 0,
    monthSpentMicros: spent,
    override: null,
    status,
    userId
  };
}

describe("usage limit view helpers", () => {
  it("formats exact limits and estimated spend separately", () => {
    expect(formatUsdLimit(1_250_500_000)).toBe("$1,250.50");
    expect(formatUsdLimit(250_000)).toBe("$0.25");
    expect(formatUsdLimit(12_000_000)).toBe("$12.00");
    expect(formatUsdLimit(1)).toBe("$0.000001");
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(16_400_000)).toBe("≈ $16.40");
  });

  it("names every source of an effective limit", () => {
    expect(limitSourceLabel({ source: { kind: "user" }, value: 1 }, false)).toBe("Override");
    expect(limitSourceLabel({ source: { groupId: "g", kind: "group", name: "Research" }, value: 1 }, false)).toBe("Group: Research");
    expect(limitSourceLabel({ source: { kind: "installation" }, value: 1 }, false)).toBe("Default");
    expect(limitSourceLabel(none, true)).toBe("Exempt");
    expect(limitSourceLabel(none, false)).toBe("No limit");
  });

  it("warns from 80%, marks a reached budget and keeps a zero budget apart", () => {
    expect(usageBudgetState(5, null)).toBe("none");
    expect(usageBudgetState(0, 0)).toBe("zero");
    expect(usageBudgetState(79, 100)).toBe("ok");
    expect(usageBudgetState(80, 100)).toBe("near");
    expect(usageBudgetState(100, 100)).toBe("reached");
    expect(budgetStateCounts([
      row("a", 100, 100), row("b", 100, 85), row("c", 0, 0), row("d", null, 900), row("e", 100, 500, "disabled")
    ])).toEqual({ near: 1, reached: 1, withBudget: 3 });
  });

  it("sorts by share of budget used, then users without a budget by spend", () => {
    const sorted = sortUsersByBudgetShare([
      row("no-budget-small", null, 10), row("half", 100, 50), row("over", 100, 125),
      row("no-budget-big", null, 900), row("zero", 0, 0), row("near", 100, 90)
    ]);
    expect(sorted.map((user) => user.userId)).toEqual(["over", "zero", "near", "half", "no-budget-big", "no-budget-small"]);
  });

  it("parses empty fields as not set and explains rejected values per field", () => {
    expect(parseLimitDraft({ messagesPerDay: "", messagesPerHour: " 12 ", monthlyBudgetMicros: "$7.5" })).toEqual({
      errors: {},
      values: { messagesPerDay: null, messagesPerHour: 12, monthlyBudgetMicros: 7_500_000 }
    });
    expect(parseLimitDraft({ messagesPerDay: "100001", messagesPerHour: "1.5", monthlyBudgetMicros: "-3" })).toEqual({
      errors: {
        messagesPerDay: "Enter a whole number from 0 to 100,000.",
        messagesPerHour: "Enter a whole number from 0 to 10,000.",
        monthlyBudgetMicros: "Enter a dollar amount from 0 to 1,000,000, like 25 or 12.50."
      },
      values: null
    });
  });
});
