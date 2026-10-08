const RUN_TERMINAL_LISTENER = Symbol.for("aiqsa.browser-push-run-terminal.v1");
const RUN_SETTLED_LISTENER = Symbol.for("aiqsa.answer-review-run-settled.v1");
const slot = globalThis as typeof globalThis & {
  [RUN_TERMINAL_LISTENER]?: (runId: string) => void;
  [RUN_SETTLED_LISTENER]?: (runId: string) => void;
};

/** Set once by the browser push sender (null clears it); the slot is process-global, shared by every route bundle. */
export function registerRunTerminalListener(listener: ((runId: string) => void) | null): void {
  if (listener) slot[RUN_TERMINAL_LISTENER] = listener;
  else delete slot[RUN_TERMINAL_LISTENER];
}

/**
 * Set once by the automatic answer review driver (null clears it): every
 * committed terminal transition, the user's cancellations included.
 */
export function registerRunSettledListener(listener: ((runId: string) => void) | null): void {
  if (listener) slot[RUN_SETTLED_LISTENER] = listener;
  else delete slot[RUN_SETTLED_LISTENER];
}

function notify(key: typeof RUN_TERMINAL_LISTENER | typeof RUN_SETTLED_LISTENER, runId: string): void {
  try {
    slot[key]?.(runId);
  } catch {
    // Listeners are best effort and never affect run settlement.
  }
}

/**
 * Reports a committed run terminal transition (completed or failed). It
 * never throws and never waits: each listener works on its own queue.
 */
export function signalRunTerminal(runId: string): void {
  notify(RUN_TERMINAL_LISTENER, runId);
  notify(RUN_SETTLED_LISTENER, runId);
}

/** Reports a committed user cancellation: browser push never notifies those. */
export function signalRunCancelled(runId: string): void {
  notify(RUN_SETTLED_LISTENER, runId);
}
