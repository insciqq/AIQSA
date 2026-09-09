import { mcpRuntimeErrorCode, mcpRuntimeErrorMessage, type McpRuntimeErrorCode } from "@/lib/contracts/mcp";
import type { McpRunPlanResult } from "./runPlan";
import type { McpRunToolRoute } from "./toolExecutor";

export type McpDispatchFailureCode = McpRuntimeErrorCode | "memory_egress_destination_revoked";

/** Readiness and authority both block dispatch, but are different failures. */
export function currentMcpDispatchFailure(
  current: McpRunPlanResult | null,
  route: McpRunToolRoute,
  generationId: string
): McpDispatchFailureCode | null {
  if (!current) return "mcp_runtime_unavailable";
  if (!current.ok) {
    if (current.issues.some((issue) =>
      ["disabled", "needs_setup", "needs_authorization", "reauthorization_required"].includes(issue.readiness) ||
      ["mcp_server_unavailable", "mcp_oauth_reauthorization_required"].includes(issue.errorCode ?? ""))) {
      return "memory_egress_destination_revoked";
    }
    if (current.issues.some((issue) => issue.errorCode === "mcp_tool_not_available")) return "mcp_accepted_generation_changed";
    return mcpRuntimeErrorCode(current.issues.find((issue) => issue.errorCode)?.errorCode);
  }
  const binding = current.bindings.find((candidate) => candidate.serverId === route.serverId);
  const server = current.snapshot.servers.find((candidate) => candidate.serverId === route.serverId);
  const tool = current.snapshot.tools.find((candidate) => candidate.serverId === route.serverId &&
    candidate.namespacedName === route.tool.namespacedName && candidate.originalName === route.originalName);
  return binding && server && tool && binding.fingerprint === route.fingerprint &&
    server.fingerprint === route.fingerprint && binding.runtimeGenerationId === generationId &&
    tool.definitionHash === route.tool.definitionHash
    ? null : "mcp_accepted_generation_changed";
}

export function mcpDispatchError(code: McpDispatchFailureCode): Error {
  return Object.assign(new Error(code === "memory_egress_destination_revoked"
    ? code : mcpRuntimeErrorMessage(code)), { code });
}
