import type { ComputerFailureCode, ConnectComputerInfoWire } from "@/lib/contracts/computer";
import type { ConnectArch, ConnectOp, ConnectOpArgs, ConnectOpResult, ConnectOs } from "@/lib/contracts/connect";

/**
 * The engine's way to the user's computer (§5 of the computer PRD): the
 * engine calls it for each `computer_*` tool, the Connect relay implements
 * it. The port checks the owner, the installation switch and the device's
 * stream itself on every call; the engine never reaches the relay directly.
 */

/** One operation on one of the user's devices. */
export type ComputerOpCall<Op extends ConnectOp = ConnectOp> = Readonly<{
  userId: string;
  deviceId: string;
  /** The run the operation belongs to; {@link ComputerOps.runEnded} ends its processes and jobs. */
  runId: string;
  op: Op;
  /** Bounded by the contract's schema; the port refuses arguments that do not match it. */
  args: ConnectOpArgs<Op>;
  /** How long the device may work and the port waits; never more than the turn's remaining tool time. */
  timeoutMs: number;
  /** Stop or the turn's deadline: the port sends `cancel` and answers `computer_cancelled`. */
  signal: AbortSignal;
}>;

/**
 * An operation's outcome. A failure says whether the command reached the
 * device: `sent: false` means nothing ran, so a call with effects may be
 * retried or reported as not done; `sent: true` means the device may have
 * started it, so the outcome of a call with effects stays unknown.
 */
export type ComputerOpOutcome<Op extends ConnectOp = ConnectOp> =
  | Readonly<{ ok: true; result: ConnectOpResult<Op> }>
  | Readonly<{ ok: false; code: ComputerFailureCode; sent: boolean }>;

/** What the engine's turn context and the computer picker show of a device; `info` while it is online and reported it. */
export type ComputerDescription = Readonly<{
  name: string;
  os: ConnectOs;
  arch: ConnectArch;
  online: boolean;
  info?: ConnectComputerInfoWire;
}>;

export interface ComputerOps {
  call<Op extends ConnectOp>(input: ComputerOpCall<Op>): Promise<ComputerOpOutcome<Op>>;
  /** Tells the device a run is over (`run_ended`) so it stops the run's processes; never throws, never waits. */
  runEnded(input: Readonly<{ userId: string; deviceId: string; runId: string }>): void;
  /** The user's own device; null for one that does not exist or is someone else's, alike. */
  describe(userId: string, deviceId: string): Promise<ComputerDescription | null>;
}

/** Before the Connect relay installs its implementation: nothing is connected and nothing is known. */
const UNAVAILABLE_COMPUTER_OPS: ComputerOps = Object.freeze({
  async call() {
    return { code: "connect_device_offline", ok: false, sent: false } as const;
  },
  async describe() {
    return null;
  },
  runEnded() {}
});

const globalForComputerOps = globalThis as typeof globalThis & { __aiqsaComputerOps?: ComputerOps };

/** The process's computer port, shared by every route bundle (single replica, as the relay). */
export function getComputerOps(): ComputerOps {
  return globalForComputerOps.__aiqsaComputerOps ?? UNAVAILABLE_COMPUTER_OPS;
}

/** Installs the relay's implementation; null restores the unavailable default. */
export function setComputerOps(ops: ComputerOps | null): void {
  if (ops) globalForComputerOps.__aiqsaComputerOps = ops;
  else delete globalForComputerOps.__aiqsaComputerOps;
}
