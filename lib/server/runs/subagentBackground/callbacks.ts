import type { SubagentCallback, SubagentCallbackDisposition, SubagentCallbackSink, SubagentChatScope } from "../../subagents/ports";
import { logEvent } from "../../observability";
import { renderCallbackFollowup, renderWakeUp } from "./render";
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
 * - for a branch that is not the active one, they stay owed there and wake nothing.
 * Every claim is `callbackRunId IS NULL` compare-and-set (`store.ts`), so a
 * turn's end, a main run's terminal flush and recovery may all try and only
 * one delivers.
 */

/** How long a callback waits for others to share its wake-up turn. */
export const SUBAGENT_CALLBACK_COALESCE_MS = 1_500;
/** Attempts of one flush: a wake-up refused because the user's own message started first goes into that message's answer. */
const FLUSH_ATTEMPTS = 4;

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
  store: Pick<SubagentBackgroundStore, "deliverIntoRun" | "owedCallbacks">;
}>): SubagentCallbacks {
  const coalesceMs = deps.coalesceMs ?? SUBAGENT_CALLBACK_COALESCE_MS;
  const pending = new Map<string, Readonly<{ fired: { value: boolean }; promise: Promise<SubagentFlushReport> }>>();
  const running = new Map<string, Promise<unknown>>();

  async function attempt(scope: SubagentChatScope): Promise<SubagentFlushReport> {
    const dispositions = new Map<string, SubagentCallbackDisposition>();
    for (let round = 0; round < FLUSH_ATTEMPTS; round += 1) {
      const owed = await deps.store.owedCallbacks(scope);
      if (!owed) return { chatGone: true, dispositions };
      for (const turnId of owed.inactiveTurnIds) dispositions.set(turnId, "inactive_branch");
      const callbacks = owed.activeBranch.filter((callback) => !dispositions.has(callback.turnId) ||
        dispositions.get(callback.turnId) === "pending");
      if (callbacks.length === 0) return { chatGone: false, dispositions };
      if (owed.mainRun) {
        let closed = false;
        for (const callback of callbacks) {
          const outcome = closed ? "closed" : await deps.store.deliverIntoRun({ ...scope, runId: owed.mainRun.id,
            text: renderCallbackFollowup(callback), turnId: callback.turnId });
          // A claim another delivery won was delivered there.
          if (outcome === "closed") closed = true;
          dispositions.set(callback.turnId, outcome === "closed" ? "after_run" : "delivered");
        }
        return { chatGone: false, dispositions };
      }
      const wakeUp = renderWakeUp(callbacks);
      const outcome = await deps.admitWakeUp({ ...scope, text: wakeUp.text, turnIds: wakeUp.turnIds });
      logEvent("job_persistence", { code: `subagent_wake_up_${outcome}`, outcome: outcome === "admitted" ? "confirmed" : "not_applied",
        stage: "dispatch", subsystem: "run_recovery" });
      if (outcome === "admitted") {
        for (const turnId of wakeUp.turnIds) dispositions.set(turnId, "wake_up");
        // What did not fit goes into the woken run next round.
        if (wakeUp.turnIds.length === callbacks.length) return { chatGone: false, dispositions };
        continue;
      }
      if (outcome === "usage_limited" || outcome === "failed") {
        for (const callback of callbacks) dispositions.set(callback.turnId, "pending");
        return { chatGone: false, dispositions };
      }
    }
    // Still unresolved after every attempt (the user kept starting answers that closed first): owed for the next flush.
    return { chatGone: false, dispositions };
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
    return promise;
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
