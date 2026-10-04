import { isMonitoringVerdict, type MonitoringVerdict } from "../scheduledTasks/runnerPolicy";
import type { ModelToolCall, RunTool, ToolExecutionContext, ToolExecutionResult } from "./types";

/**
 * The monitoring verdict: the one built-in tool of a run that a monitoring
 * task's occurrence admitted (`NormalizedRunRequest.monitoringVerdictTool`,
 * frozen from the server-only occurrence, never from a request field). It
 * writes only the outcome of its own run's check, performs no external I/O and
 * changes nothing another call reads, hence the server-owned `session` class.
 * It is reserved outside the business tool budgets.
 */
export const MONITORING_VERDICT_TOOL_NAME = "report_monitoring_result";

export const monitoringVerdictTool: RunTool = {
  capability: "session",
  description: "Report the outcome of this scheduled monitoring check. Call it exactly once, after checking and before " +
    "your final answer: update (something the user watches changed since the last shown result), no_update (nothing " +
    "relevant changed) or goal_reached (what the user is waiting for has happened).",
  inputSchema: {
    additionalProperties: false,
    properties: { status: { enum: ["update", "no_update", "goal_reached"], type: "string" } },
    required: ["status"],
    type: "object"
  },
  name: MONITORING_VERDICT_TOOL_NAME,
  strict: true
};

/** Whether a call of an accepted run is its reserved monitoring verdict. */
export function isMonitoringVerdictCall(request: Readonly<{ monitoringVerdictTool?: unknown }>, toolName: string): boolean {
  return request.monitoringVerdictTool === true && toolName === MONITORING_VERDICT_TOOL_NAME;
}

/**
 * Server-owned run instruction of a monitoring check, frozen with the accepted
 * prompt (never stored as user text): compare with the previous shown result
 * the context holds, or report the starting point on a first check, and report
 * the outcome once at the end.
 */
export function monitoringCheckInstruction(input: Readonly<{ previousResult: boolean }>): string {
  return [
    "This turn is a scheduled monitoring check of the user's saved request.",
    input.previousResult
      ? "The earlier exchange in this conversation is the last result the user was shown. Check again and compare what you find with that result."
      : "No earlier result has been shown: report the current state as the starting point later checks compare with.",
    `When you have finished checking, call ${MONITORING_VERDICT_TOOL_NAME} exactly once before your final answer: ` +
      "\"update\" if something the user asked to watch changed since the last shown result, \"no_update\" if nothing " +
      "relevant changed, \"goal_reached\" if what the user is waiting for has happened." +
      (input.previousResult ? "" : " On this first check report \"update\", or \"goal_reached\" if it has already happened."),
    "Then write your answer as usual. A check with no update is not shown to the user."
  ].join(" ");
}

/** The ephemeral last provider message of a round that offers only the reserved verdict. */
export function monitoringVerdictReservedInstruction(toolName: string = MONITORING_VERDICT_TOOL_NAME): string {
  return `The tool budget for this run is used up except for one call reserved for ${toolName}. Call ${toolName} ` +
    "now with the outcome of this check and no other tool, then answer using only the results already obtained.";
}

export type MonitoringVerdictRecorder = (input: Readonly<{ runId: string; userId: string; verdict: MonitoringVerdict }>) =>
  Promise<boolean>;

function result(call: ModelToolCall, status: ToolExecutionResult["status"], content: ToolExecutionResult["content"]): ToolExecutionResult {
  return { callId: call.id, content, name: call.name, status };
}

/**
 * Validates and records one report. An invalid or unrecordable report is a
 * tool error the model sees (and may correct); the check then counts as
 * unreported, which is shown. Executing the same report again records the
 * same value, so a recovered call cannot change or duplicate anything.
 */
export async function executeMonitoringVerdict(
  call: ModelToolCall,
  context: Pick<ToolExecutionContext, "runId" | "userId">,
  record: MonitoringVerdictRecorder | undefined
): Promise<ToolExecutionResult> {
  const status = call.arguments.status;
  if (Object.keys(call.arguments).length !== 1 || !isMonitoringVerdict(status)) {
    return result(call, "error", [{ text: `${MONITORING_VERDICT_TOOL_NAME} takes one status: update, no_update or goal_reached.`, type: "text" }]);
  }
  const recorded = record && context.runId && context.userId
    ? await record({ runId: context.runId, userId: context.userId, verdict: status })
    : false;
  return recorded
    ? result(call, "complete", [{ type: "json", value: { recorded: true, status } }])
    : result(call, "error", [{ text: "This check can no longer record its outcome.", type: "text" }]);
}
