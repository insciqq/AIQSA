import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetModelRunHandler } from "@/lib/server/runs/handlers";
import { defaultRunServices } from "@/lib/server/runs/defaultRunServices";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();
const storage = createS3StorageAdapter();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetModelRunHandler>> = createGetModelRunHandler({
  ...defaultRunServices(storage),
  getConfig: () => getAuthConfig(),
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth
});
