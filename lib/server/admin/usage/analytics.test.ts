import { describe, expect, it } from "vitest";
import {
  ADMIN_USAGE_SYSTEM_PURPOSES,
  decodeAdminUsageAnalyticsResponse,
  type AdminUsageAmounts,
  type AdminUsageAnalytics,
  type AdminUsageComparison,
  type AdminUsageUserRecord
} from "@/lib/contracts/adminUsageAnalytics";
import { SYSTEM_USAGE_PURPOSES, USAGE_PURPOSES } from "@/lib/domain/usagePurpose";
import {
  addUsageAmounts,
  adminUsageSystemPurpose,
  emptyUsageAmounts,
  serializeAdminUsageAnalytics,
  type UsageAggregateRow
} from "./analytics";
import { rawUsageModelKey, type ResolvedUsageModel } from "./models";
import { planUsageWindow } from "./window";

const plan = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:00:00.000Z"), period: "7d", timeZone: "UTC" });
const lastUsedAt = new Date("2026-10-07T11:00:00.000Z");
const amounts = (input: Partial<AdminUsageAmounts>): AdminUsageAmounts => ({ ...emptyUsageAmounts(), recordCount: 1, ...input });
const row = (input: Partial<UsageAggregateRow> & Pick<UsageAggregateRow, "set">): UsageAggregateRow => ({
  amounts: amounts({}), bucket: null, category: null, lastUsedAt: null, model: null, purpose: null, scope: null, userCount: 1,
  userId: null, ...input
});
const catalogModel: ResolvedUsageModel = {
  key: "model\u001fpm-a", label: "OpenRouter / Alpha", modelId: "pm-a", modelLabel: "Alpha", provider: "conn", providerLabel: "OpenRouter"
};
const titleModel: ResolvedUsageModel = {
  key: "model\u001fpm-t", label: "OpenRouter / Titles", modelId: "pm-t", modelLabel: "Titles", provider: "conn", providerLabel: "OpenRouter"
};
const rawKey = rawUsageModelKey("openrouter", "vendor/raw");

function usage() {
  return serializeAdminUsageAnalytics({
    groups: [
      { archivedAt: null, id: "g-team", memberCount: 3, name: "Team" },
      { archivedAt: new Date("2026-01-01T00:00:00.000Z"), id: "g-old", memberCount: 1, name: "Old" },
      { archivedAt: null, id: "g-empty", memberCount: 0, name: "Empty" }
    ],
    models: new Map([[catalogModel.key, catalogModel], [titleModel.key, titleModel]]),
    plan,
    previous: { activeUserCount: 1, estimatedCostMicros: 10, runCount: 2, systemEstimatedCostMicros: 4, totalTokens: null },
    rows: [
      row({ set: "total", amounts: amounts({ recordCount: 4, runCount: 2, estimatedCostMicros: 400, knownCostRecordCount: 3,
        totalTokens: 130 }), userCount: 2, lastUsedAt }),
      row({ set: "bucket", bucket: "2026-10-05", amounts: amounts({ runCount: 2 }) }),
      row({ set: "bucket_category", bucket: "2026-10-05", category: "chat", amounts: amounts({ estimatedCostMicros: 300, totalTokens: 70 }) }),
      // System usage without a known cost stays unknown in the series.
      row({ set: "bucket_category", bucket: "2026-10-05", category: "system", amounts: amounts({ totalTokens: 30 }) }),
      row({ set: "bucket_category", bucket: "2026-10-06", category: "system", amounts: amounts({ estimatedCostMicros: 100, totalTokens: 30 }) }),
      row({ set: "category", category: "system", amounts: amounts({ estimatedCostMicros: 100, knownCostRecordCount: 1, recordCount: 2,
        totalTokens: 60 }) }),
      row({ set: "category", category: "chat", amounts: amounts({ estimatedCostMicros: 300, totalTokens: 70 }) }),
      row({ set: "scope_model", scope: "personal", model: catalogModel.key, amounts: amounts({ estimatedCostMicros: 300, totalTokens: 70 }),
        userCount: 2 }),
      row({ set: "scope_model", scope: "system", model: rawKey, amounts: amounts({ totalTokens: 30 }) }),
      row({ set: "scope_model", scope: "system", model: titleModel.key, amounts: amounts({ estimatedCostMicros: 100, totalTokens: 30 }) }),
      row({ set: "purpose", purpose: "chat_answer", amounts: amounts({ estimatedCostMicros: 300, totalTokens: 70 }) }),
      row({ set: "purpose", purpose: "memory_retrieval", amounts: amounts({ totalTokens: 30 }) }),
      row({ set: "purpose", purpose: "chat_title", amounts: amounts({ estimatedCostMicros: 100, totalTokens: 30 }) }),
      row({ set: "purpose_model", purpose: "knowledge_retrieval", model: rawKey }),
      row({ set: "purpose_model", purpose: "memory_retrieval", model: rawKey }),
      row({ set: "purpose_model", purpose: "chat_title", model: titleModel.key }),
      row({ set: "purpose_model", purpose: "chat_answer", model: catalogModel.key }),
      row({ set: "user", userId: "u-cheap", amounts: amounts({ estimatedCostMicros: 0, knownCostRecordCount: 1, totalTokens: 40, runCount: 1 }) }),
      row({ set: "user", userId: "u-big", amounts: amounts({ estimatedCostMicros: 400, knownCostRecordCount: 2, totalTokens: 90, runCount: 1 }),
        lastUsedAt }),
      row({ set: "user_scope", userId: "u-big", scope: "personal", amounts: amounts({ estimatedCostMicros: 300, totalTokens: 60 }) }),
      row({ set: "user_scope", userId: "u-big", scope: "system", amounts: amounts({ estimatedCostMicros: 100, knownCostRecordCount: 1,
        totalTokens: 30 }) }),
      row({ set: "user_scope", userId: "u-cheap", scope: "system", amounts: amounts({ totalTokens: 30 }) }),
      row({ set: "user_scope_model", userId: "u-big", scope: "system", model: titleModel.key, amounts: amounts({ estimatedCostMicros: 900 }) }),
      row({ set: "user_scope_model", userId: "u-big", scope: "personal", model: rawKey, amounts: amounts({ totalTokens: 20 }) }),
      row({ set: "user_scope_model", userId: "u-big", scope: "personal", model: catalogModel.key, amounts: amounts({ estimatedCostMicros: 300,
        totalTokens: 60 }) })
    ],
    userCount: 5,
    users: [
      { displayName: "Big", email: "big@example.com", id: "u-big",
        groups: [{ groupId: "g-team", role: "member", group: { name: "Team" } }, { groupId: "g-old", role: "owner", group: { name: "Old" } }] },
      { displayName: "", email: null, id: "u-cheap", groups: [{ groupId: "g-team", role: "member", group: { name: "Team" } }] }
    ]
  });
}

describe("usage analytics projection", () => {
  it("fills empty buckets, sorts by cost with unknown cost last and passes the strict decoder", () => {
    const result = usage();
    expect(decodeAdminUsageAnalyticsResponse(JSON.parse(JSON.stringify({ usage: result })))).not.toBeNull();
    expect(result.series).toHaveLength(7);
    expect(result.series.map((point) => point.runCount)).toEqual([0, 0, 0, 0, 2, 0, 0]);
    expect(result.series[4]!.categories).toEqual({
      chat: { estimatedCostMicros: 300, totalTokens: 70 },
      images: { estimatedCostMicros: 0, totalTokens: 0 },
      scheduled: { estimatedCostMicros: 0, totalTokens: 0 },
      system: { estimatedCostMicros: null, totalTokens: 30 }
    });
    expect(result.series[5]!.categories.system).toEqual({ estimatedCostMicros: 100, totalTokens: 30 });
    expect(result.byCategory.map((entry) => entry.category)).toEqual(["chat", "system"]);
    expect(result.byUser.map((entry) => entry.userId)).toEqual(["u-big", "u-cheap"]);
    expect(result.byUser[1]!.displayName).toBe("u-cheap");
    expect(result.totals).toMatchObject({ activeUserCount: 2, estimatedCostMicros: 400, lastUsedAt: "2026-10-07T11:00:00.000Z" });
    expect(result.previous).toEqual({ activeUserCount: 1, estimatedCostMicros: 10, runCount: 2, systemEstimatedCostMicros: 4,
      totalTokens: null, from: plan.previous!.from.toISOString(), to: plan.previous!.to.toISOString() });
    expect(result.window).toEqual({ bucket: "day", from: plan.from!.toISOString(), period: "7d", timeZone: "UTC", to: plan.to.toISOString() });
  });

  it("lists only the models users chose under byModel and their top models", () => {
    const result = usage();
    expect(result.byModel.map((entry) => [entry.label, entry.userCount, entry.estimatedCostMicros])).toEqual([["OpenRouter / Alpha", 2, 300]]);
    // The more expensive system model of the same user is not a top model.
    expect(result.byUser[0]!.topModels.map((entry) => entry.label)).toEqual(["OpenRouter / Alpha", "vendor/raw"]);
  });

  it("breaks system spend down by function and by model with the functions each served", () => {
    const result = usage();
    expect(result.bySystemFunction.map((entry) => [entry.purpose, entry.estimatedCostMicros, entry.totalTokens])).toEqual([
      ["chat_title", 100, 30], ["memory_retrieval", null, 30]
    ]);
    expect(result.bySystemModel.map((entry) => [entry.label, entry.estimatedCostMicros, entry.purposes])).toEqual([
      ["OpenRouter / Titles", 100, ["chat_title"]],
      ["vendor/raw", null, ["memory_retrieval", "knowledge_retrieval"]]
    ]);
  });

  it("adds each user's and group's system part beside the totals", () => {
    const result = usage();
    expect(result.byUser.map((entry) => [entry.userId, entry.system])).toEqual([
      ["u-big", { estimatedCostMicros: 100, knownCostRecordCount: 1, recordCount: 1, totalTokens: 30 }],
      ["u-cheap", { estimatedCostMicros: null, knownCostRecordCount: 0, recordCount: 1, totalTokens: 30 }]
    ]);
    expect(result.byGroup.map((entry) => [entry.name, entry.contributingUsers, entry.estimatedCostMicros, entry.runCount, entry.system])).toEqual([
      ["Team", 2, 400, 2, { estimatedCostMicros: 100, knownCostRecordCount: 1, recordCount: 2, totalTokens: 60 }],
      ["Old", 1, 400, 1, { estimatedCostMicros: 100, knownCostRecordCount: 1, recordCount: 1, totalTokens: 30 }],
      ["Empty", 0, null, 0, { estimatedCostMicros: null, knownCostRecordCount: 0, recordCount: 0, totalTokens: null }]
    ]);
  });

  it("projects an empty all-time window", () => {
    const empty = planUsageWindow({ earliestUsageAt: null, now: new Date("2026-10-07T12:00:00.000Z"), period: "all", timeZone: "UTC" });
    const result = serializeAdminUsageAnalytics({ groups: [], models: new Map(), plan: empty, previous: null, rows: [], userCount: 0, users: [] });
    expect(decodeAdminUsageAnalyticsResponse({ usage: result })).not.toBeNull();
    expect(result).toMatchObject({ byUser: [], bySystemFunction: [], bySystemModel: [], previous: null, series: [],
      totals: { activeUserCount: 0, recordCount: 0 }, window: { from: null, period: "all" } });
  });

  it("keeps a nullable sum null only when neither side reports it", () => {
    const sum = addUsageAmounts(amounts({ inputTokens: 3 }), amounts({ outputTokens: null }));
    expect(sum).toMatchObject({ inputTokens: 3, outputTokens: null, recordCount: 2 });
    expect(() => addUsageAmounts(amounts({ inputTokens: Number.MAX_SAFE_INTEGER }), amounts({ inputTokens: 1 }))).toThrow();
  });
});

describe("usage analytics vocabulary", () => {
  it("names exactly the domain's system purposes, in its order", () => {
    expect([...ADMIN_USAGE_SYSTEM_PURPOSES]).toEqual([...SYSTEM_USAGE_PURPOSES]);
    expect(USAGE_PURPOSES.flatMap((purpose) => adminUsageSystemPurpose(purpose) ?? [])).toEqual([...SYSTEM_USAGE_PURPOSES]);
  });

  it("rejects responses with an unknown or repeated purpose, or without a user's system part", () => {
    const variant = (change: (copy: AdminUsageAnalytics) => void) => {
      const copy = structuredClone(usage());
      change(copy);
      return decodeAdminUsageAnalyticsResponse(JSON.parse(JSON.stringify({ usage: copy })));
    };
    expect(variant(() => undefined)).not.toBeNull();
    expect(variant((copy) => { (copy.bySystemFunction[0] as { purpose: string }).purpose = "chat_answer"; })).toBeNull();
    expect(variant((copy) => { copy.bySystemModel[1]!.purposes = ["memory_retrieval", "memory_retrieval"]; })).toBeNull();
    expect(variant((copy) => { delete (copy.byUser[0] as Partial<AdminUsageUserRecord>).system; })).toBeNull();
    expect(variant((copy) => { copy.byGroup[0]!.system.estimatedCostMicros = -1; })).toBeNull();
    expect(variant((copy) => {
      (copy.series[0]!.categories as Record<string, unknown>).memory = { estimatedCostMicros: 0, totalTokens: 0 };
    })).toBeNull();
    expect(variant((copy) => { delete (copy.previous as Partial<AdminUsageComparison>).systemEstimatedCostMicros; })).toBeNull();
  });
});
