import type { BrowserPushMessage } from "../../contracts/browserPush";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { browserPushMessage } from "./payload";
import { PushTransportError, type PushPost } from "./pushTransport";
import type { AnswerReviewEndedEvent } from "../answerReviews/autoDriver";
import type {
  AnswerReviewPushEvent,
  BrowserPushDeliveryOutcome,
  BrowserPushEvent,
  BrowserPushStore,
  BrowserPushTarget
} from "./store";
import { encryptWebPushPayload, vapidAuthorization, type VapidKeyPair } from "./webPushCrypto";

export type BrowserPushSenderDeps = Readonly<{
  /** Detaches delivery from its caller; defaults to a plain promise. */
  background?: (work: () => Promise<void>) => Promise<void>;
  keys: () => Promise<VapidKeyPair>;
  now?: () => Date;
  post: PushPost;
  /** Waits out a run's grace; defaults to a timer that does not hold the process open. */
  sleep?: (ms: number) => Promise<void>;
  store: BrowserPushStore;
  /** VAPID subject: the installation's public URL. */
  subject: string;
}>;

type QueuedEvent =
  | Readonly<{ dueAt: number; id: string; kind: "occurrence" | "run" }>
  | Readonly<{ dueAt: number; ended: AnswerReviewEndedEvent; id: string; kind: "answer_review" }>;

/** Events waiting for the one delivery slot; beyond this a burst drops its pushes (they are best effort). */
const QUEUE_LIMIT = 500;
/**
 * How long a finished run's push waits for the device that showed its end
 * to say so. The page reports it as soon as the answer settles on screen.
 */
export const RUN_PUSH_GRACE_MS = 5_000;
/** A report may precede the run's terminal by a long Workspace settling. */
const SHOWN_RUN_TTL_MS = 15 * 60_000;
/** Runs remembered as shown; the oldest report is forgotten first. */
const SHOWN_RUNS_LIMIT = 1_000;
/** How long a push service keeps an undelivered message for an offline device. */
const MESSAGE_TTL_SECONDS = 24 * 60 * 60;

/** Content-free: run or occurrence identity, stable codes and HTTP status only. */
function log(fields: Readonly<{
  action?: "fail" | "skip"; code?: string; count?: number; httpStatus?: number; job_id?: string;
  outcome: "completed" | "failed" | "skipped"; prisma_code?: string; run_id?: string; stage: "claim" | "dispatch";
}>): void {
  logEvent("job_attempt", { subsystem: "push", ...fields });
}

function outcomeOf(status: number): BrowserPushDeliveryOutcome {
  if (status >= 200 && status < 300) return "delivered";
  return status === 404 || status === 410 ? "gone" : "failed";
}

function timer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Browser push delivery. Each event is claimed once in PostgreSQL before any
 * I/O, so a run or occurrence notifies at most once even when several paths
 * report it; delivery is best effort and never retried. Events are sent one
 * at a time outside their callers, so a slow push service delays nothing.
 *
 * A run's push skips every device whose page reported showing that run's end
 * while visible. The decision belongs here, not in the service worker:
 * Safari revokes a subscription after a few pushes that show no notification.
 */
export function createBrowserPushSender(deps: BrowserPushSenderDeps) {
  const clock = deps.now ?? (() => new Date());
  const background = deps.background ?? ((work) => work());
  const sleep = deps.sleep ?? timer;
  const queue: QueuedEvent[] = [];
  /** Run id → the sessions that showed its end, with when the report expires. */
  const shownRuns = new Map<string, { expiresAt: number; sessions: Set<string> }>();
  let sending: Promise<void> | null = null;

  function forgetExpired(now: number): void {
    for (const [runId, shown] of shownRuns) {
      if (shown.expiresAt > now) break;
      shownRuns.delete(runId);
    }
  }

  /** Session ids are the run owner's own: a report from another account's session matches none of its devices. */
  function takeShownSessions(runId: string): ReadonlySet<string> {
    const shown = shownRuns.get(runId);
    shownRuns.delete(runId);
    return shown && shown.expiresAt > clock().getTime() ? shown.sessions : new Set();
  }

  /** Posts one message to one device; the caller records the outcome. */
  async function post(message: BrowserPushMessage, target: BrowserPushTarget, keys: VapidKeyPair, jobId: string): Promise<BrowserPushDeliveryOutcome> {
    let status: number | undefined;
    let outcome: BrowserPushDeliveryOutcome;
    try {
      const endpoint = new URL(target.endpoint);
      const body = encryptWebPushPayload(Buffer.from(JSON.stringify(message)), {
        auth: Buffer.from(target.auth, "base64url"), p256dh: Buffer.from(target.p256dh, "base64url")
      });
      ({ status } = await deps.post({
        body,
        endpoint,
        headers: {
          authorization: vapidAuthorization({ audience: endpoint.origin, keys, now: clock(), subject: deps.subject }),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(MESSAGE_TTL_SECONDS),
          urgency: "normal"
        }
      }));
      outcome = outcomeOf(status);
    } catch (error) {
      outcome = "failed";
      log({ action: "skip", code: error instanceof PushTransportError ? error.code : "push_delivery_failed",
        job_id: jobId, outcome: "failed", stage: "dispatch" });
    }
    if (status !== undefined) {
      log({
        ...(outcome === "delivered" ? { outcome: "completed" as const } : {
          action: "skip" as const, code: outcome === "gone" ? "push_subscription_gone" : "push_delivery_failed", outcome: "failed" as const
        }),
        httpStatus: status, job_id: jobId, stage: "dispatch"
      });
    }
    return outcome;
  }

  async function deliver(event: BrowserPushEvent, target: BrowserPushTarget, keys: VapidKeyPair, jobId: string): Promise<void> {
    await deps.store.recordDelivery(target, await post(browserPushMessage(event), target, keys, jobId), clock());
  }

  async function send(queued: QueuedEvent): Promise<void> {
    let keys: VapidKeyPair;
    try {
      keys = await deps.keys();
    } catch {
      log({ action: "skip", code: "push_keys_unavailable", job_id: queued.id, outcome: "skipped", stage: "claim" });
      return;
    }
    try {
      const wait = queued.dueAt - clock().getTime();
      if (wait > 0) await sleep(wait);
      const now = clock();
      const event = queued.kind === "answer_review"
        ? await answerReviewEvent(queued.ended, now)
        : queued.kind === "run"
        ? await deps.store.claimRun(queued.id, now)
        : await deps.store.claimOccurrence(queued.id, now);
      if (!event) return;
      const listed = await deps.store.listTargets(event.userId, clock());
      // A device that showed the session's last step end on screen saw the result.
      const shownRunId = queued.kind === "answer_review" ? queued.ended.lastRunId : event.kind === "run" ? queued.id : null;
      const shown = shownRunId ? takeShownSessions(shownRunId) : new Set<string>();
      const targets = listed.filter((target) => !shown.has(target.sessionId));
      if (targets.length < listed.length) {
        log({ action: "skip", code: "push_run_shown_on_device", count: listed.length - targets.length,
          job_id: queued.id, outcome: "skipped", stage: "dispatch" });
      }
      log({ count: targets.length, job_id: queued.id, outcome: "completed", stage: "claim" });
      for (const target of targets) await deliver(event, target, keys, queued.id);
    } catch (error) {
      log({ action: "skip", code: "push_repository_failed", job_id: queued.id, outcome: "failed",
        prisma_code: databaseFailureCode(error), stage: "claim" });
    }
  }

  async function answerReviewEvent(ended: AnswerReviewEndedEvent, now: Date): Promise<AnswerReviewPushEvent | null> {
    const chat = await deps.store.loadAnswerReviewChat({ chatId: ended.chatId, userId: ended.userId }, now);
    return chat ? {
      answerFailed: ended.answerFailed, chatId: ended.chatId, kind: "answer_review", rounds: ended.rounds, state: ended.state,
      stopReason: ended.stopReason, title: chat.title, userId: ended.userId
    } : null;
  }

  function pump(): void {
    if (sending) return;
    const next = queue.shift();
    if (!next) return;
    sending = background(() => send(next)).catch(() => undefined).finally(() => {
      sending = null;
      pump();
    });
  }

  function enqueue(event: QueuedEvent): void {
    if (queue.length >= QUEUE_LIMIT) {
      log({ action: "skip", code: "push_queue_full", job_id: event.id, outcome: "skipped", stage: "claim" });
      return;
    }
    queue.push(event);
    pump();
  }

  return {
    /**
     * A finished chat run; ignored unless it is an ordinary, not user-cancelled
     * run whose owner receives pushes. Sent after `RUN_PUSH_GRACE_MS`.
     */
    notifyRun(runId: string): void {
      enqueue({ dueAt: clock().getTime() + RUN_PUSH_GRACE_MS, id: runId, kind: "run" });
    },
    /**
     * Sends a ready message to the user's live devices now, outside the event
     * queue, and resolves to the number of devices that accepted it (0 when
     * push is unavailable). The caller owns at-most-once delivery.
     */
    async sendMessage(userId: string, message: BrowserPushMessage, jobId: string): Promise<number> {
      let keys: VapidKeyPair;
      try {
        keys = await deps.keys();
      } catch {
        log({ action: "skip", code: "push_keys_unavailable", job_id: jobId, outcome: "skipped", stage: "claim" });
        return 0;
      }
      let targets: readonly BrowserPushTarget[];
      try {
        targets = await deps.store.listTargets(userId, clock());
      } catch (error) {
        log({ action: "skip", code: "push_repository_failed", job_id: jobId, outcome: "failed",
          prisma_code: databaseFailureCode(error), stage: "claim" });
        return 0;
      }
      let delivered = 0;
      for (const target of targets) {
        const outcome = await post(message, target, keys, jobId);
        if (outcome === "delivered") delivered += 1;
        try {
          await deps.store.recordDelivery(target, outcome, clock());
        } catch (error) {
          // Subscription health is observational; the device's outcome stands.
          log({ action: "skip", code: "push_repository_failed", job_id: jobId, outcome: "failed",
            prisma_code: databaseFailureCode(error), stage: "dispatch" });
        }
      }
      return delivered;
    },
    /** A settled scheduled occurrence that notifies its owner. */
    notifyOccurrence(occurrenceId: string): void {
      enqueue({ dueAt: 0, id: occurrenceId, kind: "occurrence" });
    },
    /**
     * The end of an automatic answer review, once per session (its driver
     * claims it). Sent after `RUN_PUSH_GRACE_MS`, skipping devices that
     * showed the session's last step end on screen.
     */
    notifyAnswerReview(ended: AnswerReviewEndedEvent): void {
      enqueue({ dueAt: clock().getTime() + RUN_PUSH_GRACE_MS, ended, id: ended.sessionId, kind: "answer_review" });
    },
    /** The page of this session showed the run's end while visible; its push skips the session's devices. */
    runShown(runId: string, sessionId: string): void {
      const now = clock().getTime();
      forgetExpired(now);
      const shown = shownRuns.get(runId);
      if (shown) {
        shown.sessions.add(sessionId);
        return;
      }
      if (shownRuns.size >= SHOWN_RUNS_LIMIT) shownRuns.delete(shownRuns.keys().next().value!);
      shownRuns.set(runId, { expiresAt: now + SHOWN_RUN_TTL_MS, sessions: new Set([sessionId]) });
    },
    /** Resolves when every queued event has been handled (tests and shutdown). */
    async idle(): Promise<void> {
      while (sending) await sending;
    }
  };
}

export type BrowserPushSender = ReturnType<typeof createBrowserPushSender>;
