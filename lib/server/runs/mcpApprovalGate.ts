import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { resolveMcpRunTool } from "../mcp/toolExecutor";
import {
  MCP_APPROVAL_REQUIRED,
  MCP_APPROVAL_REQUIRED_MESSAGE,
  mcpApprovalRequest,
  mcpCallNeedsApproval,
  type McpApprovalAdmission,
  type McpApprovalRequest
} from "../mcp/writeApproval";
import type { PersistedToolLoopCall, ToolLoopJsonValue } from "./toolLoopPersistence";

/**
 * The write-approval gate of the tool loop. A call its run's admission gates
 * is persisted already settled as an undispatched `mcp_approval_required`
 * error, with the card's pending request, unless an unconsumed one-shot
 * approval of the same call exists; the claim then consumes that approval in
 * its transaction or settles the call gated after all. Recovery derives
 * every decision from persisted rows and never dispatches a gated call.
 */
type GateRow = Pick<PersistedToolLoopCall, "providerCallId" | "result" | "startedAt" | "state" | "toolName">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The approval request of a call the run's admission gates, or undefined. */
export function mcpApprovalRequestForCall(input: Readonly<{
  admission: McpApprovalAdmission | undefined;
  call: Readonly<{ arguments: unknown; name: string }>;
  snapshot: McpRunPlanSnapshot | null | undefined;
}>): McpApprovalRequest | undefined {
  if (!input.admission) return undefined;
  const route = resolveMcpRunTool(input.snapshot ?? undefined, input.call.name);
  if (!route || !mcpCallNeedsApproval({ admission: input.admission, annotations: route.tool.annotations, serverId: route.serverId })) {
    return undefined;
  }
  const annotatedTitle = typeof route.tool.annotations?.title === "string" ? route.tool.annotations.title : undefined;
  return mcpApprovalRequest({ arguments: input.call.arguments, definitionHash: route.tool.definitionHash,
    originalName: route.originalName, serverId: route.serverId, serverName: route.tool.serverName,
    title: route.tool.title ?? annotatedTitle, toolName: input.call.name });
}

/** The persisted result of a gated call: no dispatch, no receipt, no observation. */
export function mcpApprovalRequiredToolCallResult(input: Readonly<{ providerCallId: string; toolName: string }>): ToolLoopJsonValue {
  return {
    callId: input.providerCallId,
    name: input.toolName,
    status: "error",
    content: [{ type: "json", value: { error: MCP_APPROVAL_REQUIRED, message: MCP_APPROVAL_REQUIRED_MESSAGE } }]
  };
}

/**
 * Only the server's own whole combination is a gated call: an error row that
 * never started whose result is exactly the gated form. Tool content naming
 * the code is never a gate.
 */
export function mcpApprovalGated(row: GateRow): boolean {
  const result = row.result;
  if (row.state !== "error" || row.startedAt !== null || !isRecord(result) ||
    Object.keys(result).sort().join(",") !== "callId,content,name,status" ||
    result.callId !== row.providerCallId || result.name !== row.toolName || result.status !== "error" ||
    !Array.isArray(result.content) || result.content.length !== 1) return false;
  const part = result.content[0];
  return isRecord(part) && Object.keys(part).sort().join(",") === "type,value" && part.type === "json" &&
    isRecord(part.value) && Object.keys(part.value).sort().join(",") === "error,message" &&
    part.value.error === MCP_APPROVAL_REQUIRED && part.value.message === MCP_APPROVAL_REQUIRED_MESSAGE;
}
