import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { knowledgeToolExecutor } from "@/lib/server/knowledge/defaultRetrieval";
import { createCancelModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const POST = createCancelModelRunHandler({
  getConfig: () => getAuthConfig(),
  knowledgeExecutor: knowledgeToolExecutor,
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth
});
