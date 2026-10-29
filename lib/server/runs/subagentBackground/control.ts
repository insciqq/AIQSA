import {
  SUBAGENT_END_REASONS,
  SUBAGENT_ERROR_CODES,
  isActiveSubagentState,
  type EndedSubagentCallResult
} from "../../../contracts/subagents";
import { randomUUID } from "node:crypto";
import { decideUsageAdmission } from "../../../domain/usageLimits";
import { logEvent } from "../../observability";
import type {
  SubagentBackgroundAvailability,
  SubagentBackgroundControl,
  SubagentBackgroundMessageInput,
  SubagentBackgroundStartInput,
  SubagentBackgroundStartResult,
  SubagentBackgroundStopResult,
  SubagentCallbackSink,
  SubagentCallerScope,
  SubagentChatScope,
  SubagentDeliveryOutcome,
  SubagentRunner,
  SubagentStopReason,
  SubagentTurnHandle,
  WorkspaceAttachments
} from "../../subagents/ports";
import type { UsageLimitsRepository } from "../../usageLimits/repository";
import { activeRunControllerRegistry, type ActiveRunControllerRegistry } from "../activeRunControllerRegistry";
import { impliedResult, type SubagentBackgroundStore, type SubagentTurnRecord } from "./store";

/**
 * Background sub-agent runs (Claude Code's Agent with `run_in_background`,
 * SendMessage and TaskStop are the reference). A background turn is admitted
 * as its own run of the chat, as the user, under the parent run's frozen
 * bindings and the usage limits, and returns at once; it runs in this
 * process until it ends, is stopped or reaches its own turn time, then
 * settles its turn and sends its callback to the main agent. Stopping the
 * main agent's answer never stops it: its signal is its own.
 */

/** A background turn's own tool time (operator decision 2026-10-26: Workspace turns get an hour). */
export const SUBAGENT_BACKGROUND_TURN_MS = 60 * 60_000;
/** How long a stop waits for the turn to settle before answering with what is on record. */
const STOP_WAIT_MS = 20_000;

/**
 * The thread's mailbox holds `SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun`
 * messages and the port has no refusal for more: `deliver` throws this, and
 * the engine's `call_subagent` handler returns it as the visible refusal
 * `code` (`subagent_message_invalid`), never a failed call.
 */
export class SubagentMailboxFullError extends Error {
  readonly code = SUBAGENT_ERROR_CODES.messageInvalid;

  constructor() {
    super("subagent_mailbox_full");
    this.name = "SubagentMailboxFullError";
  }
}

type Execution = {
  /** Resolves once the turn settled here, or its admission was refused. */
  done: Promise<void>;
  finish: () => void;
  handle: SubagentTurnHandle | null;
  name: string;
  runId: string;
  scope: SubagentChatScope;
  stopReason: SubagentStopReason | null;
};

const EXECUTIONS = Symbol.for("aiqsa.subagent-background-executions.v1");
const globalExecutions = globalThis as typeof globalThis & { [EXECUTIONS]?: Map<string, Execution> };
/** Process-wide, like the run controllers: Stop routes run in other route bundles than the run that started a turn. */
const executions = globalExecutions[EXECUTIONS] ??= new Map<string, Execution>();

export type SubagentBackgroundOperations = SubagentBackgroundControl & Readonly<{
  /** The user's Stop on a thread (`user_stop`): its active turn, wherever it runs. Returns the turns that ended. */
  stopThread(input: SubagentChatScope & Readonly<{ threadId: string }>): Promise<number>;
  /** "Stop all": every active turn of the chat, every branch (`stop_all`). */
  stopAll(input: SubagentChatScope): Promise<number>;
  /** Before deleting a message's subtree: the active turns of runs under it. */
  stopUnderMessage(input: SubagentChatScope & Readonly<{ messageId: string }>): Promise<number>;
  /** Chat deletion, under its fence: every active turn (`chat_deleted`). */
  stopChat(input: SubagentChatScope): Promise<number>;
}>;

export type SubagentBackgroundDeps = Readonly<{
  callbacks: SubagentCallbackSink;
  newId?: () => string;
  now?: () => number;
  registry?: ActiveRunControllerRegistry;
  /** The engine's runner; without it background mode is unavailable and only stops, recovery and views work. */
  runner: SubagentRunner | null;
  stopWaitMs?: number;
  store: SubagentBackgroundStore;
  turnTimeMs?: number;
  usageLimits: Pick<UsageLimitsRepository, "loadUsageLimitStatus">;
  /**
   * The chat's shared Workspace. Every background run asks to attach; one it
   * refuses (no Workspace in the run, or not now) runs unattached, and its
   * Workspace calls are refused visibly where they are made.
   */
  workspace?: WorkspaceAttachments;
}>;

function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  })]);
}

export function createSubagentBackgroundControl(deps: SubagentBackgroundDeps): SubagentBackgroundOperations {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const registry = deps.registry ?? activeRunControllerRegistry;
  const turnTimeMs = deps.turnTimeMs ?? SUBAGENT_BACKGROUND_TURN_MS;
  const stopWaitMs = deps.stopWaitMs ?? STOP_WAIT_MS;

  async function usageAllows(userId: string): Promise<boolean> {
    try {
      const at = new Date(now());
      const status = await deps.usageLimits.loadUsageLimitStatus(userId, at);
      // Budgets bind every run; message windows count only the user's own messages, which a sub-agent is not.
      return decideUsageAdmission({ ...status, interactive: false, now: at }).ok;
    } catch {
      // A status that cannot be read refuses, never admits.
      return false;
    }
  }

  /** Settles the turn and its run; null when no settlement confirmed (recovery then ends the run as interrupted). */
  async function settle(execution: Execution, turnId: string, result: EndedSubagentCallResult): Promise<EndedSubagentCallResult | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const settlement = await deps.store.settle({ ...execution.scope, result, turnId });
        return settlement.settled ? settlement.result : null;
      } catch (error) {
        logEvent("job_persistence", { action: "retry", error, outcome: "unconfirmed", run_id: execution.runId, stage: "settle",
          subsystem: "run_recovery" });
      }
    }
    return null;
  }

  /**
   * Sends a settled turn's callback without holding its caller: the wake-up
   * turn it may admit runs the whole send pipeline, and Stop answers once the
   * turn has settled. A failure leaves it owed for recovery's flush.
   */
  function callBack(callback: Parameters<SubagentCallbackSink["deliver"]>[0], runId: string | null): void {
    void deps.callbacks.deliver(callback).catch((error: unknown) => {
      logEvent("run_recovery", { action: "retry", code: "subagent_callback_failed", error, outcome: "failed",
        ...(runId ? { run_id: runId } : {}), stage: "dispatch", subsystem: "run_recovery" });
    });
  }

  /**
   * The execution of a turn about to be admitted, registered before its
   * admission is visible, so a Stop that finds the admitted turn finds its
   * execution too: it marks it stopped and waits for `done`, and the launch
   * then settles it as stopped without ever running it.
   */
  function pendingExecution(input: SubagentBackgroundStartInput, ids: Readonly<{ runId: string; turnId: string }>) {
    const lease = registry.register(ids.runId);
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const execution: Execution = { done, finish, handle: null, name: input.name, runId: ids.runId,
      scope: { chatId: input.chatId, userId: input.userId }, stopReason: null };
    executions.set(ids.turnId, execution);
    return { abandon() {
      lease?.release();
      if (executions.get(ids.turnId) === execution) executions.delete(ids.turnId);
      execution.finish();
    }, execution, lease };
  }

  function launch(input: SubagentBackgroundStartInput, ids: Readonly<{ runId: string; turnId: string }>, runner: SubagentRunner,
    pending: ReturnType<typeof pendingExecution>): void {
    const { execution, lease } = pending;
    const signal = lease?.signal ?? new AbortController().signal;
    const scope = execution.scope;
    const deadlineAt = new Date(now() + turnTimeMs);
    void (async () => {
      const deadline = setTimeout(() => void stopLocal(ids.turnId, "deadline"), turnTimeMs);
      (deadline as { unref?: () => void }).unref?.();
      let attached = false;
      let executionUnknown = false;
      let result: EndedSubagentCallResult;
      try {
        // A Stop that came between admission and launch: the turn never runs.
        if (!execution.stopReason && deps.workspace) {
          const attach = await deps.workspace.attach({ ...scope, agent: { kind: "subagent", name: input.name, threadId: input.threadId },
            modelRunId: ids.runId }, signal);
          attached = attach.kind === "attached";
          if (attach.kind === "refused") {
            logEvent("run_execution", { code: "subagent_workspace_unattached", outcome: "failed", run_id: ids.runId, stage: "dispatch" });
          }
        }
        if (execution.stopReason) throw new Error("subagent_stopped_before_start");
        const turn = { ...scope, binding: input.binding, brief: input.brief, deadlineAt, hostRunId: ids.runId,
          mode: "background" as const, name: input.name, parentRunId: input.parentRunId, parentToolCallId: input.parentToolCallId,
          signal, threadId: input.threadId, turnId: ids.turnId, type: input.type, userMessage: input.userMessage };
        const handle = input.kind === "start" ? await runner.start(turn) : await runner.continue(turn);
        execution.handle = handle;
        if (execution.stopReason) await runner.stop(handle, execution.stopReason);
        result = await runner.wait(handle);
      } catch (error) {
        executionUnknown = execution.stopReason === null;
        result = impliedResult({ modelId: input.binding.modelId, name: input.name, reason: execution.stopReason ?? "subagent_run_failed",
          reasoningEffort: input.binding.reasoningEffort, state: execution.stopReason ? "stopped" : "failed" });
        if (executionUnknown) {
          logEvent("run_execution", { code: "subagent_run_failed", error, outcome: "failed", run_id: ids.runId, stage: "dispatch" });
        }
      } finally {
        clearTimeout(deadline);
      }
      if (execution.stopReason && result.state !== "stopped" && result.state !== "done") {
        const { outcome: _outcome, ...rest } = result;
        result = { ...rest, reason: execution.stopReason, state: "stopped" };
      }
      // Guest authority is retired before the turn settles: its processes are proven stopped, or the VM stops.
      if (attached && deps.workspace) {
        await deps.workspace.detach({ ...scope, execution: executionUnknown ? "unknown" : "settled", modelRunId: ids.runId })
          .catch((error: unknown) => logEvent("run_execution", { code: "subagent_workspace_detach_failed", error, outcome: "failed",
            run_id: ids.runId, stage: "completion" }));
      }
      const ended = await settle(execution, ids.turnId, result);
      pending.abandon();
      if (ended) callBack({ ...scope, name: input.name, parentRunId: input.parentRunId, result: ended, threadId: input.threadId,
        turnId: ids.turnId }, ids.runId);
    })().catch(() => pending.abandon());
  }

  /** Stops a turn executing here and waits a bounded time for it to settle; false when none executes here. */
  async function stopLocal(turnId: string, reason: SubagentStopReason): Promise<boolean> {
    const execution = executions.get(turnId);
    if (!execution) return false;
    execution.stopReason ??= reason;
    if (execution.handle && deps.runner) {
      await deps.runner.stop(execution.handle, execution.stopReason).catch(() => null);
    }
    // The run's own signal then cuts any I/O still in flight (provider, Workspace, MCP).
    registry.abort(execution.runId);
    await bounded(execution.done, stopWaitMs);
    return true;
  }

  /**
   * Ends a turn and returns how it ended. A background turn executing here is
   * stopped and awaited; one that does not settle within the bound, or that
   * no execution here owns (a restart cut it), is settled as stopped on
   * record, like a run's durable cancellation, and its execution's later
   * settlement changes nothing. Null only for a foreground turn the engine
   * could not stop.
   */
  async function stopTurn(turn: SubagentTurnRecord, reason: SubagentStopReason): Promise<EndedSubagentCallResult | null> {
    if (!isActiveSubagentState(turn.state)) return turn.result;
    if (turn.mode === "foreground") {
      return await deps.runner?.stop({ turnId: turn.turnId }, reason).catch(() => null) ?? null;
    }
    const local = await stopLocal(turn.turnId, reason);
    const current = await deps.store.findTurn({ chatId: turn.chatId, turnId: turn.turnId, userId: turn.userId });
    if (current && !isActiveSubagentState(current.state)) return current.result;
    if (!local && turn.runId) {
      await deps.workspace?.detach({ chatId: turn.chatId, execution: "unknown", modelRunId: turn.runId, userId: turn.userId })
        .catch(() => undefined);
    }
    const result = impliedResult({ modelId: turn.model.id, name: turn.name, reason, reasoningEffort: turn.model.effort, state: "stopped" });
    const settlement = await deps.store.settle({ chatId: turn.chatId, result, turnId: turn.turnId, userId: turn.userId });
    if (settlement.settled && settlement.result) {
      callBack({ chatId: turn.chatId, name: turn.name, parentRunId: turn.parentRunId, result: settlement.result,
        threadId: turn.threadId, turnId: turn.turnId, userId: turn.userId }, turn.runId);
    }
    return settlement.result;
  }

  /** Stops each turn; counts the turns that ended, so a turn still running is never reported stopped. */
  async function stopMany(turns: readonly SubagentTurnRecord[], reason: SubagentStopReason): Promise<number> {
    const ended = await Promise.all(turns.map(async (turn) => {
      const result = await stopTurn(turn, reason).catch(() => null);
      return result !== null && !isActiveSubagentState(result.state);
    }));
    return ended.filter(Boolean).length;
  }

  return Object.freeze({
    async availability(scope: SubagentCallerScope): Promise<SubagentBackgroundAvailability> {
      if (!deps.runner || !(await deps.store.callerAvailable(scope))) {
        return { available: false, code: SUBAGENT_ERROR_CODES.backgroundUnavailable };
      }
      return { available: true };
    },

    async start(input: SubagentBackgroundStartInput): Promise<SubagentBackgroundStartResult> {
      const runner = deps.runner;
      if (!runner || !(await deps.store.callerAvailable(input))) {
        return { code: SUBAGENT_ERROR_CODES.backgroundUnavailable, kind: "refused" };
      }
      if (!(await usageAllows(input.userId))) return { code: SUBAGENT_ERROR_CODES.usageLimited, kind: "refused" };
      const ids = { runId: newId(), turnId: newId() };
      const pending = pendingExecution(input, ids);
      let admission: Awaited<ReturnType<SubagentBackgroundStore["admit"]>>;
      try {
        admission = await deps.store.admit({ binding: input.binding, chatId: input.chatId,
          definitionRevisionId: input.type?.revisionId ?? null, parentRunId: input.parentRunId, parentToolCallId: input.parentToolCallId,
          runId: ids.runId, threadId: input.threadId, turnId: ids.turnId, userId: input.userId });
      } catch (error) {
        pending.abandon();
        throw error;
      }
      if (admission.kind === "refused") {
        pending.abandon();
        return admission;
      }
      launch(input, ids, runner, pending);
      return { kind: "started", name: input.name, state: "running", turnId: ids.turnId };
    },

    async deliver(input: SubagentBackgroundMessageInput): Promise<SubagentDeliveryOutcome> {
      const turn = await deps.store.findThreadTurnOnBranch({ chatId: input.chatId, name: input.name, parentRunId: input.parentRunId,
        userId: input.userId });
      if (!turn || turn.threadId !== input.threadId) return { kind: "not_found" };
      if (!isActiveSubagentState(turn.state)) return turn.result ? { kind: "ended", result: turn.result } : { kind: "not_found" };
      if (turn.mode !== "background" || !turn.runId) return { kind: "not_found" };
      const stored = await deps.store.insertMailbox({ chatId: input.chatId, nonce: input.message.nonce, runId: turn.runId,
        text: input.message.text, userId: input.userId });
      if (stored === "full") throw new SubagentMailboxFullError();
      if (stored === "closed") {
        const current = await deps.store.findTurn({ chatId: input.chatId, turnId: turn.turnId, userId: input.userId });
        return current?.result ? { kind: "ended", result: current.result } : { kind: "not_found" };
      }
      // On record in its mailbox but no execution of this process reads it (a restart cut it): accepted, never stamped
      // delivered, so it stays undelivered once recovery ends the turn interrupted.
      if (!deps.runner || !executions.has(turn.turnId)) return { kind: "delivered", state: turn.state };
      const outcome = await deps.runner.deliver({ turnId: turn.turnId }, input.message);
      if (outcome.kind === "delivered") {
        await deps.store.markMailboxDelivered({ chatId: input.chatId, nonce: input.message.nonce, runId: turn.runId, userId: input.userId });
      }
      return outcome;
    },

    async stop(input: SubagentCallerScope & Readonly<{ name: string }>): Promise<SubagentBackgroundStopResult> {
      const turn = await deps.store.findThreadTurnOnBranch({ chatId: input.chatId, name: input.name, parentRunId: input.parentRunId,
        userId: input.userId });
      if (!turn) return { kind: "not_found" };
      const result = await stopTurn(turn, SUBAGENT_END_REASONS.stoppedByAgent);
      return { kind: "stopped", result: result ?? impliedResult({ modelId: turn.model.id, name: turn.name,
        reason: SUBAGENT_END_REASONS.stoppedByAgent, reasoningEffort: turn.model.effort, state: "stopped" }) };
    },

    async stopThread(input) {
      return stopMany(await deps.store.activeTurns(input), SUBAGENT_END_REASONS.stoppedByUser);
    },

    async stopAll(input) {
      return stopMany(await deps.store.activeTurns(input), SUBAGENT_END_REASONS.stoppedAll);
    },

    async stopUnderMessage(input) {
      return stopMany(await deps.store.activeTurns({ chatId: input.chatId, underMessageId: input.messageId, userId: input.userId }),
        SUBAGENT_END_REASONS.stoppedByUser);
    },

    async stopChat(input) {
      return stopMany(await deps.store.activeTurns(input), SUBAGENT_END_REASONS.chatDeleted);
    }
  });
}

/** Turns executing in this process (tests and recovery). */
export function localSubagentTurnIds(): readonly string[] {
  return [...executions.keys()];
}
