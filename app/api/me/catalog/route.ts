import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCatalogHandler } from "@/lib/server/catalog/handlers";
import { createPrismaCatalogDataLoader } from "@/lib/server/catalog/prismaCatalogData";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const GET = createCatalogHandler({
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  resolveAuth: resolveRequestAuth
});
