import type { SubagentCallback, SubagentCallbackDisposition, SubagentCallbackSink, SubagentChatScope } from "../../subagents/ports";
import { logEvent } from "../../observability";
import { renderWakeUp } from "./render";
import type { SubagentBackgroundStore } from "./store";

/**
 * Callbacks of background sub-agents for the main agent of the branch each
 * started on (Claude Code's task notifications are the reference):
 * - into the branch's running answer, as a `subagent_callback` follow-up that
 *   moves the revision the answer closes at;
 * - when no answer runs, one server-written wake-up turn admitted as the user
 *   through the ordinary send handler; callbacks that arrive close together
 *   share one, and the admission claims them in its own transaction;
 * - refused by usage limits, they stay owed for the next main-agent turn;
 * - for a branch that is not the active one, they stay owed there and wake nothing;
 * - an answer that is running but already closed to follow-ups (published, and
 *   still finishing its Workspace hand-off) is behind them as the user's own
 *   next message would be: the wake-up is offered to the send handler at once,
 *   which admits it behind that answer or answers busy, and then the answer's
 *   terminal flush delivers them;
 * - left owed for a reason that clears (that closed answer, a busy or failed
 *   admission), the chat is flushed again a few times shortly after
 *   (`SUBAGENT_CALLBACK_RECHECK_MS`), so no wake-up waits for recovery's sweep.
 * Every claim is `callbackRunId IS NULL` compare-and-set (`store.ts`), so a
 * turn's end, a main run's terminal flush and recovery may all try and only
 * one delivers.
 */

/** How long a callback waits for others to share its wake-up turn. */
export const SUBAGENT_CALLBACK_COALESCE_MS = 1_500;
/** Attempts of one flush: a wake-up refused because the user's own message started first goes into that message's answer. */
const FLUSH_ATTEMPTS = 4;
/** Further flushes of a chat whose callbacks a flush left owed for a reason that clears, after these delays. */
export const SUBAGENT_CALLBACK_RECHECK_MS: readonly number[] = Object.freeze([3_000, 10_000, 30_000]);

export type SubagentWakeUpOutcome =
  | "admitted"
  /** A main-agent run started first (409 `active_run_in_progress`): the callbacks go into it. */
  | "busy"
  /** The active leaf changed, or another delivery claimed a callback: retried with what is still owed. */
  | "stale"
  /** Usage limits refused it (429): the callbacks stay owed. */
  | "usage_limited"
  /** Anything else (the chat is gone or archived, the model is unavailable): they stay owed, logged. */
  | "failed";

/** Admits the wake-up turn as the chat's owner (`wakeUp.ts`). */
export type SubagentWakeUpAdmitter = (input: SubagentChatScope & Readonly<{ text: string; turnIds: readonly string[] }>) =>
  Promise<SubagentWakeUpOutcome>;

export type SubagentFlushReport = Readonly<{
  /** The chat is gone or being deleted: nothing is delivered. */
  chatGone: boolean;
  dispositions: ReadonlyMap<string, SubagentCallbackDisposition>;
  /**
   * Of the `pending` ones, those whose wake-up failed for a reason that may
   * clear (the chat archived, the model unavailable), which recovery retries
   * with a backoff; the rest of `pending` waited on usage limits.
   */
  retryable: ReadonlySet<string>;
}>;

export type SubagentCallbacks = Readonly<{
  sink: SubagentCallbackSink;
  /** Delivers the chat's owed callbacks now (coalesced with others close together). */
  flush(scope: SubagentChatScope): Promise<SubagentFlushReport>;
  /** A main-agent run of the chat ended: its owed callbacks go out (the terminal flush). Never throws, never waits. */
  mainRunEnded(scope: SubagentChatScope): void;
}>;

export function createSubagentCallbacks(deps: Readonly<{
  admitWakeUp: SubagentWakeUpAdmitter;
  coalesceMs?: number;
  recheckMs?: readonly number[];
  store: Pick<SubagentBackgroundStore, "deliverIntoRun" | "owedCallbacks">;
}>): SubagentCallbacks {
  const coalesceMs = deps.coalesceMs ?? SUBAGENT_CALLBACK_COALESCE_MS;
  const recheckMs = deps.recheckMs ?? SUBAGENT_CALLBACK_RECHECK_MS;
  const pending = new Map<string, Readonly<{ fired: { value: boolean }; promise: Promise<SubagentFlushReport> }>>();
  const running = new Map<string, Promise<unknown>>();
  /** Per chat: the next recheck's index and its timer, while a flush leaves callbacks owed for a reason that clears. */
  const rechecks = new Map<string, { index: number; timer: ReturnType<typeof setTimeout> | null }>();

  async function attempt(scope: SubagentChatScope): Promise<SubagentFlushReport> {
    const dispositions = new Map<string, SubagentCallbackDisposition>();
    const retryable = new Set<string>();
    for (let round = 0; round < FLUSH_ATTEMPTS; round += 1) {
      const owed = await deps.store.owedCallbacks(scope);
      if (!owed) return { chatGone: true, dispositions, retryable };
      for (const turnId of owed.inactiveTurnIds) dispositions.set(turnId, "inactive_branch");
      const callbacks = owed.activeBranch.filter((callback) => !dispositions.has(callback.turnId) ||
        dispositions.get(callback.turnId) === "pending");
      if (callbacks.length === 0) return { chatGone: false, dispositions, retryable };
      let waiting = callbacks;
      if (owed.mainRun) {
        let closed = false;
        for (const callback of callbacks) {
          const outcome = closed ? "closed" : await deps.store.deliverIntoRun({ ...scope, runId: owed.mainRun.id,
            turnId: callback.turnId });
          // A claim another delivery won was delivered there.
          if (outcome === "closed") closed = true;
          dispositions.set(callback.turnId, outcome === "closed" ? "after_run" : "delivered");
        }
        // The answer closed to follow-ups and its run is still ending: the wake-up goes behind it, as the user's own
        // next message would; a busy refusal leaves them for the answer's terminal flush.
        waiting = callbacks.filter((callback) => dispositions.get(callback.turnId) === "after_run");
        if (waiting.length === 0) return { chatGone: false, dispositions, retryable };
      }
      const wakeUp = renderWakeUp(waiting);
      const outcome = await deps.admitWakeUp({ ...scope, text: wakeUp.text, turnIds: wakeUp.turnIds });
      logEvent("job_persistence", { code: `subagent_wake_up_${outcome}`, outcome: outcome === "admitted" ? "confirmed" : "not_applied",
        stage: "dispatch", subsystem: "run_recovery" });
      if (outcome === "admitted") {
        for (const turnId of wakeUp.turnIds) dispositions.set(turnId, "wake_up");
        // What did not fit goes into the woken run next round.
        if (wakeUp.turnIds.length === waiting.length) return { chatGone: false, dispositions, retryable };
        continue;
      }
      // Behind a closed answer, a busy wake-up waits for its terminal flush; nothing else changes until it ends.
      if (owed.mainRun && outcome === "busy") return { chatGone: false, dispositions, retryable };
      if (outcome === "usage_limited" || outcome === "failed") {
        for (const callback of waiting) {
          dispositions.set(callback.turnId, "pending");
          if (outcome === "failed") retryable.add(callback.turnId);
        }
        return { chatGone: false, dispositions, retryable };
      }
    }
    // Still unresolved after every attempt (the user kept starting answers that closed first): owed for the next flush.
    return { chatGone: false, dispositions, retryable };
  }

  function flush(scope: SubagentChatScope): Promise<SubagentFlushReport> {
    const key = `${scope.userId}:${scope.chatId}`;
    const waiting = pending.get(key);
    if (waiting && !waiting.fired.value) return waiting.promise;
    const fired = { value: false };
    const before = running.get(key) ?? Promise.resolve();
    const promise = before.catch(() => undefined)
      .then(() => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, coalesceMs);
        (timer as { unref?: () => void }).unref?.();
      }))
      .then(() => {
        fired.value = true;
        if (pending.get(key)?.promise === promise) pending.delete(key);
        return attempt(scope);
      });
    pending.set(key, { fired, promise });
    running.set(key, promise);
    void promise.finally(() => {
      if (running.get(key) === promise) running.delete(key);
    }).catch(() => undefined);
    void promise.then((report) => recheck(scope, report), () => recheck(scope, null)).catch(() => undefined);
    return promise;
  }

  /**
   * After a flush: callbacks left owed behind a closing answer or a busy, stale or failed admission are flushed again
   * after the next delay, at most `recheckMs.length` times in a row; a flush that leaves none owed for such a
   * reason ends the rechecks. Usage limits and inactive branches wait for the next main-agent turn instead.
   */
  function recheck(scope: SubagentChatScope, report: SubagentFlushReport | null): void {
    const key = `${scope.userId}:${scope.chatId}`;
    const current = rechecks.get(key);
    if (current?.timer) return;
    const clears = report === null || [...report.dispositions].some(([turnId, disposition]) =>
      disposition === "after_run" || disposition === "pending" && report.retryable.has(turnId));
    if (!clears || report?.chatGone) {
      rechecks.delete(key);
      return;
    }
    const index = current?.index ?? 0;
    const delay = recheckMs[index];
    if (delay === undefined) {
      rechecks.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      rechecks.set(key, { index: index + 1, timer: null });
      void flush(scope).catch(() => undefined);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    rechecks.set(key, { index, timer });
  }

  const sink: SubagentCallbackSink = {
    async deliver(callback: SubagentCallback): Promise<SubagentCallbackDisposition> {
      const report = await flush({ chatId: callback.chatId, userId: callback.userId });
      if (report.chatGone) return "inactive_branch";
      // Absent: another flush delivered it before this one read the owed list.
      return report.dispositions.get(callback.turnId) ?? "delivered";
    }
  };

  return Object.freeze({
    flush,
    mainRunEnded(scope: SubagentChatScope) {
      void flush(scope).catch((error: unknown) => {
        logEvent("run_recovery", { action: "retry", code: "subagent_callback_flush_failed", error, outcome: "failed",
          stage: "recovery", subsystem: "run_recovery" });
      });
    },
    sink
  });
}
