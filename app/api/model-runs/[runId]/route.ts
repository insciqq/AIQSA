import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetModelRunHandler>> = createGetModelRunHandler({
  getConfig: () => getAuthConfig(),
  repository: createPrismaRunRepository(),
  resolveAuth: resolveRequestAuth
});
