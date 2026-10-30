import type {
  SubagentDeliveryOutcome,
  SubagentMessage,
  SubagentRunner,
  SubagentStopReason,
  SubagentTurnHandle,
  SubagentTurnInput
} from "../../subagents/ports";

/**
 * The engine's `SubagentRunner` for background turns
 * (`configureSubagentBackground`). A background turn runs in the process of
 * the main-agent run whose `call_subagent` admitted it, on a host that run
 * registered when it prepared its sub-agents (`runSubagents.ts`): the
 * parent's frozen request, registry builder, model routes and binding rows
 * (by reference, read from `parentRunId`), with the turn's own run id,
 * signal, deadline, usage ledger and live-browser membership. The host
 * outlives its parent run, so a background turn keeps running after the
 * main agent answered; a restart ends it interrupted (its recovery), never
 * replayed. Without a host for its parent (a parent of another process, or
 * one gone longer than the grace below) the turn fails visibly.
 */

/** Builds the runner of one background turn on its parent run's host. */
export type SubagentBackgroundHost = (turn: SubagentTurnInput) => SubagentRunner;

/** How long a parent's host stays after its run ended, for a turn its call admitted that is still attaching. */
export const SUBAGENT_BACKGROUND_HOST_GRACE_MS = 10 * 60_000;
const ENDED_TURN_KEPT_MS = 60_000;

/** A host and whether a background start of its run has been asked for (only such a host is kept after its run). */
type HostEntry = { host: SubagentBackgroundHost; used: boolean };

type State = { hosts: Map<string, HostEntry>; timers: Map<string, ReturnType<typeof setTimeout>>;
  turns: Map<string, SubagentRunner> };

const STATE = Symbol.for("aiqsa.subagent-background-hosts.v2");
const globalState = globalThis as typeof globalThis & { [STATE]?: State };
/** Process-wide, like the run controllers: the control runs in the route bundle that admitted the turn. */
const state: State = globalState[STATE] ??= { hosts: new Map(), timers: new Map(), turns: new Map() };

export type SubagentBackgroundHostRegistration = Readonly<{
  /** The run's end: an unused host goes at once; a used one is kept for the grace, then dropped. */
  release(): void;
  /**
   * A background start of the run was asked for: called before its admission (`call_subagent`), so a turn whose
   * Workspace attachment outlasts the run still finds the host, and again as the turn begins.
   */
  use(): void;
}>;

/**
 * Registers a main-agent run's host for its background turns. Only a host a
 * start was asked for outlives its run, so a run that started none keeps
 * nothing of its bindings once it ended; a later registration of the same run
 * replaces it.
 */
export function registerSubagentBackgroundHost(parentRunId: string, host: SubagentBackgroundHost, graceMs = SUBAGENT_BACKGROUND_HOST_GRACE_MS):
  SubagentBackgroundHostRegistration {
  const pending = state.timers.get(parentRunId);
  if (pending) clearTimeout(pending);
  state.timers.delete(parentRunId);
  const entry: HostEntry = { host, used: false };
  state.hosts.set(parentRunId, entry);
  let released = false;
  const drop = () => {
    state.timers.delete(parentRunId);
    if (state.hosts.get(parentRunId) === entry) state.hosts.delete(parentRunId);
  };
  return {
    release() {
      if (released) return;
      released = true;
      if (!entry.used) {
        drop();
        return;
      }
      const timer = setTimeout(drop, graceMs);
      (timer as { unref?: () => void }).unref?.();
      state.timers.set(parentRunId, timer);
    },
    use() {
      entry.used = true;
    }
  };
}

/** Whether a background turn of this parent run can be hosted here (tests). */
export function hasSubagentBackgroundHost(parentRunId: string): boolean {
  return state.hosts.has(parentRunId);
}

async function begin(input: SubagentTurnInput, kind: "continue" | "start"): Promise<SubagentTurnHandle> {
  if (input.mode !== "background") throw new Error("subagent_turn_mode_invalid");
  const entry = state.hosts.get(input.parentRunId);
  if (!entry) throw new Error("subagent_parent_unavailable");
  entry.used = true;
  const runner = entry.host(input);
  const handle = kind === "start" ? await runner.start(input) : await runner.continue(input);
  state.turns.set(handle.turnId, runner);
  // The turn's runner is kept a while after it ended (the control's wait and a late stop read it), then dropped.
  void runner.wait(handle).catch(() => undefined).finally(() => {
    const timer = setTimeout(() => {
      if (state.turns.get(handle.turnId) === runner) state.turns.delete(handle.turnId);
    }, ENDED_TURN_KEPT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return handle;
}

export const backgroundSubagentRunner: SubagentRunner = Object.freeze({
  start: (input: SubagentTurnInput) => begin(input, "start"),
  continue: (input: SubagentTurnInput) => begin(input, "continue"),
  async wait(handle: SubagentTurnHandle, signal?: AbortSignal) {
    const runner = state.turns.get(handle.turnId);
    if (!runner) throw new Error("subagent_turn_missing");
    return runner.wait(handle, signal);
  },
  async deliver(handle: SubagentTurnHandle, message: SubagentMessage): Promise<SubagentDeliveryOutcome> {
    const runner = state.turns.get(handle.turnId);
    return runner ? runner.deliver(handle, message) : { kind: "not_found" };
  },
  async stop(handle: SubagentTurnHandle, reason: SubagentStopReason) {
    const runner = state.turns.get(handle.turnId);
    return runner ? runner.stop(handle, reason) : null;
  }
});
