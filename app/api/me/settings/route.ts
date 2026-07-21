import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createPrismaCatalogDataLoader } from "@/lib/server/catalog/prismaCatalogData";
import { prisma } from "@/lib/server/prisma";
import { createUpdateSettingsHandler } from "@/lib/server/settings/handlers";
import { createPrismaSettingsRepository } from "@/lib/server/settings/prismaRepository";

export const runtime = "nodejs";

const settingsRepository = createPrismaSettingsRepository(prisma);
const loadCatalogData = createPrismaCatalogDataLoader({ prisma });

export const PATCH = createUpdateSettingsHandler({
  loadSettingsData: loadCatalogData,
  resolveAuth: resolveRequestAuth,
  updateSettings: settingsRepository.updateSettings
});
