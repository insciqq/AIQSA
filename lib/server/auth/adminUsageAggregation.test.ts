import { describe, expect, it } from "vitest";
import {
  serializeAdminUsageDashboard,
  type AdminUsageAggregateSource,
  type AdminUsageAggregateSums,
  type AdminUsageProviderModelSource
} from "./adminUsageAggregation";

type AggregateFixture = Readonly<{
  count: number;
  recordCount?: number;
  knownCostRecordCount?: number;
  lastUsedAt: Date | null;
  sums: AdminUsageAggregateSums;
  userId: string;
}>;

function aggregate(fixture: AggregateFixture): AdminUsageAggregateSource {
  return {
    recordCount: fixture.recordCount ?? fixture.count,
    knownCostRecordCount: fixture.knownCostRecordCount ?? 0,
    incompleteUsageCount: 0,
    _count: {
      _all: fixture.count
    },
    _max: {
      createdAt: fixture.lastUsedAt
    },
    _sum: fixture.sums,
    userId: fixture.userId
  };
}

function providerModelAggregate(
  fixture: AggregateFixture & Readonly<{ modelId: string; provider: string }>
): AdminUsageProviderModelSource {
  return {
    ...aggregate(fixture),
    modelId: fixture.modelId,
    provider: fixture.provider
  };
}

describe("admin usage aggregation", () => {
  it("sums known costs and coverage independently of retained runs across users, groups and models", () => {
    const mixed = aggregate({ count: 1, recordCount: 3, knownCostRecordCount: 2,
      lastUsedAt: new Date("2026-09-30T10:00:00.000Z"),
      sums: { estimatedCostMicros: 12_345, totalTokens: 15 }, userId: "mixed" });
    const unknown = aggregate({ count: 0, recordCount: 2, lastUsedAt: mixed._max.createdAt,
      sums: { totalTokens: 8 }, userId: "unknown" });
    const result = serializeAdminUsageDashboard({
      groups: [{ id: "group", name: "Team", archivedAt: null, _count: { users: 2 } }],
      users: ["mixed", "unknown"].map((id) => ({ id, displayName: id, email: null,
        groups: [{ groupId: "group", role: "member" }] })),
      userRows: [mixed, unknown],
      providerModelRows: [
        { ...mixed, recordCount: 2, knownCostRecordCount: 1, provider: "fixture", modelId: "paid-model" },
        { ...unknown, provider: "fixture", modelId: "unknown-model" },
        providerModelAggregate({ userId: "mixed", count: 0, recordCount: 1, knownCostRecordCount: 1,
          lastUsedAt: mixed._max.createdAt, provider: "fixture", modelId: "zero-cost-model",
          sums: { estimatedCostMicros: 0, totalTokens: 0 } })
      ]
    });
    const expected = { estimatedCostMicros: 12_345, recordCount: 5, knownCostRecordCount: 2, runCount: 1 };
    expect(result.totals).toMatchObject(expected);
    expect(result.byGroup[0]).toMatchObject(expected);
    expect(result.byUser.find((user) => user.userId === "mixed")).toMatchObject({
      estimatedCostMicros: 12_345, recordCount: 3, knownCostRecordCount: 2, runCount: 1,
      providerModels: [expect.objectContaining({ estimatedCostMicros: 12_345, recordCount: 2, knownCostRecordCount: 1 }),
        expect.objectContaining({ estimatedCostMicros: 0, recordCount: 1, knownCostRecordCount: 1, runCount: 0 })]
    });
    expect(result.byUser.find((user) => user.userId === "unknown")).toMatchObject({
      estimatedCostMicros: null, recordCount: 2, knownCostRecordCount: 0, runCount: 0,
      providerModels: [expect.objectContaining({ estimatedCostMicros: null, recordCount: 2, knownCostRecordCount: 0 })]
    });
  });

  it("exposes incomplete usage while retaining known sums and explicit zero", () => {
    const row = aggregate({ count: 1, lastUsedAt: new Date("2026-07-12T10:00:00.000Z"),
      sums: { inputTokens: 0, outputTokens: 4, totalTokens: 4 }, userId: "known" });
    const unknown = aggregate({ count: 1, lastUsedAt: row._max.createdAt, sums: {}, userId: "unknown" });
    const result = serializeAdminUsageDashboard({ groups: [], providerModelRows: [],
      userRows: [{ ...row, incompleteUsageCount: 1 }, { ...unknown, incompleteUsageCount: 2 }],
      users: ["known", "unknown"].map((id) => ({ id, displayName: id, email: null, groups: [] })) });
    expect(result.totals).toMatchObject({ inputTokens: 0, outputTokens: 4, totalTokens: 4,
      cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, incompleteUsageCount: 3 });
    expect(result.byUser.find((user) => user.userId === "unknown")).toMatchObject({ totalTokens: null, incompleteUsageCount: 2 });
  });

  it("preserves reported zero, missing fields, current multi-group attribution, and archived groups", () => {
    const result = serializeAdminUsageDashboard({
      groups: [
        {
          _count: { users: 2 },
          archivedAt: null,
          id: "group-active",
          name: "Active group"
        },
        {
          _count: { users: 1 },
          archivedAt: new Date("2026-07-01T00:00:00.000Z"),
          id: "group-archived",
          name: "Archived group"
        },
        {
          _count: { users: 0 },
          archivedAt: null,
          id: "group-empty",
          name: "Empty group"
        },
        {
          _count: { users: 1 },
          archivedAt: null,
          id: "group-zero",
          name: "Zero group"
        }
      ],
      providerModelRows: [
        providerModelAggregate({
          count: 1,
          lastUsedAt: new Date("2026-07-12T10:00:00.000Z"),
          modelId: "a-model",
          provider: "anthropic",
          sums: {
            cachedInputTokens: 1,
            cacheWriteInputTokens: null,
            inputTokens: 7,
            outputTokens: 3,
            reasoningTokens: 2,
            totalTokens: 10
          },
          userId: "user-a"
        }),
        providerModelAggregate({
          count: 1,
          lastUsedAt: new Date("2026-07-12T11:00:00.000Z"),
          modelId: "z-model",
          provider: "openai",
          sums: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 0
          },
          userId: "user-a"
        }),
        providerModelAggregate({
          count: 1,
          lastUsedAt: new Date("2026-07-12T13:00:00.000Z"),
          modelId: "b-model",
          provider: "openrouter",
          sums: {
            cacheWriteInputTokens: 3,
            inputTokens: 4,
            outputTokens: 6,
            totalTokens: 25
          },
          userId: "user-b"
        })
      ],
      userRows: [
        aggregate({
          count: 2,
          lastUsedAt: new Date("2026-07-12T12:00:00.000Z"),
          sums: {
            cachedInputTokens: 1,
            cacheWriteInputTokens: null,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            totalTokens: 0
          },
          userId: "user-a"
        }),
        aggregate({
          count: 1,
          lastUsedAt: new Date("2026-07-12T13:00:00.000Z"),
          sums: {
            cachedInputTokens: null,
            cacheWriteInputTokens: 3,
            inputTokens: 4,
            outputTokens: 6,
            reasoningTokens: null,
            totalTokens: 25
          },
          userId: "user-b"
        })
      ],
      users: [
        {
          displayName: "Alice",
          email: "alice@example.com",
          groups: [
            {
              group: { archivedAt: null, name: "Active group" },
              groupId: "group-active",
              role: "member"
            },
            {
              group: {
                archivedAt: new Date("2026-07-01T00:00:00.000Z"),
                name: "Archived group"
              },
              groupId: "group-archived",
              role: "member"
            }
          ],
          id: "user-a"
        },
        {
          displayName: "Bob",
          email: null,
          groups: [
            {
              group: { archivedAt: null, name: "Active group" },
              groupId: "group-active",
              role: "owner"
            }
          ],
          id: "user-b"
        },
        {
          displayName: "Zero",
          email: "zero@example.com",
          groups: [
            {
              group: { archivedAt: null, name: "Zero group" },
              groupId: "group-zero",
              role: "member"
            }
          ],
          id: "user-zero"
        }
      ]
    });

    expect(result).toEqual({
      byGroup: [
        {
          incompleteUsageCount: 0,
          archivedAt: null,
          cachedInputTokens: 1,
          cacheWriteInputTokens: 3,
          contributingUsers: 2,
          groupId: "group-active",
          inputTokens: 14,
          lastUsedAt: "2026-07-12T13:00:00.000Z",
          name: "Active group",
          outputTokens: 11,
          reasoningTokens: 2,
          runCount: 3,
          recordCount: 3,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: 25,
          userCount: 2
        },
        {
          incompleteUsageCount: 0,
          archivedAt: "2026-07-01T00:00:00.000Z",
          cachedInputTokens: 1,
          cacheWriteInputTokens: null,
          contributingUsers: 1,
          groupId: "group-archived",
          inputTokens: 10,
          lastUsedAt: "2026-07-12T12:00:00.000Z",
          name: "Archived group",
          outputTokens: 5,
          reasoningTokens: 2,
          runCount: 2,
          recordCount: 2,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: 0,
          userCount: 1
        },
        {
          incompleteUsageCount: 0,
          archivedAt: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          contributingUsers: 0,
          groupId: "group-empty",
          inputTokens: null,
          lastUsedAt: null,
          name: "Empty group",
          outputTokens: null,
          reasoningTokens: null,
          runCount: 0,
          recordCount: 0,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: null,
          userCount: 0
        },
        {
          incompleteUsageCount: 0,
          archivedAt: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          contributingUsers: 0,
          groupId: "group-zero",
          inputTokens: null,
          lastUsedAt: null,
          name: "Zero group",
          outputTokens: null,
          reasoningTokens: null,
          runCount: 0,
          recordCount: 0,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: null,
          userCount: 1
        }
      ],
      byUser: [
        {
          incompleteUsageCount: 0,
          cachedInputTokens: null,
          cacheWriteInputTokens: 3,
          displayName: "Bob",
          email: null,
          groups: [
            {
              groupId: "group-active",
              name: "Active group",
              role: "owner"
            }
          ],
          inputTokens: 4,
          lastUsedAt: "2026-07-12T13:00:00.000Z",
          outputTokens: 6,
          providerModels: [
            {
              incompleteUsageCount: 0,
              cachedInputTokens: null,
              cacheWriteInputTokens: 3,
              inputTokens: 4,
              lastUsedAt: "2026-07-12T13:00:00.000Z",
              modelId: "b-model",
              outputTokens: 6,
              provider: "openrouter",
              reasoningTokens: null,
              runCount: 1,
              recordCount: 1,
              knownCostRecordCount: 0,
              estimatedCostMicros: null,
              totalTokens: 25
            }
          ],
          reasoningTokens: null,
          runCount: 1,
          recordCount: 1,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: 25,
          userId: "user-b"
        },
        {
          incompleteUsageCount: 0,
          cachedInputTokens: 1,
          cacheWriteInputTokens: null,
          displayName: "Alice",
          email: "alice@example.com",
          groups: [
            {
              groupId: "group-active",
              name: "Active group",
              role: "member"
            },
            {
              groupId: "group-archived",
              name: "Archived group",
              role: "member"
            }
          ],
          inputTokens: 10,
          lastUsedAt: "2026-07-12T12:00:00.000Z",
          outputTokens: 5,
          providerModels: [
            {
              incompleteUsageCount: 0,
              cachedInputTokens: 1,
              cacheWriteInputTokens: null,
              inputTokens: 7,
              lastUsedAt: "2026-07-12T10:00:00.000Z",
              modelId: "a-model",
              outputTokens: 3,
              provider: "anthropic",
              reasoningTokens: 2,
              runCount: 1,
              recordCount: 1,
              knownCostRecordCount: 0,
              estimatedCostMicros: null,
              totalTokens: 10
            },
            {
              incompleteUsageCount: 0,
              cachedInputTokens: null,
              cacheWriteInputTokens: null,
              inputTokens: 3,
              lastUsedAt: "2026-07-12T11:00:00.000Z",
              modelId: "z-model",
              outputTokens: 2,
              provider: "openai",
              reasoningTokens: null,
              runCount: 1,
              recordCount: 1,
              knownCostRecordCount: 0,
              estimatedCostMicros: null,
              totalTokens: 0
            }
          ],
          reasoningTokens: 2,
          runCount: 2,
          recordCount: 2,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: 0,
          userId: "user-a"
        },
        {
          incompleteUsageCount: 0,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          displayName: "Zero",
          email: "zero@example.com",
          groups: [
            {
              groupId: "group-zero",
              name: "Zero group",
              role: "member"
            }
          ],
          inputTokens: null,
          lastUsedAt: null,
          outputTokens: null,
          providerModels: [],
          reasoningTokens: null,
          runCount: 0,
          recordCount: 0,
          knownCostRecordCount: 0,
          estimatedCostMicros: null,
          totalTokens: null,
          userId: "user-zero"
        }
      ],
      totals: {
        incompleteUsageCount: 0,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 3,
        inputTokens: 14,
        lastUsedAt: "2026-07-12T13:00:00.000Z",
        outputTokens: 11,
        reasoningTokens: 2,
        runCount: 3,
        recordCount: 3,
        knownCostRecordCount: 0,
        estimatedCostMicros: null,
        totalTokens: 25
      }
    });
  });

  it("orders users and groups by tokens, runs, activity, and then name", () => {
    const orderFixtures = [
      {
        count: 2,
        displayName: "Zulu tie",
        groupId: "group-zulu",
        groupName: "Zulu tie",
        lastUsedAt: new Date("2026-07-12T13:00:00.000Z"),
        totalTokens: 10,
        userId: "user-zulu"
      },
      {
        count: 10,
        displayName: "Total first",
        groupId: "group-total",
        groupName: "Total first",
        lastUsedAt: new Date("2026-07-10T13:00:00.000Z"),
        totalTokens: 60,
        userId: "user-total"
      },
      {
        count: 3,
        displayName: "Runs second",
        groupId: "group-runs",
        groupName: "Runs second",
        lastUsedAt: new Date("2026-07-10T13:00:00.000Z"),
        totalTokens: 10,
        userId: "user-runs"
      },
      {
        count: 2,
        displayName: "Recent third",
        groupId: "group-recent",
        groupName: "Recent third",
        lastUsedAt: new Date("2026-07-12T14:00:00.000Z"),
        totalTokens: 10,
        userId: "user-recent"
      },
      {
        count: 2,
        displayName: "Alpha tie",
        groupId: "group-alpha",
        groupName: "Alpha tie",
        lastUsedAt: new Date("2026-07-12T13:00:00.000Z"),
        totalTokens: 10,
        userId: "user-alpha"
      }
    ];
    const result = serializeAdminUsageDashboard({
      groups: orderFixtures.map((fixture) => ({
        _count: { users: 1 },
        archivedAt: null,
        id: fixture.groupId,
        name: fixture.groupName
      })),
      providerModelRows: [
        providerModelAggregate({
          count: 2,
          lastUsedAt: new Date("2026-07-12T13:00:00.000Z"),
          modelId: "tie-z",
          provider: "test",
          sums: { totalTokens: 10 },
          userId: "user-total"
        }),
        providerModelAggregate({
          count: 1,
          lastUsedAt: new Date("2026-07-10T13:00:00.000Z"),
          modelId: "total",
          provider: "test",
          sums: { totalTokens: 20 },
          userId: "user-total"
        }),
        providerModelAggregate({
          count: 3,
          lastUsedAt: new Date("2026-07-10T13:00:00.000Z"),
          modelId: "runs",
          provider: "test",
          sums: { totalTokens: 10 },
          userId: "user-total"
        }),
        providerModelAggregate({
          count: 2,
          lastUsedAt: new Date("2026-07-12T14:00:00.000Z"),
          modelId: "recent",
          provider: "test",
          sums: { totalTokens: 10 },
          userId: "user-total"
        }),
        providerModelAggregate({
          count: 2,
          lastUsedAt: new Date("2026-07-12T13:00:00.000Z"),
          modelId: "tie-a",
          provider: "test",
          sums: { totalTokens: 10 },
          userId: "user-total"
        })
      ],
      userRows: orderFixtures.map((fixture) =>
        aggregate({
          count: fixture.count,
          lastUsedAt: fixture.lastUsedAt,
          sums: {
            totalTokens: fixture.totalTokens
          },
          userId: fixture.userId
        })
      ),
      users: orderFixtures.map((fixture) => ({
        displayName: fixture.displayName,
        email: null,
        groups: [
          {
            group: { archivedAt: null, name: fixture.groupName },
            groupId: fixture.groupId,
            role: "member"
          }
        ],
        id: fixture.userId
      }))
    });

    expect(result.byUser.map((user) => user.userId)).toEqual([
      "user-total",
      "user-runs",
      "user-recent",
      "user-alpha",
      "user-zulu"
    ]);
    expect(result.byGroup.map((group) => group.groupId)).toEqual([
      "group-total",
      "group-runs",
      "group-recent",
      "group-alpha",
      "group-zulu"
    ]);
    expect(result.byUser[0]?.providerModels.map((record) => record.modelId)).toEqual([
      "total",
      "runs",
      "recent",
      "tie-z",
      "tie-a"
    ]);
  });
});
