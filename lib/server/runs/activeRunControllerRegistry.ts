/** Process-local lifecycle ownership shared by preparation, execution and Stop.
 * Global identity also spans Next route bundles. HTTP disconnect never aborts it. */
const globalForRuns = globalThis as unknown as {
  __aiqsaActiveRunControllers?: Map<string, AbortController>;
  __aiqsaRunSettlements?: Map<string, Promise<void>>;
};
export const activeRunControllers = globalForRuns.__aiqsaActiveRunControllers ?? new Map<string, AbortController>();
globalForRuns.__aiqsaActiveRunControllers = activeRunControllers;
// Shared with the cancel route's bundle for the same reason as the controllers.
export const runSettlements = globalForRuns.__aiqsaRunSettlements ?? new Map<string, Promise<void>>();
globalForRuns.__aiqsaRunSettlements = runSettlements;

export type ActiveRunControllerRegistry = Readonly<{
  abort(runId: string): boolean;
  has(runId: string): boolean;
  ids(): readonly string[];
  register(runId: string): Readonly<{
    release(): void;
    signal: AbortSignal;
  }> | null;
  /**
   * Resolves once the run executing in this process finished its terminal
   * handling (tool cancellation, Workspace settlement). Null when no such run
   * is executing here.
   */
  settled(runId: string): Promise<void> | null;
}>;

export const activeRunControllerRegistry: ActiveRunControllerRegistry = Object.freeze({
  abort(runId: string): boolean {
    const controller = activeRunControllers.get(runId);
    if (!controller) {
      return false;
    }

    controller.abort();
    if (activeRunControllers.get(runId) === controller) {
      activeRunControllers.delete(runId);
    }
    return true;
  },
  has(runId: string): boolean {
    return activeRunControllers.has(runId);
  },
  ids(): readonly string[] {
    return [...activeRunControllers.keys()];
  },
  settled(runId: string): Promise<void> | null {
    return runSettlements.get(runId) ?? null;
  },
  register(runId: string) {
    if (activeRunControllers.has(runId)) return null;
    const controller = new AbortController();
    activeRunControllers.set(runId, controller);
    return Object.freeze({
      release() {
        if (activeRunControllers.get(runId) === controller) {
          activeRunControllers.delete(runId);
        }
      },
      signal: controller.signal
    });
  }
});
