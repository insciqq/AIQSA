import { isWorkspaceOperationFailureCode, workspaceOperationFailureMessage } from "@/lib/contracts/workspaceFailure";
import { isMcpDiscoveryFailureMessage } from "@/lib/contracts/mcpDiscoveryFailure";
import { mcpRuntimeErrorCode, mcpRuntimeErrorMessage } from "@/lib/contracts/mcp";
import { observedFailure } from "../providers/providerObservability";
import { runSettlementFailure } from "./settlementFailure";

/** The code is evidence; arbitrary exception prose is never tool guidance. */
export function executionFailure(error: unknown): Readonly<{ code: string; message: string }> {
  const settlement = runSettlementFailure(error);
  if (settlement) return settlement;
  const observed = observedFailure(error);
  const code = observed.code === "unknown" ? "tool_call_failed" : observed.code;
  if (isWorkspaceOperationFailureCode(code)) return { code, message: workspaceOperationFailureMessage(code) };
  if (mcpRuntimeErrorCode(code) === code) return { code, message: mcpRuntimeErrorMessage(code) };
  if (error instanceof Error && isMcpDiscoveryFailureMessage(error.message)) return { code, message: error.message };
  return { code, message: "The tool call failed without a confirmed specific cause. Do not repeat an uncertain action." };
}
