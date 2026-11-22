import { createMcpGuardService } from "../mcp/guard";
import { artifactServiceForStorage } from "../artifacts/defaultArtifacts";
import { getComputerOps } from "../connect/computerPort";
import { isConnectEnabled } from "../connect/policy";
import { imageGenerationForStorage } from "../images/defaultImages";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { loadMemoryNoteForRun } from "../memoryNote/runContext";
import { prisma } from "../prisma";
import { createProxyRunPlanner } from "../proxies/store";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { defaultSkillTools } from "../skills/defaultSkillTools";
import type { StorageAdapter } from "../uploads/storage";
import { createPrismaPastChatTools } from "../tools/pastChats";
import { visionAnalysisForStorage } from "../vision/defaultVision";
import { currentUserConnectionLabels, resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import type { SubagentModelCatalogSource } from "../engine/subagents/modelCatalog";
import { readSubagentDefault } from "../subagents/definitionStore";

const loadCatalogData = createPrismaCatalogDataLoader({ checkDefaultAssistant: false, prisma });

/**
 * The user's Memory as a run's admission reads it: the switches and the note (`loadMemoryNoteForRun`), and whether the
 * chat's Assistant, when it has one, is the user's own, the one Assistant chat past-chat search is offered in, as
 * `memory_search` was.
 */
async function loadRunMemory(input: Readonly<{ userId: string; assistantId: string | null }>) {
  const [memory, ownAssistant] = await Promise.all([
    loadMemoryNoteForRun(prisma, input.userId),
    input.assistantId ? prisma.assistantDefinition.findFirst({ select: { id: true },
      where: { archivedAt: null, id: input.assistantId, ownerUserId: input.userId } }) : Promise.resolve(null)
  ]);
  return { ...memory, searchAllowed: input.assistantId === null || ownAssistant !== null };
}

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
    // The port is read at each admission: the Connect relay installs its implementation when it starts.
    computerAdmission: { describe: (userId: string, deviceId: string) => getComputerOps().describe(userId, deviceId),
      enabled: isConnectEnabled },
    images: imageGenerationForStorage(storage),
    memoryNote: { load: loadRunMemory },
    mcp: defaultMcpRunPlan,
    pastChats: createPrismaPastChatTools(prisma),
    mcpGuard: createMcpGuardService(prisma),
    proxies: createProxyRunPlanner(prisma),
    providerAdmission: providerAdmissionService,
    providerRuntime: providerRuntimeResolver,
    skillTools: defaultSkillTools,
    storage,
    subagentDefault: (userId: string) => readSubagentDefault(prisma, userId),
    subagentModels: subagentModelCatalog,
    vision: visionAnalysisForStorage(storage)
  };
}
