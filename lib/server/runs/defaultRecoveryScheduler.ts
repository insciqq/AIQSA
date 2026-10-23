import { defaultWorkspaceCheckpoints } from "../workspace/checkpoints";
import { getDefaultChatPdf } from "../uploads/defaultChatPdf";
import { getDefaultWorkspaceFollowup } from "./defaultWorkspaceFollowup";
import { createS3StorageAdapter } from "../uploads/storage";
import { workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { createPrismaRunRepository } from "./prismaRepository";
import { RunRecoveryScheduler } from "./recoveryScheduler";
import { createRetiredEngineRunSweep } from "./retiredEngineRuns";
import { createPrismaChatTitleWorker } from "../chats/titleGenerationWorker";
import { defaultNativeRecoveryDeps } from "../engine/defaultEngine";
import { reconcileNativeRuns } from "../engine/recovery";
import { prisma } from "../prisma";

const globalForRecoveryScheduler = globalThis as unknown as {
  __aiqsaRunRecoveryScheduler?: RunRecoveryScheduler;
};

export function getDefaultRunRecoveryScheduler(): RunRecoveryScheduler {
  if (!globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler) {
    const storage = createS3StorageAdapter();
    const titles = createPrismaChatTitleWorker();
    // The application owns export recovery and orphan settlement, using the
    // same Workspace coordinator as run routes and independent worker slots.
    const repository = createPrismaRunRepository();
    const workspace = workspaceCoordinatorForStorage(storage);
    const native = defaultNativeRecoveryDeps({ repository, workspace });
    // The old core's runs still active after the upgrade end first, so their
    // document and Workspace jobs never wait for an engine that is gone.
    const retired = createRetiredEngineRunSweep({ client: prisma, repository, workspace });
    globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler = new RunRecoveryScheduler({
      recoverChatTitles: (signal) => titles.reconcile(signal),
      reconcile: async () => {
        try {
          await retired();
        } finally {
          getDefaultChatPdf().kick();
          getDefaultWorkspaceFollowup().kick();
          await reconcileNativeRuns(native);
        }
      },
      recoverWorkspaceExports: async (signal) => {
        await (await defaultWorkspaceCheckpoints()).recover(signal);
        await workspace.recoverExports({ limit: 10, signal });
      }
    });
  }
  return globalForRecoveryScheduler.__aiqsaRunRecoveryScheduler;
}

/**
 * Starts recovery at startup: runs the old core left active end once, and the
 * agent engine's runs this process does not own end interrupted
 * (`reconcileNativeRuns`), on every pass.
 */
export function startDefaultRunRecoveryScheduler(): void {
  getDefaultRunRecoveryScheduler().start();
}
