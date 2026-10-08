import { runInBackground } from "../observability";
import { prisma } from "../prisma";
import { getDefaultBrowserPush } from "../push/defaultBrowserPush";
import { registerRunSettledListener } from "../push/runTerminalSignal";
import { stopModelRun } from "../runs/handlers";
import { RunRecoveryScheduler } from "../runs/recoveryScheduler";
import { answerReviewOwnerAuth, createAnswerReviewDriver, type AnswerReviewDriver } from "./autoDriver";
import { defaultAnswerReviewSendDeps } from "./defaultAnswerReviewSteps";

const TICK_INTERVAL_MS = 10_000;
const globalForDriver = globalThis as unknown as {
  __aiqsaAnswerReviewDriver?: Readonly<{ driver: AnswerReviewDriver; scheduler: RunRecoveryScheduler }>;
};

/** One driver per application process (single replica), shared across route bundles. */
export function getDefaultAnswerReviewDriver(): AnswerReviewDriver {
  if (!globalForDriver.__aiqsaAnswerReviewDriver) {
    const sendDeps = defaultAnswerReviewSendDeps();
    const driver = createAnswerReviewDriver({
      background: (work) => runInBackground(work),
      notifyEnded: (event) => getDefaultBrowserPush().sender.notifyAnswerReview(event),
      ownerAuth: (userId) => answerReviewOwnerAuth(prisma, userId),
      prisma,
      steps: () => ({ prisma, sendDeps }),
      // A step stops through the chat's own Stop path in this process, where it executes.
      stopRun: ({ code, message, runId, userId }) => stopModelRun(sendDeps, { payload: { code, message }, runId, userId })
    });
    const scheduler = new RunRecoveryScheduler({
      intervalMs: TICK_INTERVAL_MS,
      reconcile: () => driver.tick(),
      subsystem: "answer_review"
    });
    globalForDriver.__aiqsaAnswerReviewDriver = { driver, scheduler };
  }
  return globalForDriver.__aiqsaAnswerReviewDriver.driver;
}

/** Starts the reconciler and connects committed run terminals to the driver. */
export function startDefaultAnswerReviewDriver(): void {
  const driver = getDefaultAnswerReviewDriver();
  registerRunSettledListener((runId) => {
    void driver.onRunSettled(runId).catch(() => undefined);
  });
  globalForDriver.__aiqsaAnswerReviewDriver!.scheduler.start();
}
