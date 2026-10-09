import { isWorkspaceOperationFailureCode, workspaceOperationFailureMessage } from "@/lib/contracts/workspaceFailure";
import { mcpRuntimeErrorCode, mcpRuntimeErrorMessage } from "@/lib/contracts/mcp";
import { observedFailureWithoutHttpClass } from "../providers/providerObservability";
import { runSettlementFailure } from "./settlementFailure";
import { observationFailure } from "../toolObservations/contract";
import { imageInputFailure } from "../images/inputError";

/** The code is evidence; arbitrary exception prose is never tool guidance.
 * Tool results keep `tool_call_failed` for a status-only provider HTTP failure:
 * callers branch on it, and provider HTTP classes name run failures only. */
export function executionFailure(error: unknown): Readonly<{ code: string; message: string }> {
  const imageInput = imageInputFailure(error);
  if (imageInput) return imageInput;
  const observation = observationFailure(error);
  if (observation) return observation;
  const settlement = runSettlementFailure(error);
  if (settlement) return settlement;
  const observed = observedFailureWithoutHttpClass(error);
  const code = observed.code === "unknown" ? "tool_call_failed" : observed.code;
  if (isWorkspaceOperationFailureCode(code)) return { code, message: workspaceOperationFailureMessage(code) };
  if (mcpRuntimeErrorCode(code) === code) return { code, message: mcpRuntimeErrorMessage(code) };
  return { code, message: "The tool call failed without a confirmed specific cause. Do not repeat an uncertain action." };
}
