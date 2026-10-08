import { answerReviewReservedInstruction, answerReviewToolName } from "./answerReview";
import { MONITORING_VERDICT_TOOL_NAME, monitoringVerdictReservedInstruction } from "./monitoringVerdict";

/**
 * The one built-in report a run's admission reserved outside the business
 * tool budgets: a monitoring check's verdict, or an answer review step's
 * review or decisions. Its first call never counts against the budgets and an
 * exhausted budget still offers it once; live execution and recovery derive
 * the same reservation from the accepted request.
 */
export function reservedToolCallForRequest(
  request: Readonly<{ answerReviewStep?: unknown; monitoringVerdictTool?: unknown }>
): Readonly<{ instruction: string; name: string }> | null {
  if (request.monitoringVerdictTool === true) {
    return { instruction: monitoringVerdictReservedInstruction(), name: MONITORING_VERDICT_TOOL_NAME };
  }
  const review = answerReviewToolName(request);
  return review ? { instruction: answerReviewReservedInstruction(review), name: review } : null;
}
