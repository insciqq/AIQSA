import { getAuthConfig, isTestAuthEnabled } from "../auth/config";
import { emailDispatcher } from "../email/defaultEmail";
import { prisma } from "../prisma";
import { getDefaultBrowserPush } from "../push/defaultBrowserPush";
import { createUsageLimitAlertCheck, createUsageLimitAlertWorker, type UsageLimitAlertWorker } from "./alerts";
import { createUsageLimitAlertStore } from "./alertsRepository";
import { usageLimitsRepository } from "./defaultRepository";

const CHECK_INTERVAL_MS = 5 * 60_000;
const CHECK_JITTER_MS = 60_000;
/** Test-auth installations (browser tests with captured email) check every few seconds. */
const TEST_CHECK_INTERVAL_MS = 3_000;

const globalForAlerts = globalThis as unknown as { __aiqsaUsageLimitAlerts?: UsageLimitAlertWorker };

/** One budget alert worker per application process, shared across route bundles. */
export function getDefaultUsageLimitAlertWorker(): UsageLimitAlertWorker {
  if (!globalForAlerts.__aiqsaUsageLimitAlerts) {
    const check = createUsageLimitAlertCheck({
      appBaseUrl: getAuthConfig().appBaseUrl,
      readLimits: (now) => usageLimitsRepository.readAdminUsageLimits(now),
      sendEmail: (message) => emailDispatcher.send(message),
      sendPush: (userId, message, jobId) => getDefaultBrowserPush().sender.sendMessage(userId, message, jobId),
      store: createUsageLimitAlertStore(prisma)
    });
    const testing = isTestAuthEnabled();
    globalForAlerts.__aiqsaUsageLimitAlerts = createUsageLimitAlertWorker({
      check,
      intervalMs: testing ? TEST_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS,
      jitterMs: testing ? 0 : CHECK_JITTER_MS
    });
  }
  return globalForAlerts.__aiqsaUsageLimitAlerts;
}

export function startDefaultUsageLimitAlerts(): void {
  getDefaultUsageLimitAlertWorker().start();
}
