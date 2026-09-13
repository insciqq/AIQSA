import { reportSubsystemFailure, reportSubsystemHealthy } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailure } from "../providers/providerObservability";
import type { WorkspaceRuntimeHealth } from "./runtime";

export function workspaceLifecycleFailure(error: unknown) {
  const failure = observedFailure(error);
  return {
    code: failure.code,
    prisma_code: databaseFailureCode(error),
    outcome: failure.code === "workspace_operation_stale" ? "stale" as const
      : failure.code === "workspace_tool_cancelled" || failure.reason === "cancelled" ? "cancelled" as const : "failed" as const
  };
}

/** Observe the existing health result without performing another probe. */
export function observeWorkspaceHealth(health: WorkspaceRuntimeHealth, scope: "app" | "runner"): void {
  if (health.state === "ready") reportSubsystemHealthy("workspace", "health", scope);
  else if (health.reasonCode !== "workspace_runner_unconfigured") reportSubsystemFailure({
    subsystem: "workspace", stage: "health", scope_id: scope, code: health.reasonCode, action: "wait"
  });
}
