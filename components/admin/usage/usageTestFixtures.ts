import {
  ADMIN_USAGE_CATEGORIES,
  type AdminUsageAmounts,
  type AdminUsageAnalytics,
  type AdminUsageAnalyticsResponse,
  type AdminUsageCategory,
  type AdminUsageSeriesPoint
} from "@/lib/contracts/adminUsageAnalytics";

/** Test fixtures shaped by the analytics contract (the endpoint ships separately). */
export function usageAmounts(overrides: Partial<AdminUsageAmounts> = {}): AdminUsageAmounts {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    estimatedCostMicros: null,
    incompleteUsageCount: 0,
    inputTokens: 0,
    knownCostRecordCount: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    recordCount: 0,
    runCount: 0,
    totalTokens: 0,
    ...overrides
  };
}

export function seriesPoint(
  start: string,
  values: Partial<Record<AdminUsageCategory, readonly [costMicros: number, tokens: number]>> = {},
  runCount = 0
): AdminUsageSeriesPoint {
  const categories = Object.fromEntries(ADMIN_USAGE_CATEGORIES.map((category) => {
    const [estimatedCostMicros, totalTokens] = values[category] ?? [0, 0];
    return [category, { estimatedCostMicros, totalTokens }];
  })) as AdminUsageSeriesPoint["categories"];
  return { categories, runCount, start };
}

export function emptyUsageAnalytics(): AdminUsageAnalytics {
  return {
    byCategory: [],
    byGroup: [],
    byModel: [],
    byUser: [],
    previous: {
      activeUserCount: 0,
      estimatedCostMicros: null,
      from: "2026-08-08T00:00:00.000Z",
      runCount: 0,
      to: "2026-09-07T00:00:00.000Z",
      totalTokens: null
    },
    series: [seriesPoint("2026-10-05T00:00:00.000Z"), seriesPoint("2026-10-06T00:00:00.000Z")],
    totals: { ...usageAmounts(), activeUserCount: 0, lastUsedAt: null },
    userCount: 4,
    window: {
      bucket: "day",
      from: "2026-09-07T00:00:00.000Z",
      period: "30d",
      timeZone: "UTC",
      to: "2026-10-07T00:00:00.000Z"
    }
  };
}

export function populatedUsageAnalytics(): AdminUsageAnalytics {
  return {
    byCategory: [
      { ...usageAmounts({ estimatedCostMicros: 3_000_000, knownCostRecordCount: 4, recordCount: 4, runCount: 3, totalTokens: 9_000 }), category: "chat" },
      { ...usageAmounts({ estimatedCostMicros: 1_000_000, knownCostRecordCount: 1, recordCount: 1, runCount: 1, totalTokens: 1_000 }), category: "scheduled" },
      { ...usageAmounts({ estimatedCostMicros: null, recordCount: 1, totalTokens: 500 }), category: "background" }
    ],
    byGroup: [
      {
        ...usageAmounts({ estimatedCostMicros: 4_000_000, knownCostRecordCount: 5, recordCount: 6, runCount: 4, totalTokens: 10_500 }),
        archivedAt: null,
        contributingUsers: 2,
        groupId: "group-1",
        name: "Operators",
        userCount: 3
      }
    ],
    byModel: [
      {
        ...usageAmounts({ estimatedCostMicros: 3_500_000, knownCostRecordCount: 4, recordCount: 4, runCount: 3, totalTokens: 8_000 }),
        label: "OpenAI / GPT 5.5",
        modelId: "gpt-5.5",
        provider: "openai",
        userCount: 2
      },
      {
        ...usageAmounts({ estimatedCostMicros: 500_000, knownCostRecordCount: 1, recordCount: 2, runCount: 1, totalTokens: 2_500 }),
        label: "Anthropic / Claude",
        modelId: "claude",
        provider: "anthropic",
        userCount: 1
      }
    ],
    byUser: [
      {
        ...usageAmounts({ estimatedCostMicros: 3_000_000, knownCostRecordCount: 3, recordCount: 3, runCount: 3, totalTokens: 7_000 }),
        displayName: "Ada Admin",
        email: "ada@example.com",
        groups: [{ groupId: "group-1", name: "Operators", role: "member" }],
        lastUsedAt: "2026-10-06T10:00:00.000Z",
        topModels: [{ estimatedCostMicros: 3_000_000, label: "OpenAI / GPT 5.5", modelId: "gpt-5.5", provider: "openai", totalTokens: 7_000 }],
        userId: "user-1"
      },
      {
        ...usageAmounts({ estimatedCostMicros: 1_000_000, knownCostRecordCount: 2, recordCount: 3, runCount: 1, totalTokens: 3_500 }),
        displayName: "Bo Builder",
        email: null,
        groups: [],
        lastUsedAt: "2026-10-05T09:00:00.000Z",
        topModels: [],
        userId: "user-2"
      }
    ],
    previous: {
      activeUserCount: 2,
      estimatedCostMicros: 2_000_000,
      from: "2026-08-08T00:00:00.000Z",
      runCount: 5,
      to: "2026-09-07T00:00:00.000Z",
      totalTokens: 0
    },
    series: [
      seriesPoint("2026-10-05T00:00:00.000Z", { chat: [1_000_000, 4_000], scheduled: [1_000_000, 1_000] }, 2),
      seriesPoint("2026-10-06T00:00:00.000Z", { background: [0, 500], chat: [2_000_000, 5_000] }, 2)
    ],
    totals: {
      ...usageAmounts({ estimatedCostMicros: 4_000_000, knownCostRecordCount: 5, recordCount: 6, runCount: 4, totalTokens: 10_500 }),
      activeUserCount: 2,
      lastUsedAt: "2026-10-06T10:00:00.000Z"
    },
    userCount: 4,
    window: {
      bucket: "day",
      from: "2026-09-07T00:00:00.000Z",
      period: "30d",
      timeZone: "UTC",
      to: "2026-10-07T00:00:00.000Z"
    }
  };
}

export function usageResponse(usage: AdminUsageAnalytics): AdminUsageAnalyticsResponse {
  return { usage };
}
