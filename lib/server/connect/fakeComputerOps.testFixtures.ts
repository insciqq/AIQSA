import type { ConnectOp } from "@/lib/contracts/connect";
import type { ComputerDescription, ComputerOpCall, ComputerOpOutcome, ComputerOps } from "./computerPort";

/** A call the fake saw, without its signal; `aborted` turns true when the caller aborts while it waits. */
export type FakeComputerCall = Omit<ComputerOpCall, "signal"> & { aborted: boolean };

/** Decides one call's outcome; it may wait, and should honour `signal` itself when it does. */
export type FakeComputerHandler = (call: ComputerOpCall) => ComputerOpOutcome | Promise<ComputerOpOutcome>;

export type FakeComputerOps = ComputerOps & {
  readonly calls: readonly FakeComputerCall[];
  readonly endedRuns: readonly Readonly<{ userId: string; deviceId: string; runId: string }>[];
  /** Answers the next call of `op` (any op when omitted) with `outcome`, in the order queued. */
  enqueue(outcome: ComputerOpOutcome | FakeComputerHandler, op?: ConnectOp): void;
  /** Makes `describe` answer this device for this user; null forgets it. */
  setDevice(userId: string, deviceId: string, description: ComputerDescription | null): void;
};

/**
 * A scriptable {@link ComputerOps} for tests: queued outcomes or handlers
 * answer calls in order, every call is recorded, and an aborted call answers
 * `computer_cancelled` (`sent: true`) unless its handler settled first.
 * Without a queued outcome a call answers `connect_device_offline`.
 */
export function createFakeComputerOps(): FakeComputerOps {
  const calls: FakeComputerCall[] = [];
  const endedRuns: { userId: string; deviceId: string; runId: string }[] = [];
  const queue: { op?: ConnectOp; outcome: ComputerOpOutcome | FakeComputerHandler }[] = [];
  const devices = new Map<string, ComputerDescription>();
  const deviceKey = (userId: string, deviceId: string) => JSON.stringify([userId, deviceId]);

  /** Not generic, so recording and answering need no casts; the port's `call` is this with each op's types. */
  async function call(input: ComputerOpCall): Promise<ComputerOpOutcome> {
    const { signal, ...recorded } = input;
    const seen: FakeComputerCall = { ...recorded, aborted: false };
    calls.push(seen);
    const cancelled = { code: "computer_cancelled", ok: false, sent: true } as const;
    if (signal.aborted) {
      seen.aborted = true;
      return cancelled;
    }
    const index = queue.findIndex((entry) => entry.op === undefined || entry.op === input.op);
    const entry = index < 0 ? undefined : queue.splice(index, 1)[0];
    if (!entry) return { code: "connect_device_offline", ok: false, sent: false };
    const answer = typeof entry.outcome === "function" ? entry.outcome(input) : entry.outcome;
    return await new Promise<ComputerOpOutcome>((resolve, reject) => {
      const onAbort = () => {
        seen.aborted = true;
        resolve(cancelled);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(answer).then(
        (outcome) => {
          signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  return {
    calls,
    endedRuns,
    call: call as unknown as ComputerOps["call"],
    async describe(userId, deviceId) {
      return devices.get(deviceKey(userId, deviceId)) ?? null;
    },
    enqueue(outcome, op) {
      queue.push({ op, outcome });
    },
    runEnded(input) {
      endedRuns.push({ deviceId: input.deviceId, runId: input.runId, userId: input.userId });
    },
    setDevice(userId, deviceId, description) {
      if (description) devices.set(deviceKey(userId, deviceId), description);
      else devices.delete(deviceKey(userId, deviceId));
    }
  };
}
