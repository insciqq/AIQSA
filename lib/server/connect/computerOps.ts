import type { z } from "zod";
import {
  CONNECT_ID_PATTERN,
  CONNECT_MAX_WRITE_BYTES,
  CONNECT_OPS,
  connectOpArgsSchemas,
  connectUtf8ByteLength,
  type ConnectOp,
  type ConnectOpArgs
} from "@/lib/contracts/connect";
import type { ComputerDescription, ComputerOpCall, ComputerOpOutcome, ComputerOps } from "./computerPort";
import { logConnect } from "./observability";
import type { ConnectPolicyGate } from "./policy";
import type { ConnectRelay } from "./relay";
import type { ConnectRepository } from "./repository";

export type ConnectComputerOpsDeps = Readonly<{
  now?: () => number;
  policy: Pick<ConnectPolicyGate, "enabled">;
  relay: Pick<ConnectRelay, "callOp" | "onlineDevice" | "runEnded">;
  repository: Pick<ConnectRepository, "deviceExists" | "findDevice">;
}>;

type Failure = Extract<ComputerOpOutcome, { ok: false }>;

function failure(code: Failure["code"], sent: boolean): Failure {
  return { code, ok: false, sent };
}

function isOp(value: unknown): value is ConnectOp {
  return typeof value === "string" && (CONNECT_OPS as readonly string[]).includes(value);
}

/** Write and edit content beyond the contract's byte bound: a too-large file, not a malformed call. */
function oversizeContent(op: ConnectOp, args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const record = args as Record<string, unknown>;
  const fields = op === "write" ? [record.content] : op === "edit" ? [record.oldString, record.newString] : [];
  return fields.some((value) => typeof value === "string" && connectUtf8ByteLength(value) > CONNECT_MAX_WRITE_BYTES);
}

/**
 * The engine's port to the user's computers over the Connect relay. Every
 * call checks the installation switch, bounds the arguments by the contract
 * before anything is sent, and reaches only the caller's own device: another
 * account's device answers exactly like a missing one
 * (`connect_device_unavailable`), administrators included. Logs carry codes
 * and durations only (D-18).
 */
export function createConnectComputerOps(deps: ConnectComputerOpsDeps): ComputerOps {
  const now = deps.now ?? Date.now;

  /** Not generic, so the outcome needs no casts; the port's `call` is this with each op's types. */
  async function call(input: ComputerOpCall): Promise<ComputerOpOutcome> {
    try {
      if (!(await deps.policy.enabled())) return failure("connect_disabled", false);
    } catch (error) {
      // An unreadable switch is a transient failure: nothing was sent, the engine may say so.
      logConnect({ action: "retry", code: "connect_policy_unavailable", error, outcome: "failed", stage: "read" });
      return failure("connect_device_offline", false);
    }
    if (!CONNECT_ID_PATTERN.test(input.deviceId)) return failure("connect_device_unavailable", false);
    if (!isOp(input.op) || !CONNECT_ID_PATTERN.test(input.runId) || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      logConnect({ action: "skip", code: "connect_request_invalid", outcome: "blocked", stage: "validate" });
      return failure("connect_device_error", false);
    }
    if (oversizeContent(input.op, input.args)) return failure("computer_file_too_large", false);
    const args = (connectOpArgsSchemas[input.op] as z.ZodType).safeParse(input.args);
    if (!args.success) {
      logConnect({ action: "skip", code: "connect_request_invalid", outcome: "blocked", stage: "validate" });
      return failure("connect_device_error", false);
    }
    const startedAt = now();
    const pending = deps.relay.callOp({
      args: args.data as ConnectOpArgs,
      deviceId: input.deviceId,
      op: input.op,
      runId: input.runId,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      userId: input.userId
    });
    if (pending) {
      const outcome = await pending;
      if (!outcome.ok && outcome.code !== "computer_timeout") {
        logConnect({ code: outcome.code, durationMs: now() - startedAt, outcome: "failed", stage: "dispatch" });
      }
      return outcome;
    }
    // No stream of this user's device: tell the user's own offline computer from a missing or foreign one.
    try {
      return failure(
        (await deps.repository.deviceExists({ id: input.deviceId, userId: input.userId }))
          ? "connect_device_offline"
          : "connect_device_unavailable",
        false
      );
    } catch (error) {
      logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage: "read" });
      return failure("connect_device_offline", false);
    }
  }

  return {
    call: call as unknown as ComputerOps["call"],

    async describe(userId: string, deviceId: string): Promise<ComputerDescription | null> {
      if (!CONNECT_ID_PATTERN.test(deviceId)) return null;
      const record = await deps.repository.findDevice({ id: deviceId, userId });
      if (!record) return null;
      const online = deps.relay.onlineDevice(userId, deviceId);
      return {
        arch: record.arch,
        ...(online?.info ? { info: online.info } : {}),
        name: record.name,
        online: online !== null,
        os: record.os
      };
    },

    runEnded(input) {
      try {
        if (CONNECT_ID_PATTERN.test(input.deviceId) && CONNECT_ID_PATTERN.test(input.runId)) deps.relay.runEnded(input);
      } catch {
        // Fire and forget: a run's end never waits for or fails on its computer.
      }
    }
  };
}
