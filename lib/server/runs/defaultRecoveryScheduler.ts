import { defaultWorkspaceCheckpoints } from "../workspace/checkpoints";
import { getDefaultChatPdf } from "../uploads/defaultChatPdf";
import { getDefaultWorkspaceFollowup } from "./defaultWorkspaceFollowup";
import { createS3StorageAdapter } from "../uploads/storage";
import { workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { defaultRunServices } from "./defaultRunServices";
import { activeRunControllerRegistry } from "./runExecution";
import { createPrismaRunRepository } from "./prismaRepository";
import { reconcileInstallationRuns } from "./runRecovery";
import { RunRecoveryScheduler } from "./recoveryScheduler";
import { createPrismaChatTitleWorker } from "../chats/titleGenerationWorker";

const globalForRecoveryScheduler = globalThis as unknown as {
  __aiqsaRunRecoveryScheduler?: RunRecoveryScheduler;
};

export function getDefaultRunRecoveryScheduler(): RunRecoveryScheduler {
  if (!globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler) {
    const storage = createS3StorageAdapter();
    const titles = createPrismaChatTitleWorker();
    // The application owns export recovery and orphan settlement, using the
    // same Workspace coordinator as run routes and independent worker slots.
    // Recovery composes the same tool services as the run routes: a run left
    // to this scheduler keeps its image, artifact and Skill tools.
    const deps = {
      ...defaultRunServices(storage),
      providers: {},
      registry: activeRunControllerRegistry,
      repository: createPrismaRunRepository(),
      workspace: workspaceCoordinatorForStorage(storage)
    };
    globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler = new RunRecoveryScheduler({
      recoverChatTitles: (signal) => titles.reconcile(signal),
      reconcile: async () => {
        getDefaultChatPdf().kick();
        getDefaultWorkspaceFollowup().kick();
        await reconcileInstallationRuns(deps);
      },
      recoverWorkspaceExports: async (signal) => {
        await (await defaultWorkspaceCheckpoints()).recover(signal);
        await deps.workspace.recoverExports({ limit: 10, signal });
      }
    });
  }
  return globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler;
}

export function startDefaultRunRecoveryScheduler(): void {
  getDefaultRunRecoveryScheduler().start();
}
