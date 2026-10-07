import type { BrowserPushMessage } from "../../contracts/browserPush";
import type { AdminUsageLimits } from "../../contracts/usageLimits";
import type { SmtpProductMessage } from "../email/definitions";
import type { EmailDispatchResult } from "../email/dispatcher";
import { logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  dueUsageLimitAlerts,
  installationAlertContent,
  USAGE_LIMIT_ALERT_USERS_PER_CHECK,
  usersAlertContent,
  type UsageLimitAlertContent,
  type UsageLimitAlertKey
} from "./alertsPolicy";
import type { UsageLimitAlertClaim, UsageLimitAlertRecipient, UsageLimitAlertStore } from "./alertsRepository";

export type UsageLimitAlertCheckDeps = Readonly<{
  appBaseUrl: string;
  readLimits(now: Date): Promise<AdminUsageLimits>;
  /** Product email; resolves to the dispatch outcome. */
  sendEmail(message: SmtpProductMessage): Promise<EmailDispatchResult>;
  /** Browser push to the user's live devices; resolves to the devices that accepted it. */
  sendPush(userId: string, message: BrowserPushMessage, jobId: string): Promise<number>;
  store: UsageLimitAlertStore;
}>;

export type UsageLimitAlertCheckResult = Readonly<{ delivered: number; undelivered: number }>;

/** Content-free: claim ids, stable codes and counts only. */
function log(fields: Readonly<{
  action?: "retry" | "skip"; code?: string; count?: number; job_id?: string;
  outcome: "completed" | "failed" | "skipped"; prisma_code?: string; stage: "claim" | "dispatch";
}>): void {
  logEvent("job_attempt", { subsystem: "usage_alerts", ...fields });
}

function previousMonthStart(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() - 1, 1));
}

/**
 * One budget alert check for the current UTC month. Each alert is claimed in
 * PostgreSQL before any email or push, so concurrent checks, replicas and
 * restarts send it at most once. An alert that reached no administrator on
 * any channel (SMTP not configured or failing, no push device) is settled
 * `undelivered` and claimed again by a later check, a bounded number of
 * times; one that reached anyone, even partly, is not repeated. A crash
 * between claim and settlement leaves it `claimed`: ambiguous, never resent.
 */
export function createUsageLimitAlertCheck(deps: UsageLimitAlertCheckDeps) {
  /** Sends one alert to every administrator; `true` when anyone received it on any channel. */
  async function deliver(content: UsageLimitAlertContent, recipients: readonly UsageLimitAlertRecipient[], jobId: string): Promise<boolean> {
    let reached = false;
    let emailAvailable = true;
    for (const recipient of recipients) {
      if (recipient.email && emailAvailable) {
        try {
          const result = await deps.sendEmail({ kind: "usage_limit_alert", ...content.email, to: recipient.email });
          // An ambiguous result may have been delivered; resending could duplicate it.
          if (result.kind === "accepted" || result.kind === "ambiguous_after_data") reached = true;
          if (result.kind === "unavailable") emailAvailable = false;
        } catch (error) {
          emailAvailable = false;
          log({ action: "skip", code: "email_repository_failed", job_id: jobId, outcome: "failed",
            prisma_code: databaseFailureCode(error), stage: "dispatch" });
        }
      }
      try {
        if (await deps.sendPush(recipient.userId, content.push, jobId) > 0) reached = true;
      } catch {
        // Browser push is best effort; the sender logs its own failures.
      }
    }
    return reached;
  }

  type Settlement = Readonly<{ reached: boolean; settleError: unknown }>;

  async function deliverAndSettle(
    claims: readonly UsageLimitAlertClaim[],
    content: UsageLimitAlertContent,
    recipients: readonly UsageLimitAlertRecipient[],
    now: Date
  ): Promise<Settlement> {
    const jobId = claims[0]!.id;
    const reached = await deliver(content, recipients, jobId);
    log(reached
      ? { count: claims.length, job_id: jobId, outcome: "completed", stage: "dispatch" }
      : { action: "retry", code: "usage_alert_undelivered", count: claims.length, job_id: jobId, outcome: "skipped", stage: "dispatch" });
    try {
      await deps.store.settle(claims.map((claim) => claim.id), reached ? "delivered" : "undelivered", now);
      return { reached, settleError: null };
    } catch (error) {
      // The rows stay `claimed` and are never resent; the check still sends its other alert.
      return { reached, settleError: error ?? new Error("usage_alert_settle_failed") };
    }
  }

  return async function check(now: Date): Promise<UsageLimitAlertCheckResult> {
    const limits = await deps.readLimits(now);
    const due = dueUsageLimitAlerts(limits);
    // The previous month stays so a check on a lagging clock still finds its claims.
    await deps.store.pruneBefore(previousMonthStart(due.periodStart));
    const keys: UsageLimitAlertKey[] = [
      ...(due.installation ? [{ kind: due.installation.kind, userId: null }] : []),
      ...due.users.map((user) => ({ kind: "user_budget_reached" as const, userId: user.userId }))
    ];
    if (keys.length === 0) return { delivered: 0, undelivered: 0 };
    const contentInput = { appBaseUrl: deps.appBaseUrl, resetsAt: due.resetsAt };
    // Composed before claiming: an unusable base URL fails the check without stranding a claim.
    const installationContent = due.installation ? installationAlertContent(due.installation, contentInput) : null;
    // Recipients are read before claiming, so only delivery and settlement follow a claim.
    const recipients = await deps.store.listRecipients();
    if (recipients.length === 0) return { delivered: 0, undelivered: 0 };
    // The pooled cap key leads, so a full batch of users never pushes it out.
    const claims = await deps.store.claim({ keys, limit: USAGE_LIMIT_ALERT_USERS_PER_CHECK + 1, now, periodStart: due.periodStart });
    if (claims.length === 0) return { delivered: 0, undelivered: 0 };
    log({ count: claims.length, job_id: claims[0]!.id, outcome: "completed", stage: "claim" });

    const settlements: Settlement[] = [];
    const installationClaims = claims.filter((claim) => claim.userId === null);
    if (installationContent && installationClaims.length > 0) {
      settlements.push(await deliverAndSettle(installationClaims, installationContent, recipients, now));
    }
    const userClaims = claims.filter((claim) => claim.kind === "user_budget_reached" && claim.userId !== null);
    const claimedUsers = new Set(userClaims.map((claim) => claim.userId));
    const users = due.users.filter((user) => claimedUsers.has(user.userId));
    if (users.length > 0) {
      settlements.push(await deliverAndSettle(userClaims, usersAlertContent(users, contentInput), recipients, now));
    }
    const failed = settlements.find((settlement) => settlement.settleError !== null);
    if (failed) throw failed.settleError;
    return {
      delivered: settlements.filter((settlement) => settlement.reached).length,
      undelivered: settlements.filter((settlement) => !settlement.reached).length
    };
  };
}

export type UsageLimitAlertCheck = ReturnType<typeof createUsageLimitAlertCheck>;

export type UsageLimitAlertWorkerDeps = Readonly<{
  check(now: Date): Promise<unknown>;
  intervalMs: number;
  /** Random extra delay before each check, so replicas and restarts spread out. */
  jitterMs: number;
  now?: () => Date;
  random?: () => number;
}>;

/**
 * Runs the check every `intervalMs` plus up to `jitterMs`, one at a time,
 * the first within `jitterMs` of `start`. A failed check degrades the
 * `usage_alerts` subsystem and is retried at the next interval.
 */
export function createUsageLimitAlertWorker(deps: UsageLimitAlertWorkerDeps) {
  const clock = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let started = false;
  let stopped = false;

  function jitter(): number {
    return Math.floor(random() * deps.jitterMs);
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = runInBackground(() => setTimeout(() => {
      timer = null;
      void runNow().finally(() => schedule(deps.intervalMs + jitter()));
    }, delayMs));
    timer.unref?.();
  }

  async function runCheck(): Promise<void> {
    try {
      await deps.check(clock());
      reportSubsystemHealthy("usage_alerts", "reconcile");
    } catch (error) {
      reportSubsystemFailure({ subsystem: "usage_alerts", stage: "reconcile", code: "usage_alert_check_failed",
        prisma_code: databaseFailureCode(error), action: "retry" });
    }
  }

  function runNow(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runInBackground(() => runCheck()).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      schedule(jitter());
    },
    /** Runs a check now unless one is in progress (tests). */
    runNow,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    }
  };
}

export type UsageLimitAlertWorker = ReturnType<typeof createUsageLimitAlertWorker>;
