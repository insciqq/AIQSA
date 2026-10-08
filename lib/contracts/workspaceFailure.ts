/** Reviewed messages only: runtime/provider text is never diagnostic authority. */
export const WORKSPACE_OPERATION_FAILURE_MESSAGES = {
  workspace_session_lost: "The Workspace session is no longer available. Inspect the current session and attachment references before continuing; earlier commands were not repeated.",
  workspace_runtime_unavailable: "The Workspace runtime is unavailable. Check its status before continuing; an uncertain command must not be repeated.",
  workspace_tool_timeout: "The Workspace operation reached its time limit. This does not confirm that execution stopped; do not repeat an uncertain action.",
  workspace_turn_time_limit: "This turn ran out of time and was stopped. The files created so far remain in this chat's Workspace for your next message; a command that was still running may not have finished.",
  workspace_tool_cancelled: "The Workspace operation was cancelled. Cancellation does not confirm that execution stopped or undo earlier effects.",
  workspace_path_not_found: "The requested Workspace path was not found. Check the exact path before another operation.",
  workspace_path_access_denied: "Access to the requested path was denied. Check the allowed Workspace location and permissions.",
  workspace_request_invalid: "The Workspace request has invalid parameters. Correct them before another operation.",
  workspace_command_failed: "The command returned a nonzero exit code. Inspect its bounded output before deciding what to do next.",
  workspace_operation_failed: "The Workspace operation reported a failure without a confirmed specific cause. Do not assume a missing file or repeat an uncertain action.",
  workspace_tool_outcome_unknown: "The Workspace operation's outcome could not be confirmed. Do not repeat an action that may already have run.",
  workspace_tool_output_limit_exceeded: "The Workspace operation ran, but its result exceeded the Workspace transport limit and could not be read. Do not repeat it unchanged; write large output to a file and read it in smaller parts.",
  workspace_request_too_large: "The Workspace request exceeded the runner's request limit and was not dispatched. Send smaller input before trying again.",
  workspace_execution_stopped: "Workspace execution was stopped, but its command exit outcome is unknown. Do not repeat an uncertain action.",
  workspace_execution_outcome_unknown: "This execution's outcome is unknown. Historical cleanup status does not prove command success or a current cleanup failure.",
  workspace_execution_stop_failed: "Workspace could not confirm that execution stopped. The session remains fenced until cleanup is confirmed.",
  workspace_execution_settlement_failed: "Workspace stopped execution, but could not durably confirm cleanup. The session remains fenced.",
  workspace_carryover_unavailable: "The Workspace files of this scheduled task's previous chat could not be restored here, so nothing ran. The next run tries again; the previous chat keeps its Workspace meanwhile.",
} as const;

export type WorkspaceOperationFailureCode = keyof typeof WORKSPACE_OPERATION_FAILURE_MESSAGES;

export function isWorkspaceOperationFailureCode(value: unknown): value is WorkspaceOperationFailureCode {
  return typeof value === "string" && Object.hasOwn(WORKSPACE_OPERATION_FAILURE_MESSAGES, value);
}

export function workspaceOperationFailureMessage(code: WorkspaceOperationFailureCode): string {
  return WORKSPACE_OPERATION_FAILURE_MESSAGES[code];
}
