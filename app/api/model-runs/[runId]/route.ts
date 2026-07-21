import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createProviderAdaptersFromEnv } from "@/lib/server/providers/registry";
import { createGetModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const GET = createGetModelRunHandler({
  getConfig: () => getAuthConfig(),
  providers: createProviderAdaptersFromEnv(),
  repository,
  resolveAuth: resolveRequestAuth
});
