import { getAuthConfig } from "../auth/config";
import { emailDispatcher } from "../email/defaultEmail";
import { runInBackground } from "../observability";
import { prisma } from "../prisma";
import { getDefaultBrowserPush } from "../push/defaultBrowserPush";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { stopModelRun } from "../runs/handlers";
import { RunRecoveryScheduler } from "../runs/recoveryScheduler";
import { createS3StorageAdapter } from "../uploads/storage";
import { getScheduledWorkspaceMaxConcurrent } from "../workspace/config";
import { workspaceRuntime } from "../workspace/defaultServices";
import { createPrismaScheduledTaskOwnerLoader, createScheduledTaskSend } from "./admission";
import { createPrismaScheduledTaskRunCatalogLoader } from "./catalog";
import { createPrismaScheduledTaskHistoryRetention, type ScheduledTaskHistoryRetention } from "./historyRetention";
import { createPrismaScheduledTaskPinnedSkillLoader } from "./pinnedSkills";
import { createScheduledTaskRunner } from "./runner";
import { registerScheduledTaskRunnerKick } from "./runnerKick";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { createPrismaScheduledWorkspaceCarryover } from "./workspaceCarryover";

const TICK_INTERVAL_MS = 30_000;
const globalForRunner = globalThis as unknown as { __aiqsaScheduledTaskRunner?: RunRecoveryScheduler };

/**
 * History retention deletes through the owner's permanent deletion service,
 * loaded on the first sweep so the runner starts without it.
 */
function defaultHistoryRetention(): ScheduledTaskHistoryRetention {
  let retention: Promise<ScheduledTaskHistoryRetention> | null = null;
  return async (now, limit) => {
    retention ??= import("../chats/permanentDeletion/default").then(({
      defaultPermanentChatDeletionService, permanentChatDeletionCapability
    }) => createPrismaScheduledTaskHistoryRetention({
      deletion: { capability: permanentChatDeletionCapability, service: defaultPermanentChatDeletionService }, prisma
    })).catch((error: unknown) => {
      retention = null;
      throw error;
    });
    return (await retention)(now, limit);
  };
}

/** One runner per application process (single replica), shared across route bundles. */
export function getDefaultScheduledTaskRunner(): RunRecoveryScheduler {
  if (!globalForRunner.__aiqsaScheduledTaskRunner) {
    const kick = () => globalForRunner.__aiqsaScheduledTaskRunner?.kick();
    const sendDeps = createDefaultSendMessageDeps();
    const runner = createScheduledTaskRunner({
      appBaseUrl: getAuthConfig().appBaseUrl,
      background: (work) => runInBackground(work),
      carryWorkspace: createPrismaScheduledWorkspaceCarryover({ prisma, runtime: workspaceRuntime, storage: createS3StorageAdapter() }),
      kick,
      loadCatalog: createPrismaScheduledTaskRunCatalogLoader(prisma),
      loadPinnedSkills: createPrismaScheduledTaskPinnedSkillLoader(prisma),
      retainHistory: defaultHistoryRetention(),
      send: createScheduledTaskSend({ loadOwner: createPrismaScheduledTaskOwnerLoader(prisma), sendDeps }),
      sendEmail: (message) => emailDispatcher.send(message),
      sendPush: (occurrenceId) => getDefaultBrowserPush().sender.notifyOccurrence(occurrenceId),
      // The run deadline uses the chat's own Stop path in this process, where the runs execute.
      stopRun: ({ code, message, runId, userId }) => stopModelRun(sendDeps, { payload: { code, message }, runId, userId }),
      store: createPrismaScheduledTaskRunnerStore(prisma),
      workspaceMaxConcurrent: getScheduledWorkspaceMaxConcurrent()
    });
    globalForRunner.__aiqsaScheduledTaskRunner = new RunRecoveryScheduler({
      intervalMs: TICK_INTERVAL_MS,
      reconcile: () => runner.tick(),
      subsystem: "scheduled_tasks"
    });
    registerScheduledTaskRunnerKick(kick);
  }
  return globalForRunner.__aiqsaScheduledTaskRunner;
}

export function startDefaultScheduledTaskRunner(): void {
  getDefaultScheduledTaskRunner().start();
}
