import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { knowledgeToolExecutor } from "../knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "../knowledge/defaultEvidenceDispatch";
import { knowledgeRunAdmissionService } from "../knowledge/runAdmission";
import { defaultMemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { createS3StorageAdapter } from "../uploads/storage";
import { workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { activeRunControllerRegistry } from "./runExecution";
import { createPrismaRunRepository } from "./prismaRepository";
import { reconcileInstallationRuns } from "./runRecovery";
import { RunRecoveryScheduler } from "./recoveryScheduler";

const globalForRecoveryScheduler = globalThis as unknown as {
  __aiqsaRunRecoveryScheduler?: RunRecoveryScheduler;
};

export function getDefaultRunRecoveryScheduler(): RunRecoveryScheduler {
  if (!globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler) {
    const storage = createS3StorageAdapter();
    // The application owns export recovery and orphan settlement, using the
    // same Workspace coordinator as run routes and independent worker slots.
    const deps = {
      knowledgeAdmission: knowledgeRunAdmissionService,
      knowledgeExecutor: knowledgeToolExecutor,
      knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle,
      memoryEgress: defaultMemoryToolEgressReceiptService,
      mcp: defaultMcpRunPlan,
      providerAdmission: providerAdmissionService,
      providerRuntime: providerRuntimeResolver,
      providers: {},
      registry: activeRunControllerRegistry,
      repository: createPrismaRunRepository(),
      storage,
      workspace: workspaceCoordinatorForStorage(storage)
    };
    globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler = new RunRecoveryScheduler({
      reconcile: () => reconcileInstallationRuns(deps),
      recoverWorkspaceExports: async (signal) => {
        await deps.workspace.recoverExports({ limit: 10, signal });
      }
    });
  }
  return globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler;
}

export function startDefaultRunRecoveryScheduler(): void {
  getDefaultRunRecoveryScheduler().start();
}
