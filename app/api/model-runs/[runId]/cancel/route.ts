import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { createCancelModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const POST = createCancelModelRunHandler({
  getConfig: () => getAuthConfig(),
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth
});
