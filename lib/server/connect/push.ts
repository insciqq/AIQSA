import { randomUUID } from "node:crypto";
import type { BrowserPushMessage } from "@/lib/contracts/browserPush";
import { logEvent } from "../observability";
import { getDefaultBrowserPush } from "../push/defaultBrowserPush";
import { connectPushMessage } from "../push/payload";
import { getConnectRelay, type ConnectRelay, type ConnectRelayEvent } from "./relay";

/** At most one notice per session in this interval. */
export const CONNECT_PUSH_INTERVAL_MS = 15_000;
/** Sessions whose last notice the process remembers; older ones are past the interval or forgotten first. */
const REMEMBERED_SESSIONS = 4_096;

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
 * visible, and at most once per session every 15 seconds. Each notice is
 * sent once (never retried); the sender applies the account's browser
 * notification setting.
 */
export function createConnectPush(deps: ConnectPushDeps): ConnectPush {
  const now = deps.now ?? Date.now;
  const jobId = deps.jobId ?? randomUUID;
  const lastSent = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();

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

  function handle(event: ConnectRelayEvent): void {
    if (event.type !== "status") return;
    const { deviceId, sessionId, status, userId } = event;
    if ((status !== "needs_approval" && status !== "waiting") || event.previousStatus === status) return;
    const at = now();
    if (deps.relay.isSessionVisible(userId, deviceId, sessionId, at)) return;
    const key = JSON.stringify([userId, deviceId, sessionId]);
    const last = lastSent.get(key);
    if (last !== undefined && at - last < CONNECT_PUSH_INTERVAL_MS) return;
    remember(key, at);
    const id = jobId();
    const message = connectPushMessage({ deviceId, sessionId, sessionTitle: event.title, status });
    const work: Promise<void> = Promise.resolve()
      .then(() => deps.send(userId, message, id))
      .then(() => undefined, (error: unknown) => {
        logEvent("job_attempt", { action: "skip", code: "push_delivery_failed", error, job_id: id, outcome: "failed", stage: "dispatch", subsystem: "push" });
      })
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  }

  const unsubscribe = deps.relay.onEvent(handle);
  return {
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
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
