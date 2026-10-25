const RUN_TERMINAL_LISTENER = Symbol.for("aiqsa.browser-push-run-terminal.v1");
const slot = globalThis as typeof globalThis & { [RUN_TERMINAL_LISTENER]?: (runId: string) => void };

/** Set once by the browser push sender (null clears it); the slot is process-global, shared by every route bundle. */
export function registerRunTerminalListener(listener: ((runId: string) => void) | null): void {
  if (listener) slot[RUN_TERMINAL_LISTENER] = listener;
  else delete slot[RUN_TERMINAL_LISTENER];
}

/**
 * Reports a committed run terminal transition. It never throws and never
 * waits: the listener claims and delivers on its own queue.
 */
export function signalRunTerminal(runId: string): void {
  try {
    slot[RUN_TERMINAL_LISTENER]?.(runId);
  } catch {
    // Notifications are best effort and never affect run settlement.
  }
}
