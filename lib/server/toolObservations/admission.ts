import { ObservationStoreError, TOOL_OBSERVATION_LIMITS } from "./contract";

export type ObservationAdmissionOptions = Readonly<{
  signal?: AbortSignal;
  /** `reject` refuses new work transiently while the queue is saturated. An
   * already executed result uses `wait`: it is never discarded for queueing. */
  whenBusy?: "reject" | "wait";
  onWait?(): void;
}>;

/** A FIFO bytes-in-flight budget for the phases that encode, upload or read an
 * original. It never wraps a business call, a reservation or a settlement:
 * slow tools do not hold capacity. A large head waiter is not starved by later
 * small phases; one phase never needs more than the whole budget. */
export function createObservationAdmission(
  capacityBytes: number = TOOL_OBSERVATION_LIMITS.inFlightBytes,
  pending: number = TOOL_OBSERVATION_LIMITS.queuedOperations
) {
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1 || !Number.isSafeInteger(pending) || pending < 0) {
    throw new RangeError("tool_observation_admission_invalid");
  }
  let used = 0;
  const queue: Array<{ weight: number; start(): void }> = [];
  const drain = () => {
    while (queue.length > 0 && used + queue[0]!.weight <= capacityBytes) {
      const next = queue.shift()!;
      used += next.weight;
      next.start();
    }
  };
  const busy = () => queue.length >= pending;
  async function admitted<T>(bytes: number, work: () => Promise<T>, options: ObservationAdmissionOptions = {}): Promise<T> {
    const { signal } = options;
    signal?.throwIfAborted();
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError("tool_observation_admission_invalid");
    const weight = Math.min(capacityBytes, Math.max(1, Math.ceil(bytes)));
    if (queue.length === 0 && used + weight <= capacityBytes) used += weight;
    else {
      if (options.whenBusy !== "wait" && busy()) throw new ObservationStoreError("tool_observation_busy");
      options.onWait?.();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          // A cancelled head waiter may have been blocking smaller phases.
          drain();
          reject(signal!.reason);
        };
        const waiter = { weight, start() {
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
    } finally {
      used -= weight;
      drain();
    }
  }
  return Object.assign(admitted, { busy });
}

export type ObservationAdmission = ReturnType<typeof createObservationAdmission>;

// Next entry points can load distinct module bundles in the same worker.
// Keep one process-wide budget across ordinary tools, Agent built-ins and reads.
const admissionKey = Symbol.for("aiqsa.tool-observation-admission.v2");
const processPools = globalThis as typeof globalThis & {
  [admissionKey]?: ObservationAdmission;
};
export const admitToolObservation = processPools[admissionKey] ??= createObservationAdmission();
