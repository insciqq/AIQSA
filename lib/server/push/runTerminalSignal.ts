const RUN_TERMINAL_LISTENER = Symbol.for("aiqsa.browser-push-run-terminal.v1");
const SUBAGENT_FLUSH_LISTENER = Symbol.for("aiqsa.subagent-callback-flush.v1");
const slot = globalThis as typeof globalThis & {
  [RUN_TERMINAL_LISTENER]?: (runId: string) => void;
  [SUBAGENT_FLUSH_LISTENER]?: (runId: string) => void;
};

/** Set once by the browser push sender (null clears it); the slot is process-global, shared by every route bundle. */
export function registerRunTerminalListener(listener: ((runId: string) => void) | null): void {
  if (listener) slot[RUN_TERMINAL_LISTENER] = listener;
  else delete slot[RUN_TERMINAL_LISTENER];
}

/**
 * Set once by the background sub-agent composition (null clears it): a main
 * agent run that completed or failed delivers its chat's owed sub-agent
 * callbacks (`lib/server/runs/subagentBackground/callbacks.ts`).
 */
export function registerSubagentCallbackFlushListener(listener: ((runId: string) => void) | null): void {
  if (listener) slot[SUBAGENT_FLUSH_LISTENER] = listener;
  else delete slot[SUBAGENT_FLUSH_LISTENER];
}

/**
 * A main-agent run was admitted: callbacks of sub-agents that ended while no
 * answer ran go into it. Never throws, never waits.
 */
export function signalSubagentCallbackFlush(runId: string): void {
  try {
    slot[SUBAGENT_FLUSH_LISTENER]?.(runId);
  } catch {
    // A flush is best effort: the run's terminal flush delivers what stays owed.
  }
}

/**
 * Reports a committed run terminal transition. It never throws and never
 * waits: the listener claims and delivers on its own queue.
 */
export function signalRunTerminal(runId: string): void {
  for (const listener of [slot[RUN_TERMINAL_LISTENER], slot[SUBAGENT_FLUSH_LISTENER]]) {
    try {
      listener?.(runId);
    } catch {
      // Notifications and callback flushes are best effort and never affect run settlement.
    }
  }
}
