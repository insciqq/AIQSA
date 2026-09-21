import { imageGenerationForStorage } from "../images/defaultImages";
import { artifactServiceForStorage } from "../artifacts/defaultArtifacts";
import { defaultSkillTools } from "../skills/defaultSkillTools";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { knowledgeRunAdmissionService } from "../knowledge/runAdmission";
import { knowledgeToolExecutor } from "../knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "../knowledge/defaultEvidenceDispatch";
import { defaultMemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { prisma } from "../prisma";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { createPrismaChatTitleGenerator } from "../chats/titleGeneration";
import { getDefaultChatPdf } from "../uploads/defaultChatPdf";
import { createS3StorageAdapter } from "../uploads/storage";
import { createPrismaRunRepository } from "./prismaRepository";
import { serializeRunOutcome } from "./runOutcome";
import { activeRunControllerRegistry } from "./activeRunControllerRegistry";
import { createWorkspaceFollowupRepository } from "./workspaceFollowupPersistence";
import { createWorkspaceFollowupCoordinator } from "./workspaceFollowupCoordinator";
import { createWorkspaceFollowupContinuation, createWorkspaceFollowupFailure } from "./workspaceFollowupContinuation";

function createDefaultWorkspaceFollowup() {
  const repository = createPrismaRunRepository();
  const followups = createWorkspaceFollowupRepository(prisma);
  const storage = createS3StorageAdapter();
  const workspace = workspaceCoordinatorForStorage(storage);
  const coordinator = createWorkspaceFollowupCoordinator({
    registry: activeRunControllerRegistry, repository: followups,
    continueRun: createWorkspaceFollowupContinuation({
      images: imageGenerationForStorage(storage), chatTitleGenerator: createPrismaChatTitleGenerator(),
      artifacts: artifactServiceForStorage(storage),
      skillTools: defaultSkillTools,
      knowledgeAdmission: knowledgeRunAdmissionService, knowledgeExecutor: knowledgeToolExecutor,
      knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle, memoryEgress: defaultMemoryToolEgressReceiptService,
      mcp: defaultMcpRunPlan, providerAdmission: providerAdmissionService, providerRuntime: providerRuntimeResolver,
      repository, storage, workspace, followups, kickPdf: () => getDefaultChatPdf().kick()
    }),
    fail: createWorkspaceFollowupFailure({ repository, workspace })
  });
  return { kick: coordinator.kick, async findAdmission(admissionKey: string, userId: string) {
    const job = await prisma.workspaceFollowup.findUnique({ where: { admissionKey },
      select: { modelRun: { select: { id: true, userId: true, userMessageId: true, assistantMessageId: true } } } });
    if (!job || job.modelRun.userId !== userId || !job.modelRun.assistantMessageId) return null;
    const outcome = await repository.getRunOutcomeForUser(job.modelRun.id, userId);
    return outcome ? { assistantMessageId: job.modelRun.assistantMessageId,
      userMessageId: job.modelRun.userMessageId, ...serializeRunOutcome(outcome) } : null;
  } };
}

const globalForFollowup = globalThis as unknown as { __aiqsaWorkspaceFollowup?: ReturnType<typeof createDefaultWorkspaceFollowup> };
export function getDefaultWorkspaceFollowup() {
  return globalForFollowup.__aiqsaWorkspaceFollowup ??= createDefaultWorkspaceFollowup();
}
