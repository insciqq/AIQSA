import { artifactServiceForStorage } from "../artifacts/defaultArtifacts";
import { imageGenerationForStorage } from "../images/defaultImages";
import { knowledgeProviderDispatchLifecycle } from "../knowledge/defaultEvidenceDispatch";
import { knowledgeToolExecutor } from "../knowledge/defaultRetrieval";
import { knowledgeRunAdmissionService } from "../knowledge/runAdmission";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { defaultMemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { admitMemorySearch } from "../memory/search/admission";
import { createPrismaMemorySearchService } from "../memory/search/runtime";
import { prisma } from "../prisma";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { defaultSkillTools } from "../skills/defaultSkillTools";
import type { StorageAdapter } from "../uploads/storage";
import { visionAnalysisForStorage } from "../vision/defaultVision";

/**
 * The tool services and dispatch policies of every entry point that executes
 * or recovers a run: run routes, PDF and Workspace continuations and the
 * background recovery scheduler. A run's outcome must not depend on which of
 * them picks it up. Construction opens no provider connection; each service
 * revalidates the run's accepted binding before its own dispatch.
 */
export function defaultRunServices(storage: StorageAdapter) {
  return {
    artifacts: artifactServiceForStorage(storage),
    images: imageGenerationForStorage(storage),
    knowledgeAdmission: knowledgeRunAdmissionService,
    knowledgeExecutor: knowledgeToolExecutor,
    knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle,
    memoryEgress: defaultMemoryToolEgressReceiptService,
    memorySearch: createPrismaMemorySearchService(),
    memorySearchAdmission: { async admit(userId: string, assistantId?: string | null) {
      const policy = await prisma.modelPolicy.findUniqueOrThrow({
        where: { id: "installation" }, select: { memorySearchTimeoutSeconds: true }
      });
      return admitMemorySearch({ userId, assistantId, timeoutSeconds: Number(policy.memorySearchTimeoutSeconds) });
    } },
    mcp: defaultMcpRunPlan,
    providerAdmission: providerAdmissionService,
    providerRuntime: providerRuntimeResolver,
    skillTools: defaultSkillTools,
    storage,
    vision: visionAnalysisForStorage(storage)
  };
}
