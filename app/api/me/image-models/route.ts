import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createUserImageModelHandlers } from "@/lib/server/images/userImageModelHandlers";
import { createUserImageModelService } from "@/lib/server/images/userImageModels";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, PATCH } = createUserImageModelHandlers({
  resolveAuth: resolveRequestAuth,
  service: createUserImageModelService(prisma)
});
