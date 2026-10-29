import {
  SUBAGENT_END_REASONS,
  SUBAGENT_ERROR_CODES,
  isActiveSubagentState,
  type EndedSubagentCallResult
} from "../../../contracts/subagents";
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

/** The thread's mailbox holds `SUBAGENT_FOLLOWUP_LIMITS.messagesPerRun` messages; the port has no refusal for more. */
export class SubagentMailboxFullError extends Error {
  readonly code = SUBAGENT_ERROR_CODES.messageInvalid;

  constructor() {
    super("subagent_mailbox_full");
    this.name = "SubagentMailboxFullError";
  }
}

/** A turn that could not start (its Workspace refused it): it fails with this code. */
class SubagentTurnStartError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SubagentTurnStartError";
  }
}

type Execution = {
  done: Promise<void>;
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
  /** The user's Stop on a thread (`user_stop`): its active turn, wherever it runs. Returns the turns stopped. */
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
  now?: () => number;
  registry?: ActiveRunControllerRegistry;
  /** The engine's runner; without it background mode is unavailable and only stops, recovery and views work. */
  runner: SubagentRunner | null;
  stopWaitMs?: number;
  store: SubagentBackgroundStore;
  turnTimeMs?: number;
  usageLimits: Pick<UsageLimitsRepository, "loadUsageLimitStatus">;
  /** The chat's shared Workspace; a run whose parent has none never attaches. */
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

  async function settleAndCall(execution: Execution, turnId: string, input: Pick<SubagentBackgroundStartInput, "parentRunId">,
    threadId: string, result: EndedSubagentCallResult): Promise<void> {
    let settlement: Awaited<ReturnType<SubagentBackgroundStore["settle"]>> | null = null;
    for (let attempt = 0; attempt < 3 && !settlement; attempt += 1) {
      try {
        settlement = await deps.store.settle({ ...execution.scope, result, turnId });
      } catch (error) {
        logEvent("job_persistence", { action: "retry", error, outcome: "unconfirmed", run_id: execution.runId, stage: "settle",
          subsystem: "run_recovery" });
      }
    }
    // A settlement that never confirmed is left to recovery, which ends the run as interrupted.
    if (!settlement?.settled || !settlement.result) return;
    try {
      await deps.callbacks.deliver({ ...execution.scope, name: execution.name, parentRunId: input.parentRunId,
        result: settlement.result, threadId, turnId });
    } catch (error) {
      // It stays owed: the next main-agent run's terminal flush or recovery delivers it.
      logEvent("run_recovery", { action: "retry", code: "subagent_callback_failed", error, outcome: "failed", run_id: execution.runId,
        stage: "dispatch", subsystem: "run_recovery" });
    }
  }

  function launch(input: SubagentBackgroundStartInput, admitted: Readonly<{ runId: string; turnId: string; workspace: boolean }>,
    runner: SubagentRunner): void {
    const lease = registry.register(admitted.runId);
    const signal = lease?.signal ?? new AbortController().signal;
    const scope = { chatId: input.chatId, userId: input.userId };
    const execution: Execution = { done: Promise.resolve(), handle: null, name: input.name, runId: admitted.runId, scope,
      stopReason: null };
    executions.set(admitted.turnId, execution);
    const deadlineAt = new Date(now() + turnTimeMs);
    execution.done = (async () => {
      const deadline = setTimeout(() => void stopLocal(admitted.turnId, "deadline"), turnTimeMs);
      (deadline as { unref?: () => void }).unref?.();
      let attached = false;
      let executionUnknown = false;
      let result: EndedSubagentCallResult;
      try {
        if (deps.workspace && admitted.workspace) {
          const attach = await deps.workspace.attach({ ...scope, agent: { kind: "subagent", name: input.name, threadId: input.threadId },
            modelRunId: admitted.runId }, signal);
          if (attach.kind === "refused") throw new SubagentTurnStartError(attach.code);
          attached = true;
        }
        const turn = { ...scope, binding: input.binding, brief: input.brief, deadlineAt, hostRunId: admitted.runId,
          mode: "background" as const, name: input.name, parentRunId: input.parentRunId, parentToolCallId: input.parentToolCallId,
          signal, threadId: input.threadId, turnId: admitted.turnId, type: input.type, userMessage: input.userMessage };
        const handle = input.kind === "start" ? await runner.start(turn) : await runner.continue(turn);
        execution.handle = handle;
        if (execution.stopReason) await runner.stop(handle, execution.stopReason);
        result = await runner.wait(handle);
      } catch (error) {
        const startCode = error instanceof SubagentTurnStartError ? error.code : null;
        executionUnknown = startCode === null && execution.stopReason === null;
        result = impliedResult({ modelId: input.binding.modelId, name: input.name,
          reason: execution.stopReason ?? (startCode && /^[a-z][a-z0-9_]{0,63}$/u.test(startCode) ? startCode : "subagent_run_failed"),
          reasoningEffort: input.binding.reasoningEffort, state: execution.stopReason ? "stopped" : "failed" });
        if (executionUnknown) {
          logEvent("run_execution", { code: "subagent_run_failed", error, outcome: "failed", run_id: admitted.runId, stage: "dispatch" });
        }
      } finally {
        clearTimeout(deadline);
      }
      if (execution.stopReason && result.state !== "stopped" && result.state !== "done") {
        const { outcome: _outcome, ...rest } = result;
        result = { ...rest, reason: execution.stopReason, state: "stopped" };
      }
      await settleAndCall(execution, admitted.turnId, input, input.threadId, result);
      if (attached && deps.workspace) {
        await deps.workspace.detach({ ...scope, execution: executionUnknown ? "unknown" : "settled", modelRunId: admitted.runId })
          .catch((error: unknown) => logEvent("run_execution", { code: "subagent_workspace_detach_failed", error, outcome: "failed",
            run_id: admitted.runId, stage: "completion" }));
      }
      lease?.release();
      if (executions.get(admitted.turnId) === execution) executions.delete(admitted.turnId);
    })();
    void execution.done.catch(() => undefined);
  }

  /** Stops a turn executing here; false when none is. */
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

  async function stopTurn(turn: SubagentTurnRecord, reason: SubagentStopReason): Promise<EndedSubagentCallResult | null> {
    if (!isActiveSubagentState(turn.state)) return turn.result;
    if (turn.mode === "foreground") {
      return await deps.runner?.stop({ turnId: turn.turnId }, reason).catch(() => null) ?? null;
    }
    if (!(await stopLocal(turn.turnId, reason))) {
      // No execution of this process owns it (a restart cut it): it ends here, with its callback.
      const result = impliedResult({ modelId: turn.model.id, name: turn.name, reason, reasoningEffort: turn.model.effort,
        state: "stopped" });
      const settlement = await deps.store.settle({ chatId: turn.chatId, result, turnId: turn.turnId, userId: turn.userId });
      if (settlement.settled && settlement.result) {
        await deps.callbacks.deliver({ chatId: turn.chatId, name: turn.name, parentRunId: turn.parentRunId, result: settlement.result,
          threadId: turn.threadId, turnId: turn.turnId, userId: turn.userId }).catch(() => "pending");
      }
    }
    const current = await deps.store.findTurn({ chatId: turn.chatId, turnId: turn.turnId, userId: turn.userId });
    return current?.result ?? null;
  }

  async function stopMany(turns: readonly SubagentTurnRecord[], reason: SubagentStopReason): Promise<number> {
    const stopped = await Promise.all(turns.map(async (turn) => (await stopTurn(turn, reason).catch(() => null)) !== null));
    return stopped.filter(Boolean).length;
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
      const admission = await deps.store.admit({ binding: input.binding, chatId: input.chatId,
        definitionRevisionId: input.type?.revisionId ?? null, parentRunId: input.parentRunId, parentToolCallId: input.parentToolCallId,
        threadId: input.threadId, userId: input.userId });
      if (admission.kind === "refused") return admission;
      launch(input, admission, runner);
      return { kind: "started", name: input.name, state: "running", turnId: admission.turnId };
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
      const outcome = deps.runner && executions.has(turn.turnId)
        ? await deps.runner.deliver({ turnId: turn.turnId }, input.message)
        // On record in its mailbox, but no execution of this process runs it: recovery ends it, with its callback.
        : { kind: "delivered" as const, state: turn.state };
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
