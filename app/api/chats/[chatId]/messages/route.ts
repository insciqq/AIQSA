import { getDefaultChatPdf } from "@/lib/server/uploads/defaultChatPdf";
import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantRepository } from "@/lib/server/assistants/defaultAssistants";
import { getAuthConfig } from "@/lib/server/auth/config";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatMessagesPageHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { createPrismaChatTitleGenerator } from "@/lib/server/chats/titleGeneration";
import { defaultMcpRunPlan } from "@/lib/server/mcp/defaultRuntime";
import { knowledgeRunAdmissionService } from "@/lib/server/knowledge/runAdmission";
import { knowledgeToolExecutor } from "@/lib/server/knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "@/lib/server/knowledge/defaultEvidenceDispatch";
import { defaultMemoryToolEgressReceiptService } from "@/lib/server/memory/egress/receipts";
import { providerAdmissionService } from "@/lib/server/providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { createSendMessageHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { installationToolBudgetPolicy } from "@/lib/server/runs/toolBudgets";
import { defaultSkillRepository } from "@/lib/server/skills/defaultSkills";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import {
  workspaceAdmissionService,
  workspaceCoordinatorForStorage
} from "@/lib/server/workspace/defaultServices";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();
const chatRepository = createPrismaChatRepository();
const storage = createS3StorageAdapter();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatMessagesPageHandler>> = createGetChatMessagesPageHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

export const POST: AsyncRouteHandler<ReturnType<typeof createSendMessageHandler>> = createSendMessageHandler({
  allowFakeProvider: isTestModeAllowedEnv(process.env),
  assistants: defaultAssistantRepository,
  chatTitleGenerator: createPrismaChatTitleGenerator(),
  getConfig: () => getAuthConfig(),
  knowledgeAdmission: knowledgeRunAdmissionService,
  knowledgeExecutor: knowledgeToolExecutor,
  knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle,
  memoryEgress: defaultMemoryToolEgressReceiptService,
  mcp: defaultMcpRunPlan,
  chatPdf: getDefaultChatPdf(),
  providerAdmission: providerAdmissionService,
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  runPolicy: installationToolBudgetPolicy,
  skills: defaultSkillRepository,
  storage,
  workspace: workspaceAdmissionService,
  workspaceCoordinator: workspaceCoordinatorForStorage(storage)
});
