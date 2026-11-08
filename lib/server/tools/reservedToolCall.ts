import {
  MONITORING_VERDICT_TOOL_NAME,
  monitoringVerdictAfterAnswerInstruction,
  monitoringVerdictReservedInstruction
} from "./monitoringVerdict";

/**
 * The one built-in report a run's admission reserved outside the business
 * tool budgets: a monitoring check's verdict. Its first call never counts
 * against the budgets and an exhausted budget still offers it once, as does an
 * answer written without it (`afterAnswerInstruction`); live execution and
 * recovery derive the same reservation from the accepted request.
 */
export function reservedToolCallForRequest(
  request: Readonly<{ monitoringVerdictTool?: unknown }>
): Readonly<{ afterAnswerInstruction: string; instruction: string; name: string }> | null {
  return request.monitoringVerdictTool === true
    ? {
        afterAnswerInstruction: monitoringVerdictAfterAnswerInstruction(),
        instruction: monitoringVerdictReservedInstruction(),
        name: MONITORING_VERDICT_TOOL_NAME
      }
    : null;
}
