import { defaultAssistantRepository } from "../assistants/defaultAssistants";
import { getAuthConfig } from "../auth/config";
import { isTestModeAllowedEnv } from "../auth/csrf";
import { createPrismaChatTitleGenerator } from "../chats/titleGeneration";
import { defaultNativeEngineHandlerDeps } from "../engine/defaultEngine";
import { defaultInstructionPresets } from "../instructions/defaultInstructions";
import { defaultSkillCatalogRelevance, defaultSkillRepository } from "../skills/defaultSkills";
import { getDefaultChatPdf } from "../uploads/defaultChatPdf";
import { createS3StorageAdapter } from "../uploads/storage";
import { usageLimitsRepository } from "../usageLimits/defaultRepository";
import { workspaceAdmissionService, workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { defaultRunServices } from "./defaultRunServices";
import { getDefaultWorkspaceFollowup } from "./defaultWorkspaceFollowup";
import type { RunHandlerDeps } from "./handlers";
import { createPrismaRunRepository } from "./prismaRepository";
import { getDefaultSubagentBackground } from "./subagentBackground/default";
import { installationToolBudgetPolicy } from "./toolBudgets";

/**
 * Everything the ordinary send admission needs except who is sending: the chat
 * messages route adds the request session, the scheduled task runner the task
 * owner and Telegram the linked user. Every entry point therefore admits
 * through identical services and runs on the same agent engine.
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
    nativeEngine: { ...defaultNativeEngineHandlerDeps(storage),
      subagentRecovery: (input) => getDefaultSubagentBackground().reconcile(input) },
    workspaceFollowup: getDefaultWorkspaceFollowup(),
    providers: {},
    repository: createPrismaRunRepository(),
    runPolicy: installationToolBudgetPolicy,
    skills: defaultSkillRepository,
    skillCatalogRelevance: defaultSkillCatalogRelevance,
    usageLimits: usageLimitsRepository,
    workspace: workspaceAdmissionService,
    workspaceCoordinator: workspaceCoordinatorForStorage(storage)
  };
}
