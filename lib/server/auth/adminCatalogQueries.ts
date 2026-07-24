import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminCatalog } from "@/lib/contracts/admin";

function configuredUpstreamModelId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const upstreamModelId = (value as Record<string, unknown>).upstreamModelId;
  return typeof upstreamModelId === "string" && upstreamModelId.trim()
    ? upstreamModelId
    : null;
}

export async function loadAdminGrantableCatalog(prisma: PrismaClient): Promise<AdminCatalog> {
  const [providerModels, searchStrategies] = await Promise.all([
    prisma.providerModel.findMany({
      orderBy: [
        {
          connection: { displayName: "asc" }
        },
        {
          displayName: "asc"
        }
      ],
      select: {
        connection: {
          select: {
            displayName: true,
            family: true,
            id: true
          }
        },
        activeConfig: true,
        displayName: true,
        id: true
      },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        enabled: true,
        connection: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          enabled: true
        }
      }
    }),
    prisma.searchStrategy.findMany({
      orderBy: {
        strategyId: "asc"
      },
      select: {
        displayName: true,
        strategyId: true
      },
      where: {
        enabled: true,
        strategyId: {
          not: "search-disabled"
        }
      }
    })
  ]);
  const providers = new Map(
    providerModels.map((model) => [model.connection.id, model.connection.displayName])
  );

  return {
    models: providerModels.map((model) => {
      const upstreamModelId = configuredUpstreamModelId(model.activeConfig);

      return {
        displayName: model.displayName,
        modelId: model.id,
        provider: model.connection.id,
        ...(upstreamModelId
          ? {
              providerFamily: model.connection.family,
              upstreamModelId
            }
          : {})
      };
    }),
    providers: [...providers].map(([id, name]) => ({ id, name })),
    searchStrategies
  };
}
