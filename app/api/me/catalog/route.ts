import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCatalogHandler } from "@/lib/server/catalog/handlers";
import { createPrismaCatalogDataLoader } from "@/lib/server/catalog/prismaCatalogData";
import { prisma } from "@/lib/server/prisma";
import { createImageModelRoleResolver } from "@/lib/server/providerRuntime/imageModelRole";

export const runtime = "nodejs";

export const GET = createCatalogHandler({
  async resolveImageCapabilities() {
    const plan = await createImageModelRoleResolver(prisma).resolve();
    return plan ? { generation: plan.snapshot.model.capabilities.imageGeneration === true, editing: plan.snapshot.model.capabilities.imageEditing === true } : null;
  },
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  resolveAuth: resolveRequestAuth
});
