import type { PrismaClient } from "@prisma/client";
import type { AdminUsageAggregationInput } from "./adminUsageAggregation";

export type AdminUsageQueryRows = Pick<
  AdminUsageAggregationInput,
  "providerModelRows" | "userRows"
>;

export async function loadAdminUsageQueryRows(prisma: PrismaClient): Promise<AdminUsageQueryRows> {
  const [userRows, providerModelRows, modelRunRows, linkedProviderModelRuns] = await Promise.all([
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
    })
  ]);
  const runCountByUserId = new Map(modelRunRows.map((row) => [row.userId, row._count._all]));
  const runCountByProviderModel = new Map<string, number>();
  for (const row of linkedProviderModelRuns) {
    const key = `${row.userId}\u0000${row.provider}\u0000${row.modelId}`;
    runCountByProviderModel.set(key, (runCountByProviderModel.get(key) ?? 0) + 1);
  }

  return {
    providerModelRows: providerModelRows.map((row) => ({
      ...row,
      _count: {
        _all: runCountByProviderModel.get(`${row.userId}\u0000${row.provider}\u0000${row.modelId}`) ?? 0
      }
    })),
    userRows: userRows.map((row) => ({
      ...row,
      _count: {
        _all: runCountByUserId.get(row.userId) ?? 0
      }
    }))
  };
}
