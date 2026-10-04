import { getAuthConfig } from "../auth/config";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { emailDispatcher } from "../email/defaultEmail";
import { runInBackground } from "../observability";
import { prisma } from "../prisma";
import { getDefaultBrowserPush } from "../push/defaultBrowserPush";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { RunRecoveryScheduler } from "../runs/recoveryScheduler";
import { createPrismaScheduledTaskOwnerLoader, createScheduledTaskSend } from "./admission";
import { createPrismaScheduledTaskRunCatalogLoader } from "./catalog";
import { createScheduledTaskRunner } from "./runner";
import { registerScheduledTaskRunnerKick } from "./runnerKick";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";

const TICK_INTERVAL_MS = 30_000;
const globalForRunner = globalThis as unknown as { __aiqsaScheduledTaskRunner?: RunRecoveryScheduler };

/** One runner per application process (single replica), shared across route bundles. */
export function getDefaultScheduledTaskRunner(): RunRecoveryScheduler {
  if (!globalForRunner.__aiqsaScheduledTaskRunner) {
    const chats = createPrismaChatRepository();
    const kick = () => globalForRunner.__aiqsaScheduledTaskRunner?.kick();
    const runner = createScheduledTaskRunner({
      appBaseUrl: getAuthConfig().appBaseUrl,
      background: (work) => runInBackground(work),
      kick,
      loadCatalog: createPrismaScheduledTaskRunCatalogLoader(prisma),
      async renameChat(input) { await chats.updateChat(input); },
      send: createScheduledTaskSend({
        loadOwner: createPrismaScheduledTaskOwnerLoader(prisma),
        sendDeps: createDefaultSendMessageDeps()
      }),
      sendEmail: (message) => emailDispatcher.send(message),
      sendPush: (occurrenceId) => getDefaultBrowserPush().sender.notifyOccurrence(occurrenceId),
      store: createPrismaScheduledTaskRunnerStore(prisma)
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
