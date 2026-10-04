const RUNNER_KICK = Symbol.for("aiqsa.scheduled-task-runner-kick.v1");
const slot = globalThis as typeof globalThis & { [RUNNER_KICK]?: () => void };

/** Set by the runner when it starts; the slot is process-global, shared by every route bundle. */
export function registerScheduledTaskRunnerKick(kick: () => void): void {
  slot[RUNNER_KICK] = kick;
}

/** Wakes the runner without loading its dependencies; its timer covers a process where it is not running. */
export function kickScheduledTaskRunner(): void {
  slot[RUNNER_KICK]?.();
}
