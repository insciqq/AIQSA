import { randomUUID } from "node:crypto";
import type { BrowserPushMessage } from "@/lib/contracts/browserPush";
import { logEvent } from "../observability";
import { getDefaultBrowserPush } from "../push/defaultBrowserPush";
import { connectPushMessage } from "../push/payload";
import { getConnectRelay, type ConnectRelay, type ConnectRelayEvent } from "./relay";

/** At most one notice per session in this interval. */
export const CONNECT_PUSH_INTERVAL_MS = 15_000;
/**
 * At most this many notices per account in the window, whatever session ids its devices report: a
 * device chooses its session ids, so the per-session interval alone does not bound what it sends.
 */
export const CONNECT_PUSH_ACCOUNT_LIMIT = 6;
export const CONNECT_PUSH_ACCOUNT_WINDOW_MS = 60_000;
/** Sends in flight across the process; more wait in a short queue, and any beyond it are dropped. */
export const CONNECT_PUSH_MAX_IN_FLIGHT = 8;
export const CONNECT_PUSH_MAX_QUEUED = 32;
/** Sessions whose last notice the process remembers; older ones are past the interval or forgotten first. */
const REMEMBERED_SESSIONS = 4_096;
/** Accounts whose recent notices the process remembers; the least recent is forgotten first. */
const REMEMBERED_ACCOUNTS = 4_096;

export type ConnectPushDeps = Readonly<{
  jobId?: () => string;
  now?: () => number;
  relay: Pick<ConnectRelay, "isSessionVisible" | "onEvent">;
  /** Sends now and resolves to the devices that accepted it (`BrowserPushSender.sendMessage`). */
  send: (userId: string, message: BrowserPushMessage, jobId: string) => Promise<number>;
}>;

export type ConnectPush = Readonly<{
  /** Resolves when every notice started so far has settled (tests and shutdown). */
  idle(): Promise<void>;
  stop(): void;
}>;

/**
 * Tells the owner when an agent in an AIQSA Connect session needs them: a
 * session entering `needs_approval` or `waiting` from another status sends
 * one content-free Web Push, unless the owner has that session open and
 * visible, at most once per session every 15 seconds and at most 6 times
 * per account a minute. At most 8 notices are sent at once, 32 more wait
 * and the rest are dropped. Each notice is sent once (never retried); the
 * sender applies the account's browser notification setting.
 */
export function createConnectPush(deps: ConnectPushDeps): ConnectPush {
  const now = deps.now ?? Date.now;
  const jobId = deps.jobId ?? randomUUID;
  const lastSent = new Map<string, number>();
  const accounts = new Map<string, { refusalLoggedAt: number | null; sentAt: number[] }>();
  const inFlight = new Set<Promise<void>>();
  const queued: Array<() => Promise<void>> = [];
  let running = 0;

  function remember(key: string, at: number): void {
    lastSent.delete(key);
    if (lastSent.size >= REMEMBERED_SESSIONS) {
      for (const [other, sentAt] of lastSent) {
        if (at - sentAt >= CONNECT_PUSH_INTERVAL_MS) lastSent.delete(other);
      }
    }
    if (lastSent.size >= REMEMBERED_SESSIONS) lastSent.delete(lastSent.keys().next().value!);
    lastSent.set(key, at);
  }

  /** Spends one of the account's notices in the window; false, logged at most once a window, when none is left. */
  function spendAccountNotice(userId: string, at: number): boolean {
    const account = accounts.get(userId) ?? { refusalLoggedAt: null, sentAt: [] };
    account.sentAt = account.sentAt.filter((sentAt) => at - sentAt < CONNECT_PUSH_ACCOUNT_WINDOW_MS);
    accounts.delete(userId);
    if (accounts.size >= REMEMBERED_ACCOUNTS) accounts.delete(accounts.keys().next().value!);
    accounts.set(userId, account);
    if (account.sentAt.length >= CONNECT_PUSH_ACCOUNT_LIMIT) {
      if (account.refusalLoggedAt === null || at - account.refusalLoggedAt >= CONNECT_PUSH_ACCOUNT_WINDOW_MS) {
        account.refusalLoggedAt = at;
        logEvent("job_attempt", { action: "skip", code: "push_rate_limited", outcome: "skipped", stage: "claim", subsystem: "push" });
      }
      return false;
    }
    account.sentAt.push(at);
    return true;
  }

  function run(task: () => Promise<void>): void {
    running += 1;
    const work: Promise<void> = task().finally(() => {
      running -= 1;
      inFlight.delete(work);
      const next = queued.shift();
      if (next) run(next);
    });
    inFlight.add(work);
  }

  function dispatch(task: () => Promise<void>, id: string): void {
    if (running < CONNECT_PUSH_MAX_IN_FLIGHT) {
      run(task);
    } else if (queued.length < CONNECT_PUSH_MAX_QUEUED) {
      queued.push(task);
    } else {
      logEvent("job_attempt", { action: "skip", code: "push_queue_full", job_id: id, outcome: "skipped", stage: "claim", subsystem: "push" });
    }
  }

  function handle(event: ConnectRelayEvent): void {
    if (event.type !== "status") return;
    const { deviceId, sessionId, status, userId } = event;
    if ((status !== "needs_approval" && status !== "waiting") || event.previousStatus === status) return;
    const at = now();
    if (deps.relay.isSessionVisible(userId, deviceId, sessionId, at)) return;
    const key = JSON.stringify([userId, deviceId, sessionId]);
    const last = lastSent.get(key);
    if (last !== undefined && at - last < CONNECT_PUSH_INTERVAL_MS) return;
    if (!spendAccountNotice(userId, at)) return;
    remember(key, at);
    const id = jobId();
    const message = connectPushMessage({ deviceId, sessionId, sessionTitle: event.title, status });
    dispatch(() => Promise.resolve()
      .then(() => deps.send(userId, message, id))
      .then(() => undefined, (error: unknown) => {
        logEvent("job_attempt", { action: "skip", code: "push_delivery_failed", error, job_id: id, outcome: "failed", stage: "dispatch", subsystem: "push" });
      }), id);
  }

  const unsubscribe = deps.relay.onEvent(handle);
  return {
    async idle() {
      while (inFlight.size > 0 || queued.length > 0) await Promise.all([...inFlight]);
    },
    stop() {
      unsubscribe();
    }
  };
}

const globalForConnectPush = globalThis as typeof globalThis & { __aiqsaConnectPush?: ConnectPush };

/** Connects the process's relay to the browser push sender, once per process. */
export function startConnectPush(): void {
  globalForConnectPush.__aiqsaConnectPush ??= createConnectPush({
    relay: getConnectRelay(),
    send: (userId, message, jobId) => getDefaultBrowserPush().sender.sendMessage(userId, message, jobId)
  });
}
