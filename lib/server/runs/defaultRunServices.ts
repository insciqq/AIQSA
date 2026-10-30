import { createMcpGuardService } from "../mcp/guard";
import { artifactServiceForStorage } from "../artifacts/defaultArtifacts";
import { imageGenerationForStorage } from "../images/defaultImages";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { admitMemorySearch } from "../memory/search/admission";
import { createPrismaMemorySearchService } from "../memory/search/runtime";
import { prisma } from "../prisma";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { defaultSkillTools } from "../skills/defaultSkillTools";
import type { StorageAdapter } from "../uploads/storage";
import { visionAnalysisForStorage } from "../vision/defaultVision";
import { currentUserConnectionLabels, resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import type { SubagentModelCatalogSource } from "../engine/subagents/modelCatalog";

const loadCatalogData = createPrismaCatalogDataLoader({ checkDefaultAssistant: false, prisma });

/** The user's chat models as `/api/me/catalog` filters them, with their connections' labels: what admission freezes for sub-agents. */
async function subagentModelCatalog(userId: string): Promise<SubagentModelCatalogSource> {
  const data = await loadCatalogData(userId);
  if (!data) return { connectionLabels: new Map(), models: [] };
  const models = resolveCurrentUserCatalogSelection(data).models;
  return { connectionLabels: currentUserConnectionLabels(data.models, models), models };
}

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
    memorySearch: createPrismaMemorySearchService(),
    memorySearchAdmission: { async admit(userId: string, assistantId?: string | null) {
      const policy = await prisma.modelPolicy.findUniqueOrThrow({
        where: { id: "installation" }, select: { memorySearchTimeoutSeconds: true }
      });
      return admitMemorySearch({ userId, assistantId, timeoutSeconds: Number(policy.memorySearchTimeoutSeconds) });
    } },
    mcp: defaultMcpRunPlan,
    mcpGuard: createMcpGuardService(prisma),
    providerAdmission: providerAdmissionService,
    providerRuntime: providerRuntimeResolver,
    skillTools: defaultSkillTools,
    storage,
    subagentModels: subagentModelCatalog,
    vision: visionAnalysisForStorage(storage)
  };
}
