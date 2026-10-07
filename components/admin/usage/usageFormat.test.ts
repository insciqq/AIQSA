import { describe, expect, it } from "vitest";
import type { AdminUsageWindow } from "@/lib/contracts/adminUsageAnalytics";
import { foldModelRows, TOP_MODEL_ROWS } from "./UsageBreakdowns";
import {
  formatMetricValue,
  formatShare,
  formatUsageDelta,
  formatUsdTick,
  formatUsdValue,
  niceTicks,
  sumUsageAmounts,
  systemPurposeList,
  unknownCostCount,
  usageShare,
  usageShareBasis
} from "./usageFormat";
import { populatedUsageAnalytics, usageAmounts } from "./usageTestFixtures";

const window30: AdminUsageWindow = {
  bucket: "day", from: "2026-09-07T00:00:00.000Z", period: "30d", timeZone: "UTC", to: "2026-10-07T00:00:00.000Z"
};
const previous = { from: "2026-08-08T00:00:00.000Z", to: "2026-09-07T00:00:00.000Z" };

describe("usage delta", () => {
  it("names the direction and the comparable window in neutral words", () => {
    expect(formatUsageDelta(112, 100, window30, previous)).toBe("↑ 12% vs previous 30 days");
    expect(formatUsageDelta(50, 100, window30, previous)).toBe("↓ 50% vs previous 30 days");
    expect(formatUsageDelta(1001, 1000, window30, previous)).toBe("↑ <1% vs previous 30 days");
    expect(formatUsageDelta(7, 7, window30, previous)).toBe("No change vs previous 30 days");
    expect(formatUsageDelta(10, 5, { ...window30, period: "12m", bucket: "month" }, previous)).toBe("↑ 100% vs previous 12 months");
  });

  it("shows a dash without a previous window, an unknown side or a zero baseline", () => {
    expect(formatUsageDelta(5, 3, { ...window30, period: "all" }, null)).toBe("—");
    expect(formatUsageDelta(null, 3, window30, previous)).toBe("—");
    expect(formatUsageDelta(5, null, window30, previous)).toBe("—");
    expect(formatUsageDelta(5, 0, window30, previous)).toBe("—");
  });

  it("names the dates of a month-to-date comparison", () => {
    const delta = formatUsageDelta(2, 1, { ...window30, period: "this_month" }, {
      from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z"
    });
    expect(delta).toMatch(/^↑ 100% vs Sep 1 – Sep 7$/);
  });
});

describe("usage axis and values", () => {
  it("picks clean rounded ticks covering the maximum", () => {
    expect(niceTicks(3_400)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    // A 2.5 step would leave fractional tokens; steps stay multiples of the minimum.
    expect(niceTicks(9)).toEqual([0, 3, 6, 9]);
    expect(niceTicks(90_000, 4, 10_000)).toEqual([0, 30_000, 60_000, 90_000]);
    expect(niceTicks(0, 4, 10_000)).toEqual([0, 10_000]);
    expect(niceTicks(3, 4, 1)).toEqual([0, 1, 2, 3]);
    const cents = niceTicks(80_000, 4, 10_000);
    expect(cents).toEqual([0, 20_000, 40_000, 60_000, 80_000]);
  });

  it("formats USD ticks in the step's precision and never shows a tiny estimate as zero", () => {
    expect(formatUsdTick(2_000_000, 1_000_000)).toBe("$2");
    expect(formatUsdTick(500_000, 500_000)).toBe("$0.50");
    expect(formatUsdTick(25_000, 25_000)).toBe("$0.025");
    expect(formatUsdTick(0, 25_000)).toBe("$0");
    expect(formatUsdValue(0)).toBe("$0.00");
    expect(formatUsdValue(4_000)).toBe("<$0.01");
    expect(formatUsdValue(1_234_567)).toBe("$1.23");
  });

  it("formats shares without rounding small non-zero shares away", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0.756)).toBe("76%");
  });

  it("reads an unknown cost as unknown, never as zero", () => {
    expect(formatMetricValue("cost", null)).toBe("Unknown");
    expect(formatMetricValue("cost", 0)).toBe("$0.00");
    expect(formatMetricValue("tokens", 1_200)).toBe("1,200");
  });
});

describe("usage shares", () => {
  const whole = usageAmounts({ estimatedCostMicros: 4_000, recordCount: 4, totalTokens: 400 });

  it("follow cost when the whole has a known cost, otherwise tokens", () => {
    expect(usageShareBasis(whole)).toBe("cost");
    expect(usageShareBasis(usageAmounts({ estimatedCostMicros: null }))).toBe("tokens");
    expect(usageShare(usageAmounts({ estimatedCostMicros: 1_000, recordCount: 1, totalTokens: 300 }), whole, "cost")).toBe(0.25);
    expect(usageShare(usageAmounts({ estimatedCostMicros: 1_000, recordCount: 1, totalTokens: 300 }), whole, "tokens")).toBe(0.75);
  });

  it("have no cost share for usage whose cost is unknown, and none to share for an empty part", () => {
    expect(usageShare(usageAmounts({ estimatedCostMicros: null, recordCount: 2, totalTokens: 100 }), whole, "cost")).toBeNull();
    expect(usageShare(usageAmounts({ estimatedCostMicros: null, recordCount: 0 }), whole, "cost")).toBe(0);
    expect(unknownCostCount(usageAmounts({ knownCostRecordCount: 1, recordCount: 3 }))).toBe(2);
  });

  it("name system functions in the order the server lists them", () => {
    expect(systemPurposeList(["chat_title", "memory_retrieval", "knowledge_retrieval", "other"]))
      .toBe("Chat titles, Memory search, Knowledge search, Other");
  });
});

describe("usage folding", () => {
  it("keeps unknown amounts unknown and adds known ones", () => {
    expect(sumUsageAmounts([
      usageAmounts({ estimatedCostMicros: null, recordCount: 1, totalTokens: null }),
      usageAmounts({ estimatedCostMicros: 5, knownCostRecordCount: 1, recordCount: 2, totalTokens: 7 })
    ])).toMatchObject({ estimatedCostMicros: 5, knownCostRecordCount: 1, recordCount: 3, totalTokens: 7 });
    expect(sumUsageAmounts([usageAmounts({ estimatedCostMicros: null })]).estimatedCostMicros).toBeNull();
  });

  it("keeps the top models by cost and folds the rest into Other models", () => {
    const base = populatedUsageAnalytics().byModel[0]!;
    const rows = Array.from({ length: TOP_MODEL_ROWS + 2 }, (_, index) => ({
      ...base,
      estimatedCostMicros: (index + 1) * 1_000,
      label: `Model ${index + 1}`,
      modelId: `model-${index + 1}`,
      totalTokens: 10
    }));
    const folded = foldModelRows(rows);
    expect(folded).toHaveLength(TOP_MODEL_ROWS + 1);
    expect(folded[0]?.label).toBe(`Model ${TOP_MODEL_ROWS + 2}`);
    expect(folded.at(-1)).toMatchObject({ estimatedCostMicros: 3_000, label: "Other models (2)", totalTokens: 20, userCount: null });
  });
});
