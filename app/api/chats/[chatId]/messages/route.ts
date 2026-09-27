import { agentPolicyRepository } from "@/lib/server/agents/defaultPolicy";
import { getDefaultChatPdf } from "@/lib/server/uploads/defaultChatPdf";
import { getDefaultWorkspaceFollowup } from "@/lib/server/runs/defaultWorkspaceFollowup";
import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultInstructionPresets } from "@/lib/server/instructions/defaultInstructions";
import { defaultAssistantRepository } from "@/lib/server/assistants/defaultAssistants";
import { getAuthConfig } from "@/lib/server/auth/config";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatMessagesPageHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { createPrismaChatTitleGenerator } from "@/lib/server/chats/titleGeneration";
import { defaultRunServices } from "@/lib/server/runs/defaultRunServices";
import { createSendMessageHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { installationToolBudgetPolicy } from "@/lib/server/runs/toolBudgets";
import { defaultSkillRepository, defaultSkillCatalogRelevance } from "@/lib/server/skills/defaultSkills";
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
  instructions: defaultInstructionPresets,
  chatTitleGenerator: createPrismaChatTitleGenerator(),
  getConfig: () => getAuthConfig(),
  ...defaultRunServices(storage),
  chatPdf: getDefaultChatPdf(),
  workspaceFollowup: getDefaultWorkspaceFollowup(),
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  agentPolicy: agentPolicyRepository,
  runPolicy: installationToolBudgetPolicy,
  skills: defaultSkillRepository,
  skillCatalogRelevance: defaultSkillCatalogRelevance,
  workspace: workspaceAdmissionService,
  workspaceCoordinator: workspaceCoordinatorForStorage(storage)
});
