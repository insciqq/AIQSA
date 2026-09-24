import { ObservationStoreError, TOOL_OBSERVATION_LIMITS } from "./contract";

/** Hold the permit from before dispatch until the original has been stored
 * and replaced by its bounded projection. Waiting requests hold no result. */
export function createObservationAdmission(
  concurrency: number = TOOL_OBSERVATION_LIMITS.concurrentDispatches,
  pending: number = TOOL_OBSERVATION_LIMITS.queuedDispatches
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(pending) || pending < 0) {
    throw new RangeError("tool_observation_admission_invalid");
  }
  let active = 0;
  const queue: Array<{ start(): void }> = [];
  const release = () => {
    const next = queue.shift();
    if (next) next.start();
    else active--;
  };
  return async function admitted<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (active < concurrency) active++;
    else {
      if (queue.length >= pending) throw new ObservationStoreError("tool_observation_limit_exceeded");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(signal!.reason);
        };
        const waiter = { start() {
          signal?.removeEventListener("abort", abort);
          resolve();
        } };
        queue.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      signal?.throwIfAborted();
      return await work();
    } finally { release(); }
  };
}

// Next entry points can load distinct module bundles in the same worker.
// Keep one process-wide pool across ordinary tools, Agent built-ins and reads.
const admissionKey = Symbol.for("aiqsa.tool-observation-admission.v1");
const processPools = globalThis as typeof globalThis & {
  [admissionKey]?: ReturnType<typeof createObservationAdmission>;
};
export const admitToolObservation = processPools[admissionKey] ??= createObservationAdmission();
