import type { ComputerFailureCode } from "@/lib/contracts/computer";
import type { ConnectReasonCode } from "@/lib/contracts/connect";
import { logEvent, type LifecycleAction, type LifecycleOutcome, type LifecycleStage } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";

/** Server-side codes beyond the wire reasons; each is registered in `failureCodes.json`. */
export type ConnectServerLogCode =
  /** A file read for `computer_attach_file` that could not be stored or attached (`lib/server/tools/computerAttachFile.ts`). */
  | "computer_output_unpublished"
  | "connect_device_paired"
  | "connect_device_queue_full"
  | "connect_device_revoked"
  | "connect_policy_unavailable"
  | "connect_policy_updated"
  | "connect_policy_version_conflict"
  | "connect_reply_invalid"
  | "connect_store_unavailable";

/**
 * The only way AIQSA Connect writes a log record: a closed code, a stage, an
 * outcome and at most a count and a duration (D-18). Commands, paths, file
 * content, output, names, tokens and identifiers never reach it; a caught
 * error contributes only the logger's content-free projection.
 */
export function logConnect(input: Readonly<{
  action?: LifecycleAction;
  code: ComputerFailureCode | ConnectReasonCode | ConnectServerLogCode;
  count?: number;
  durationMs?: number;
  error?: unknown;
  outcome: LifecycleOutcome;
  stage: LifecycleStage;
}>): void {
  logEvent("service_operation", {
    ...(input.action ? { action: input.action } : {}),
    code: input.code,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.durationMs === undefined ? {} : { duration_ms: Math.max(0, Math.round(input.durationMs)) }),
    ...(input.error === undefined ? {} : { error: input.error, prisma_code: databaseFailureCode(input.error) }),
    outcome: input.outcome,
    stage: input.stage,
    subsystem: "connect"
  });
}
