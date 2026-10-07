import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCatalogHandler } from "@/lib/server/catalog/handlers";
import { resolveImageRouteFacts } from "@/lib/server/catalog/imageRoutes";
import { createPrismaCatalogDataLoader } from "@/lib/server/catalog/prismaCatalogData";
import { prisma } from "@/lib/server/prisma";
import { catalogDictation, resolveSpeechToTextRole } from "@/lib/server/speechToText/role";

export const runtime = "nodejs";

export const GET = createCatalogHandler({
  // Personal chats edit with the user's effective image model.
  resolveImageRoutes: (userId) => resolveImageRouteFacts(prisma, { kind: "personal", userId }),
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  resolveDictation: async () => catalogDictation(await resolveSpeechToTextRole(prisma)),
  resolveAuth: resolveRequestAuth
});
