import type { TelegramHealthCode } from "../../contracts/telegram";
import { logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { TELEGRAM_ALLOWED_UPDATES } from "./botApi";
import { telegramFailureCode } from "./codes";
import type { TelegramControlRepository } from "./control/repository";
import type { TelegramSessionProvider } from "./control/session";
import type { TelegramBotSession, TelegramDispatcher } from "./dispatcher";
import type { TelegramReceiptStore } from "./store/receipts";
import type { TelegramFailure } from "./transport";

/**
 * The application's one long poll (no webhook): `getUpdates` with a 25 s
 * timeout from the durable offset. A batch is claimed and the offset moved
 * past it in one transaction before any update is handled, so a restart, a
 * second container polling the same database or a redelivered batch never
 * handles an update twice. A conflict (another poller or a webhook) or an
 * unreachable Telegram backs off from 1 s to 60 s; a rejected token stops
 * polling until the token changes. Health is written to the control row.
 */

export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
export const TELEGRAM_POLL_BATCH_LIMIT = 100;
export const TELEGRAM_POLL_BACKOFF_MIN_MS = 1_000;
export const TELEGRAM_POLL_BACKOFF_MAX_MS = 60_000;
/** Successful polls refresh `lastPollAt` at most this often; failures and recoveries are written at once. */
const HEALTH_WRITE_INTERVAL_MS = 30_000;

export type TelegramPollerState = "idle" | "polling" | "backing_off" | "token_rejected";

export type TelegramPoller = Readonly<{
  /** Re-reads the control: polls while the bot is on, stops when it is off; a new token clears a rejection. */
  reevaluate(): void;
  stop(): Promise<void>;
  state(): TelegramPollerState;
}>;

/** Content-free: stages, outcomes, codes, delays and counts only. */
function log(fields: Readonly<{
  action?: "retry" | "stop"; code?: string; count?: number; delay_ms?: number; error?: unknown; httpStatus?: number;
  outcome: "completed" | "degraded" | "failed" | "skipped" | "waiting"; prisma_code?: string; stage: "claim" | "reconcile";
}>): void {
  logEvent("service_operation", { subsystem: "telegram", ...fields });
}

/** 409: another poller or a webhook holds the bot; 401/404: the token no longer works; else Telegram is unreachable. */
export function telegramPollFailureCode(failure: TelegramFailure): TelegramHealthCode {
  if (failure.kind === "telegram" && failure.errorCode === 409) return "telegram_poll_conflict";
  if (failure.kind === "telegram" && (failure.errorCode === 401 || failure.errorCode === 404)) return "telegram_token_rejected";
  return "telegram_unreachable";
}

export function createTelegramPoller(deps: Readonly<{
  dispatcher: Pick<TelegramDispatcher, "dispatch">;
  health: Pick<TelegramControlRepository, "recordPollHealth">;
  receipts: Pick<TelegramReceiptStore, "claimBatch" | "readOffset">;
  sessions: TelegramSessionProvider;
  now?: () => number;
  /** Waits between failed polls; `wake` cuts the wait short. */
  sleep?: (ms: number, wake: AbortSignal) => Promise<void>;
}>): TelegramPoller {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number, wake: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    wake.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      wake.removeEventListener("abort", done);
      resolve();
    }
  }));
  let loop: Promise<void> | null = null;
  let requested = false;
  let stopped = false;
  let state: TelegramPollerState = "idle";
  let rejectedGeneration: string | null = null;
  let waking = new AbortController();
  let lastHealth: Readonly<{ at: number; code: TelegramHealthCode | null; key: string }> | null = null;
  let failing = false;
  // Halved while a backlog's response exceeds the transport bound, so oversized batches drain instead of repeating.
  let batchLimit = TELEGRAM_POLL_BATCH_LIMIT;

  const generationKey = (session: TelegramBotSession) => `${session.botId}:${session.generation}`;

  async function recordHealth(session: TelegramBotSession, code: TelegramHealthCode | null): Promise<void> {
    const at = now();
    const key = generationKey(session);
    const same = lastHealth && lastHealth.key === key && lastHealth.code === code;
    if (same && code === null && at - lastHealth!.at < HEALTH_WRITE_INTERVAL_MS) return;
    lastHealth = { at, code, key };
    try {
      await deps.health.recordPollHealth({ at: new Date(at), botId: session.botId, failureCode: code, success: code === null });
    } catch (error) {
      log({ code: "telegram_health_write_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "reconcile" });
    }
  }

  async function backOff(delay: number): Promise<number> {
    const next = delay === 0 ? TELEGRAM_POLL_BACKOFF_MIN_MS : Math.min(delay * 2, TELEGRAM_POLL_BACKOFF_MAX_MS);
    state = "backing_off";
    await sleep(next, waking.signal);
    return next;
  }

  async function run(): Promise<void> {
    let delay = 0;
    while (!stopped) {
      requested = false;
      let session: TelegramBotSession | null;
      try {
        session = await deps.sessions.current();
      } catch (error) {
        log({ action: "retry", code: "telegram_control_unavailable", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "reconcile" });
        delay = await backOff(delay);
        continue;
      }
      if (!session) {
        state = "idle";
        return;
      }
      if (rejectedGeneration === generationKey(session)) {
        state = "token_rejected";
        return;
      }
      state = "polling";
      let offset: number | null;
      try {
        offset = await deps.receipts.readOffset(session.botId);
      } catch (error) {
        log({ action: "retry", code: "telegram_update_claim_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "claim" });
        delay = await backOff(delay);
        continue;
      }
      const outcome = await session.api.getUpdates({
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
        limit: batchLimit,
        timeoutSeconds: TELEGRAM_POLL_TIMEOUT_SECONDS,
        ...(offset === null ? {} : { offset })
      });
      if (stopped) return;
      // The bot changed or went off during the poll: the batch stays unclaimed and unconfirmed.
      const current = await deps.sessions.current().catch(() => null);
      if (!current || generationKey(current) !== generationKey(session)) continue;
      if (!outcome.ok && outcome.kind === "too_large" && batchLimit > 1) {
        batchLimit = Math.max(1, Math.floor(batchLimit / 2));
        log({ action: "retry", code: telegramFailureCode(outcome.kind, outcome.errorCode), count: batchLimit, outcome: "degraded", stage: "reconcile" });
        continue;
      }
      if (!outcome.ok) {
        const code = telegramPollFailureCode(outcome);
        const action = code === "telegram_token_rejected" ? "stop" : "retry";
        log({ action, code: telegramFailureCode(outcome.kind, outcome.errorCode), httpStatus: outcome.status, outcome: "failed", stage: "reconcile" });
        reportSubsystemFailure({ action, code, httpStatus: outcome.status, stage: "reconcile", subsystem: "telegram" });
        failing = true;
        await recordHealth(session, code);
        if (code === "telegram_token_rejected") {
          rejectedGeneration = generationKey(session);
          state = "token_rejected";
          return;
        }
        delay = await backOff(delay);
        continue;
      }
      if (failing) reportSubsystemHealthy("telegram", "reconcile");
      failing = false;
      delay = 0;
      batchLimit = Math.min(TELEGRAM_POLL_BATCH_LIMIT, batchLimit * 2);
      await recordHealth(session, null);
      const updates = outcome.result;
      if (updates.length === 0) continue;
      const nextOffset = Math.max(...updates.map((update) => update.update_id)) + 1;
      let claimed: ReadonlySet<number>;
      try {
        claimed = await deps.receipts.claimBatch({
          botId: session.botId, nextOffset, updates: updates.map((update) => ({ kind: update.kind, updateId: update.update_id }))
        });
      } catch (error) {
        // Nothing was claimed or confirmed: the next poll returns the same batch.
        log({ action: "retry", code: "telegram_update_claim_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "claim" });
        delay = await backOff(delay);
        continue;
      }
      if (claimed.size < updates.length) log({ count: updates.length - claimed.size, outcome: "skipped", stage: "claim" });
      for (const update of updates) {
        if (claimed.has(update.update_id)) deps.dispatcher.dispatch(update, session);
      }
    }
  }

  function start(): void {
    if (loop || stopped) return;
    loop = runInBackground(() => run())
      .catch((error: unknown) => {
        log({ code: "telegram_poll_failed", error, outcome: "failed", stage: "reconcile" });
      })
      .finally(() => {
        loop = null;
        if (requested && !stopped) start();
      });
  }

  return Object.freeze({
    reevaluate() {
      requested = true;
      // An administrator's change (a new token, switching the bot on) earns a rejected token one more try.
      rejectedGeneration = null;
      waking.abort();
      waking = new AbortController();
      start();
    },
    async stop() {
      stopped = true;
      waking.abort();
      await loop;
      state = "idle";
    },
    state: () => state
  });
}
