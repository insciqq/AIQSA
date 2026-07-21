import type { PrismaClient } from "@prisma/client";
import type { AdminCatalog } from "@/lib/contracts/admin";
import { adminProviderName } from "./adminRepositorySerializers";

export async function loadAdminGrantableCatalog(prisma: PrismaClient): Promise<AdminCatalog> {
  const [providerModels, searchStrategies] = await Promise.all([
    prisma.providerModel.findMany({
      orderBy: [
        {
          provider: "asc"
        },
        {
          displayName: "asc"
        }
      ],
      select: {
        displayName: true,
        modelId: true,
        provider: true
      },
      where: {
        enabled: true
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
  const providers = Array.from(new Set(providerModels.map((model) => model.provider))).sort();

  return {
    models: providerModels,
    providers: providers.map((provider) => ({
      id: provider,
      name: adminProviderName(provider)
    })),
    searchStrategies
  };
}
