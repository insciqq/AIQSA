import { isMonitoringVerdict, MONITORING_VERDICTS, type MonitoringVerdict } from "../scheduledTasks/runnerPolicy";
import type { ModelToolCall, RunTool, ToolExecutionContext, ToolExecutionResult } from "./types";

/**
 * The monitoring verdict: the one built-in tool of a run that a monitoring
 * task's occurrence admitted (`NormalizedRunRequest.monitoringVerdictTool`,
 * frozen from the server-only occurrence, never from a request field). It
 * writes only the outcome of its own run's check, performs no external I/O and
 * changes nothing another call reads, hence the server-owned `session` class.
 * Its first call is reserved outside the business tool budgets; a repeated
 * call counts against them like any other.
 */
export const MONITORING_VERDICT_TOOL_NAME = "report_monitoring_result";

export const monitoringVerdictTool: RunTool = {
  capability: "session",
  description: "Report the outcome of this automation's monitoring check. Call it exactly once, after checking and before " +
    "your final answer. goal_reached: what the user is waiting for has happened; this ends the automation for good, and " +
    "nothing else in this run can stop it. update: something the user watches changed since the last shown result; the " +
    "automation keeps checking. no_update: you checked everything the request needs and nothing relevant changed. " +
    "could_not_check: a page, search or tool the check needs failed or could not be reached, so you cannot tell whether " +
    "anything changed; never report no_update then.",
  inputSchema: {
    additionalProperties: false,
    properties: { status: { enum: [...MONITORING_VERDICTS], type: "string" } },
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
 * the outcome once at the end. A scheduled run has no other way to stop its
 * automation, so the instruction says that only `goal_reached` ends it, and
 * that a check that could not reach what it needed reports `could_not_check`,
 * never a `no_update` that would hide it.
 */
export function monitoringCheckInstruction(input: Readonly<{ previousResult: boolean }>): string {
  return [
    "This turn is an automation's monitoring check of the user's saved request.",
    input.previousResult
      ? "The earlier exchange in this conversation is the last result the user was shown. Check again and compare what you find with that result."
      : "No earlier result has been shown: report the current state as the starting point later checks compare with.",
    `When you have finished checking, call ${MONITORING_VERDICT_TOOL_NAME} exactly once before your final answer with one status.`,
    "\"goal_reached\" if what the user is waiting for has happened: it ends the automation permanently and is the only way " +
      "this run can stop it, so when the user asked to be told once something happens, or to stop monitoring then, report " +
      "it rather than \"update\".",
    input.previousResult
      ? "\"update\" if something the user asked to watch changed since the last shown result; the automation keeps checking. " +
        "\"no_update\" if you checked everything the request needs and nothing relevant changed."
      : "\"update\" on this first check, with the current state as the starting point.",
    "\"could_not_check\" if a page, search or tool the check needs failed or could not be reached, so you cannot tell " +
      "whether anything changed; never report \"no_update\" then.",
    input.previousResult
      ? "Then write your answer as text, as usual, never the call alone. A check with no update is not shown to the user."
      : "Then write your answer as text, as usual, never the call alone."
  ].join(" ");
}

/** The ephemeral last provider message of a round that offers only the reserved verdict. */
export function monitoringVerdictReservedInstruction(toolName: string = MONITORING_VERDICT_TOOL_NAME): string {
  return `The tool budget for this run is used up except for one call reserved for ${toolName}. Call ${toolName} ` +
    "now with the outcome of this check and no other tool, then answer using only the results already obtained.";
}

/**
 * The ephemeral last provider message of the one round that asks for a verdict the model skipped after writing its answer
 * (`lib/server/engine/loop.ts`): the answer stands as written, so the round only reports.
 */
export function monitoringVerdictAfterAnswerInstruction(toolName: string = MONITORING_VERDICT_TOOL_NAME): string {
  return `Your answer is written and stands as it is, but you did not call ${toolName}. Call ${toolName} now with the ` +
    "outcome of this check and no other tool, and write no further text.";
}

/**
 * Whether a check whose model reported `verdict` is shown to the user, so its answer needs text: an update or a reached
 * goal, and on a first check (no previous shown result in its context) anything but `could_not_check`, since the settlement
 * makes that the starting point (`monitoringCheckSettlement`). A shown answer is the next check's comparison basis, so an
 * empty one would leave the user an empty card and every later check nothing to compare with. A `no_update` that is
 * hidden, and a check that could not check, need none.
 */
export function monitoringVerdictNeedsText(verdict: MonitoringVerdict, previousResult: boolean): boolean {
  return verdict === "update" || verdict === "goal_reached" || (verdict === "no_update" && !previousResult);
}

/**
 * The ephemeral last provider message of the one tool-free round that asks a shown check for the text its answer lacks
 * (`lib/server/engine/loop.ts`): what it writes is the answer, which stands after it.
 */
export function monitoringAnswerTextInstruction(): string {
  return "You reported the outcome of this check, and it will be shown to the user, but your answer has no text. Write " +
    "the answer now as plain text: the current state you found and what changed, if anything, so the user can read it " +
    "and the next check can compare with it. Do not call any tool.";
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
    return result(call, "error", [{
      text: `${MONITORING_VERDICT_TOOL_NAME} takes one status: goal_reached, update, no_update or could_not_check.`, type: "text"
    }]);
  }
  const recorded = record && context.runId && context.userId
    ? await record({ runId: context.runId, userId: context.userId, verdict: status })
    : false;
  return recorded
    ? result(call, "complete", [{ type: "json", value: { recorded: true, status } }])
    : result(call, "error", [{ text: "This check can no longer record its outcome.", type: "text" }]);
}
