import { defaultAssistantRepository } from "@/lib/server/assistants/defaultAssistants";
import { getAuthConfig } from "@/lib/server/auth/config";
import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultMcpRunPlan } from "@/lib/server/mcp/defaultRuntime";
import { knowledgeRunAdmissionService } from "@/lib/server/knowledge/runAdmission";
import { knowledgeToolExecutor } from "@/lib/server/knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "@/lib/server/knowledge/defaultEvidenceDispatch";
import { defaultMemoryToolEgressReceiptService } from "@/lib/server/memory/egress/receipts";
import { providerAdmissionService } from "@/lib/server/providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { createRegenerateModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { installationToolBudgetPolicy } from "@/lib/server/runs/toolBudgets";
import { defaultSkillRepository } from "@/lib/server/skills/defaultSkills";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const POST = createRegenerateModelRunHandler({
  allowFakeProvider: isTestModeAllowedEnv(process.env),
  assistants: defaultAssistantRepository,
  getConfig: () => getAuthConfig(),
  knowledgeAdmission: knowledgeRunAdmissionService,
  knowledgeExecutor: knowledgeToolExecutor,
  knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle,
  memoryEgress: defaultMemoryToolEgressReceiptService,
  mcp: defaultMcpRunPlan,
  providerAdmission: providerAdmissionService,
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  runPolicy: installationToolBudgetPolicy,
  skills: defaultSkillRepository,
  storage: createS3StorageAdapter()
});
