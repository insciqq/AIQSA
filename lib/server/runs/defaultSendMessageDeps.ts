import { agentPolicyRepository } from "../agents/defaultPolicy";
import { defaultAssistantRepository } from "../assistants/defaultAssistants";
import { getAuthConfig } from "../auth/config";
import { isTestModeAllowedEnv } from "../auth/csrf";
import { createPrismaChatTitleGenerator } from "../chats/titleGeneration";
import { defaultInstructionPresets } from "../instructions/defaultInstructions";
import { defaultSkillCatalogRelevance, defaultSkillRepository } from "../skills/defaultSkills";
import { getDefaultChatPdf } from "../uploads/defaultChatPdf";
import { createS3StorageAdapter } from "../uploads/storage";
import { workspaceAdmissionService, workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { defaultRunServices } from "./defaultRunServices";
import { getDefaultWorkspaceFollowup } from "./defaultWorkspaceFollowup";
import type { RunHandlerDeps } from "./handlers";
import { createPrismaRunRepository } from "./prismaRepository";
import { installationToolBudgetPolicy } from "./toolBudgets";

/**
 * Everything the ordinary send admission needs except who is sending: the chat
 * messages route adds the request session, the scheduled task runner the task
 * owner. Both entry points therefore admit through identical services.
 */
export function createDefaultSendMessageDeps(): Omit<RunHandlerDeps, "resolveAuth" | "scheduledOccurrence"> {
  const storage = createS3StorageAdapter();
  return {
    allowFakeProvider: isTestModeAllowedEnv(process.env),
    assistants: defaultAssistantRepository,
    instructions: defaultInstructionPresets,
    chatTitleGenerator: createPrismaChatTitleGenerator(),
    getConfig: () => getAuthConfig(),
    ...defaultRunServices(storage),
    chatPdf: getDefaultChatPdf(),
    workspaceFollowup: getDefaultWorkspaceFollowup(),
    providers: {},
    repository: createPrismaRunRepository(),
    agentPolicy: agentPolicyRepository,
    runPolicy: installationToolBudgetPolicy,
    skills: defaultSkillRepository,
    skillCatalogRelevance: defaultSkillCatalogRelevance,
    workspace: workspaceAdmissionService,
    workspaceCoordinator: workspaceCoordinatorForStorage(storage)
  };
}
