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

function isAnswerSelectableModel(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
  const configuration = value as Record<string, unknown>;
  return !Object.prototype.hasOwnProperty.call(configuration, "answerSelectable") ||
    configuration.answerSelectable === true;
}

export async function loadAdminGrantableCatalog(prisma: PrismaClient): Promise<AdminCatalog> {
  const [providerModels, searchOptions] = await Promise.all([
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
        id: true,
        modelClass: true
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
    prisma.searchOption.findMany({
      orderBy: {
        optionId: "asc"
      },
      select: {
        displayName: true,
        optionId: true
      },
      where: {
        archivedAt: null,
        enabled: true,
        optionId: {
          not: "search-disabled"
        }
      }
    })
  ]);
  const grantableModels = providerModels.filter((model) =>
    model.modelClass === "embedding" || isAnswerSelectableModel(model.activeConfig)
  );
  const providers = new Map(
    grantableModels.map((model) => [model.connection.id, model.connection.displayName])
  );

  return {
    models: grantableModels.map((model) => {
      const upstreamModelId = configuredUpstreamModelId(model.activeConfig);

      return {
        displayName: model.displayName,
        modelId: model.id,
        modelClass: model.modelClass === "embedding" ? "embedding" as const : "answer" as const,
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
    searchStrategies: searchOptions.map((option) => ({
      displayName: option.displayName,
      strategyId: option.optionId
    }))
  };
}
