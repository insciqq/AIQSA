import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createRevokeShareHandler } from "@/lib/server/shares/handlers";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaShareRepository();

export const POST: AsyncRouteHandler<ReturnType<typeof createRevokeShareHandler>> = createRevokeShareHandler({
  repository,
  resolveAuth: resolveRequestAuth
});
