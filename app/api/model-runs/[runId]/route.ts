import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { createGetModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const GET = createGetModelRunHandler({
  getConfig: () => getAuthConfig(),
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  storage: createS3StorageAdapter()
});
