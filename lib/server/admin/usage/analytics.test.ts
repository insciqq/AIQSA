import { describe, expect, it } from "vitest";
import { decodeAdminUsageAnalyticsResponse, type AdminUsageAmounts } from "@/lib/contracts/adminUsageAnalytics";
import { addUsageAmounts, emptyUsageAmounts, serializeAdminUsageAnalytics, type UsageAggregateRow } from "./analytics";
import { rawUsageModelKey, type ResolvedUsageModel } from "./models";
import { planUsageWindow } from "./window";

const plan = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:00:00.000Z"), period: "7d", timeZone: "UTC" });
const amounts = (input: Partial<AdminUsageAmounts>): AdminUsageAmounts => ({ ...emptyUsageAmounts(), recordCount: 1, ...input });
const row = (input: Partial<UsageAggregateRow> & Pick<UsageAggregateRow, "set">): UsageAggregateRow => ({
  amounts: amounts({}), bucket: null, category: null, lastUsedAt: null, model: null, userCount: 1, userId: null, ...input
});
const catalogModel: ResolvedUsageModel = {
  key: "model\u001fpm-a", label: "OpenRouter / Alpha", modelId: "pm-a", modelLabel: "Alpha", provider: "conn", providerLabel: "OpenRouter"
};
const rawKey = rawUsageModelKey("openrouter", "vendor/raw");

describe("usage analytics projection", () => {
  it("fills empty buckets, sorts by cost with unknown cost last and passes the strict decoder", () => {
    const usage = serializeAdminUsageAnalytics({
      groups: [
        { archivedAt: null, id: "g-team", memberCount: 3, name: "Team" },
        { archivedAt: new Date("2026-01-01T00:00:00.000Z"), id: "g-old", memberCount: 1, name: "Old" },
        { archivedAt: null, id: "g-empty", memberCount: 0, name: "Empty" }
      ],
      models: new Map([[catalogModel.key, catalogModel]]),
      plan,
      previous: { activeUserCount: 1, estimatedCostMicros: 10, runCount: 2, totalTokens: null },
      rows: [
        row({ set: "total", amounts: amounts({ recordCount: 3, runCount: 2, estimatedCostMicros: 300, knownCostRecordCount: 2,
          totalTokens: 90 }), userCount: 2, lastUsedAt: new Date("2026-10-07T11:00:00.000Z") }),
        row({ set: "bucket", bucket: "2026-10-05", amounts: amounts({ runCount: 2 }) }),
        row({ set: "bucket_category", bucket: "2026-10-05", category: "chat", amounts: amounts({ estimatedCostMicros: 300, totalTokens: 60 }) }),
        row({ set: "bucket_category", bucket: "2026-10-05", category: "background", amounts: amounts({ totalTokens: 30 }) }),
        row({ set: "category", category: "background", amounts: amounts({ totalTokens: 30 }) }),
        row({ set: "category", category: "chat", amounts: amounts({ estimatedCostMicros: 300, totalTokens: 60 }) }),
        row({ set: "model", model: rawKey, amounts: amounts({ totalTokens: 30 }) }),
        row({ set: "model", model: catalogModel.key, amounts: amounts({ estimatedCostMicros: 300, totalTokens: 60 }), userCount: 2 }),
        row({ set: "user", userId: "u-cheap", amounts: amounts({ estimatedCostMicros: 0, knownCostRecordCount: 1, totalTokens: 10, runCount: 1 }) }),
        row({ set: "user", userId: "u-big", amounts: amounts({ estimatedCostMicros: 300, knownCostRecordCount: 1, totalTokens: 80, runCount: 1 }),
          lastUsedAt: new Date("2026-10-07T11:00:00.000Z") }),
        row({ set: "user_model", userId: "u-big", model: rawKey, amounts: amounts({ totalTokens: 20 }) }),
        row({ set: "user_model", userId: "u-big", model: catalogModel.key, amounts: amounts({ estimatedCostMicros: 300, totalTokens: 60 }) })
      ],
      userCount: 5,
      users: [
        { displayName: "Big", email: "big@example.com", id: "u-big",
          groups: [{ groupId: "g-team", role: "member", group: { name: "Team" } }, { groupId: "g-old", role: "owner", group: { name: "Old" } }] },
        { displayName: "", email: null, id: "u-cheap", groups: [{ groupId: "g-team", role: "member", group: { name: "Team" } }] }
      ]
    });

    expect(decodeAdminUsageAnalyticsResponse(JSON.parse(JSON.stringify({ usage })))).not.toBeNull();
    expect(usage.series).toHaveLength(7);
    expect(usage.series.map((point) => point.runCount)).toEqual([0, 0, 0, 0, 2, 0, 0]);
    expect(usage.series[4]!.categories).toMatchObject({ chat: { estimatedCostMicros: 300, totalTokens: 60 },
      background: { estimatedCostMicros: 0, totalTokens: 30 }, images: { estimatedCostMicros: 0, totalTokens: 0 } });
    expect(usage.byCategory.map((entry) => entry.category)).toEqual(["chat", "background"]);
    expect(usage.byModel.map((entry) => entry.label)).toEqual(["OpenRouter / Alpha", "vendor/raw"]);
    expect(usage.byModel[0]!.userCount).toBe(2);
    expect(usage.byUser.map((entry) => entry.userId)).toEqual(["u-big", "u-cheap"]);
    expect(usage.byUser[0]!.topModels.map((entry) => entry.label)).toEqual(["OpenRouter / Alpha", "vendor/raw"]);
    expect(usage.byUser[1]!.displayName).toBe("u-cheap");
    expect(usage.byGroup.map((entry) => [entry.name, entry.contributingUsers, entry.estimatedCostMicros, entry.runCount])).toEqual([
      ["Team", 2, 300, 2], ["Old", 1, 300, 1], ["Empty", 0, null, 0]
    ]);
    expect(usage.totals).toMatchObject({ activeUserCount: 2, estimatedCostMicros: 300, lastUsedAt: "2026-10-07T11:00:00.000Z" });
    expect(usage.previous).toEqual({ activeUserCount: 1, estimatedCostMicros: 10, runCount: 2, totalTokens: null,
      from: plan.previous!.from.toISOString(), to: plan.previous!.to.toISOString() });
    expect(usage.window).toEqual({ bucket: "day", from: plan.from!.toISOString(), period: "7d", timeZone: "UTC", to: plan.to.toISOString() });
  });

  it("projects an empty all-time window", () => {
    const empty = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:00:00.000Z"), period: "all", timeZone: "UTC" });
    const usage = serializeAdminUsageAnalytics({ groups: [], models: new Map(), plan: empty, previous: null, rows: [], userCount: 0, users: [] });
    expect(decodeAdminUsageAnalyticsResponse({ usage })).not.toBeNull();
    expect(usage).toMatchObject({ byUser: [], previous: null, series: [], totals: { activeUserCount: 0, recordCount: 0 },
      window: { from: null, period: "all" } });
  });

  it("keeps a nullable sum null only when neither side reports it", () => {
    const sum = addUsageAmounts(amounts({ inputTokens: 3 }), amounts({ outputTokens: null }));
    expect(sum).toMatchObject({ inputTokens: 3, outputTokens: null, recordCount: 2 });
    expect(() => addUsageAmounts(amounts({ inputTokens: Number.MAX_SAFE_INTEGER }), amounts({ inputTokens: 1 }))).toThrow();
  });
});
