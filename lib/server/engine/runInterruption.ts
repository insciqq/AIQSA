import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { activeRunControllers } from "../runs/activeRunControllerRegistry";

/**
 * Main-agent runs a shared Workspace stopped under (another attached run's
 * unknown execution forced the VM to stop, `onAttachedRunsInterrupted`):
 * the run is cut like a Stop but ends interrupted, with Continue, as a
 * restart would end it, never cancelled and never replayed.
 */

const STATE = Symbol.for("aiqsa.native-run-interruptions.v1");
const globalState = globalThis as typeof globalThis & { [STATE]?: Set<string> };
/** Process-wide, like the run controllers: the coordinator that stopped the VM may run in another route bundle. */
const interrupted: Set<string> = globalState[STATE] ??= new Set();

/** The failure an interrupted run ends with: the restart's code, so the answer offers Continue. */
export const WORKSPACE_STOPPED_INTERRUPTION = Object.freeze({
  code: RUN_INTERRUPTED_FAILURE.code,
  message: "This answer was interrupted when its Workspace had to stop. Its work so far is kept; use Continue to pick it up."
});

/** Cuts a main-agent run executing in this process; false when none runs here (recovery ends it then). */
export function interruptNativeRun(runId: string): boolean {
  const controller = activeRunControllers.get(runId);
  if (!controller) return false;
  interrupted.add(runId);
  controller.abort();
  return true;
}

/** Whether the run was interrupted, clearing the mark. */
export function takeNativeRunInterruption(runId: string): boolean {
  return interrupted.delete(runId);
}
