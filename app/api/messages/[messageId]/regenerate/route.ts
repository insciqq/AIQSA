import { agentPolicyRepository } from "@/lib/server/agents/defaultPolicy";
import { getDefaultChatPdf } from "@/lib/server/uploads/defaultChatPdf";
import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultInstructionPresets } from "@/lib/server/instructions/defaultInstructions";
import { defaultAssistantRepository } from "@/lib/server/assistants/defaultAssistants";
import { getAuthConfig } from "@/lib/server/auth/config";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultRunServices } from "@/lib/server/runs/defaultRunServices";
import { createRegenerateModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { installationToolBudgetPolicy } from "@/lib/server/runs/toolBudgets";
import { defaultSkillRepository, defaultSkillCatalogRelevance } from "@/lib/server/skills/defaultSkills";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { usageLimitsRepository } from "@/lib/server/usageLimits/defaultRepository";
import {
  workspaceAdmissionService,
  workspaceCoordinatorForStorage
} from "@/lib/server/workspace/defaultServices";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();
const storage = createS3StorageAdapter();

export const POST: AsyncRouteHandler<ReturnType<typeof createRegenerateModelRunHandler>> = createRegenerateModelRunHandler({
  allowFakeProvider: isTestModeAllowedEnv(process.env),
  assistants: defaultAssistantRepository,
  instructions: defaultInstructionPresets,
  getConfig: () => getAuthConfig(),
  ...defaultRunServices(storage),
  chatPdf: getDefaultChatPdf(),
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  agentPolicy: agentPolicyRepository,
  runPolicy: installationToolBudgetPolicy,
  skills: defaultSkillRepository,
  skillCatalogRelevance: defaultSkillCatalogRelevance,
  usageLimits: usageLimitsRepository,
  workspace: workspaceAdmissionService,
  workspaceCoordinator: workspaceCoordinatorForStorage(storage)
});
