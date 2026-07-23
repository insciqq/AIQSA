import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  createProviderAdaptersFromEnv,
  createSearchProviderAdaptersFromEnv
} from "@/lib/server/providers/registry";
import { createGetModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const GET = createGetModelRunHandler({
  getConfig: () => getAuthConfig(),
  providers: createProviderAdaptersFromEnv(),
  repository,
  resolveAuth: resolveRequestAuth,
  searchProviders: createSearchProviderAdaptersFromEnv(),
  storage: createS3StorageAdapter()
});
