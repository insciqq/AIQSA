import { defaultAssistantRepository } from "@/lib/server/assistants/defaultAssistants";
import { getAuthConfig } from "@/lib/server/auth/config";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultMcpRunPlan } from "@/lib/server/mcp/defaultRuntime";
import { knowledgeRunAdmissionService } from "@/lib/server/knowledge/runAdmission";
import { knowledgeToolExecutor } from "@/lib/server/knowledge/defaultRetrieval";
import { providerAdmissionService } from "@/lib/server/providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { createSendMessageHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const POST = createSendMessageHandler({
  allowFakeProvider: isTestModeAllowedEnv(process.env),
  assistants: defaultAssistantRepository,
  getConfig: () => getAuthConfig(),
  knowledgeAdmission: knowledgeRunAdmissionService,
  knowledgeExecutor: knowledgeToolExecutor,
  mcp: defaultMcpRunPlan,
  providerAdmission: providerAdmissionService,
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  storage: createS3StorageAdapter()
});
