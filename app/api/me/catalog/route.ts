import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCatalogHandler } from "@/lib/server/catalog/handlers";
import { resolveImageRouteFacts } from "@/lib/server/catalog/imageRoutes";
import { createPrismaCatalogDataLoader } from "@/lib/server/catalog/prismaCatalogData";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

export const GET = createCatalogHandler({
  // Personal chats edit with the installation image model today: see installationImageEditing.
  resolveImageRoutes: () => resolveImageRouteFacts(prisma),
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  resolveAuth: resolveRequestAuth
});
