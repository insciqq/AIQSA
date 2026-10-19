import type { ConnectReasonCode } from "@/lib/contracts/connect";
import { logEvent, type LifecycleAction, type LifecycleOutcome, type LifecycleStage } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";

/** Server-side codes beyond the wire reasons; each is registered in `failureCodes.json`. */
export type ConnectServerLogCode =
  | "connect_device_paired"
  | "connect_device_queue_full"
  | "connect_device_revoked"
  | "connect_policy_unavailable"
  | "connect_policy_updated"
  | "connect_policy_version_conflict"
  | "connect_reply_invalid"
  | "connect_store_unavailable"
  | "connect_view_queue_full"
  | "connect_view_seq_gap";

/**
 * The only way AIQSA Connect writes a log record: a closed code, a stage, an
 * outcome and at most a count. Terminal bytes, paths, titles, names, tokens
 * and identifiers never reach it; a caught error contributes only the
 * logger's content-free projection.
 */
export function logConnect(input: Readonly<{
  action?: LifecycleAction;
  code: ConnectReasonCode | ConnectServerLogCode;
  count?: number;
  error?: unknown;
  outcome: LifecycleOutcome;
  stage: LifecycleStage;
}>): void {
  logEvent("service_operation", {
    ...(input.action ? { action: input.action } : {}),
    code: input.code,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.error === undefined ? {} : { error: input.error, prisma_code: databaseFailureCode(input.error) }),
    outcome: input.outcome,
    stage: input.stage,
    subsystem: "connect"
  });
}
