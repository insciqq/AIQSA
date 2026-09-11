import type { PrismaClient } from "@prisma/client";
import type { AdminUsageAggregationInput } from "./adminUsageAggregation";

export type AdminUsageQueryRows = Pick<
  AdminUsageAggregationInput,
  "providerModelRows" | "userRows"
>;

export async function loadAdminUsageQueryRows(prisma: PrismaClient): Promise<AdminUsageQueryRows> {
  const [userRows, providerModelRows, modelRunRows, linkedProviderModelRuns, incompleteRows] = await Promise.all([
    prisma.usageEvent.groupBy({
      _count: {
        _all: true
      },
      _max: {
        createdAt: true
      },
      _sum: {
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        inputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        totalTokens: true
      },
      by: ["userId"]
    }),
    prisma.usageEvent.groupBy({
      _count: {
        _all: true
      },
      _max: {
        createdAt: true
      },
      _sum: {
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        inputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        totalTokens: true
      },
      by: ["userId", "provider", "modelId"]
    }),
    prisma.modelRun.groupBy({
      _count: {
        _all: true
      },
      by: ["userId"],
      where: {
        usageEvents: {
          some: {}
        }
      }
    }),
    prisma.usageEvent.groupBy({
      by: ["userId", "provider", "modelId", "modelRunId"],
      where: {
        modelRunId: {
          not: null
        }
      }
    }),
    prisma.usageEvent.groupBy({
      by: ["userId", "provider", "modelId"],
      _count: { _all: true },
      where: { usageCompleteness: { not: "COMPLETE" } }
    })
  ]);
  const runCountByUserId = new Map(modelRunRows.map((row) => [row.userId, row._count._all]));
  const runCountByProviderModel = new Map<string, number>();
  for (const row of linkedProviderModelRuns) {
    const key = `${row.userId}\u0000${row.provider}\u0000${row.modelId}`;
    runCountByProviderModel.set(key, (runCountByProviderModel.get(key) ?? 0) + 1);
  }

  const incompleteByUser = new Map<string, number>();
  const incompleteByModel = new Map<string, number>();
  for (const row of incompleteRows) {
    incompleteByUser.set(row.userId, (incompleteByUser.get(row.userId) ?? 0) + row._count._all);
    incompleteByModel.set(`${row.userId}\u0000${row.provider}\u0000${row.modelId}`, row._count._all);
  }
  return {
    providerModelRows: providerModelRows.map((row) => ({
      ...row,
      incompleteUsageCount: incompleteByModel.get(`${row.userId}\u0000${row.provider}\u0000${row.modelId}`) ?? 0,
      _count: {
        _all: runCountByProviderModel.get(`${row.userId}\u0000${row.provider}\u0000${row.modelId}`) ?? 0
      }
    })),
    userRows: userRows.map((row) => ({
      ...row,
      incompleteUsageCount: incompleteByUser.get(row.userId) ?? 0,
      _count: {
        _all: runCountByUserId.get(row.userId) ?? 0
      }
    }))
  };
}
