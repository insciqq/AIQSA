import { isMonitoringVerdict } from "../scheduledTasks/runnerPolicy";
import {
  MONITORING_VERDICT_TOOL_NAME,
  monitoringAnswerTextInstruction,
  monitoringVerdictAfterAnswerInstruction,
  monitoringVerdictNeedsText,
  monitoringVerdictReservedInstruction
} from "./monitoringVerdict";

/**
 * The one built-in report a run's admission reserved outside the business
 * tool budgets: a monitoring check's verdict. Its first call never counts
 * against the budgets and an exhausted budget still offers it once, as does an
 * answer written without it (`afterAnswerInstruction`); live execution and
 * recovery derive the same reservation from the accepted request. A report
 * that is shown to the user needs its answer's text (`textInstruction`), for
 * the arguments of its last recorded call (`textNeeded`).
 */
export function reservedToolCallForRequest(
  request: Readonly<{ monitoringPreviousResult?: unknown; monitoringVerdictTool?: unknown }>
): Readonly<{
  afterAnswerInstruction: string;
  instruction: string;
  name: string;
  textInstruction: string;
  textNeeded(args: Readonly<Record<string, unknown>>): boolean;
}> | null {
  return request.monitoringVerdictTool === true
    ? {
        afterAnswerInstruction: monitoringVerdictAfterAnswerInstruction(),
        instruction: monitoringVerdictReservedInstruction(),
        name: MONITORING_VERDICT_TOOL_NAME,
        textInstruction: monitoringAnswerTextInstruction(),
        // A run admitted before the previous result was recorded counts as a later check, whose `no_update` is hidden.
        textNeeded: (args) => isMonitoringVerdict(args.status) &&
          monitoringVerdictNeedsText(args.status, request.monitoringPreviousResult !== false)
      }
    : null;
}
