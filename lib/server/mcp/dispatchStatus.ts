import { mcpRuntimeErrorCode, mcpRuntimeErrorMessage, type McpRuntimeErrorCode } from "@/lib/contracts/mcp";
import type { McpRunPlanResult } from "./runPlan";
import type { McpRunToolRoute } from "./toolExecutor";

export type McpDispatchFailureCode = McpRuntimeErrorCode | "memory_egress_destination_revoked";

/**
 * Readiness, authority and the accepted binding all block dispatch, each with
 * its own cause: a disabled or deleted connection revokes the destination,
 * lost authorization asks for a reconnect, the owner's switch-off and a
 * changed definition name themselves, and any other change of the accepted
 * tool or generation is a generation change.
 */
export function currentMcpDispatchFailure(
  current: McpRunPlanResult | null,
  route: McpRunToolRoute,
  generationId: string
): McpDispatchFailureCode | null {
  if (!current) return "mcp_runtime_unavailable";
  if (!current.ok) {
    if (current.issues.some((issue) =>
      ["disabled", "needs_setup"].includes(issue.readiness) || issue.errorCode === "mcp_server_unavailable")) {
      return "memory_egress_destination_revoked";
    }
    if (current.issues.some((issue) =>
      ["needs_authorization", "reauthorization_required"].includes(issue.readiness) ||
      issue.errorCode === "mcp_oauth_reauthorization_required")) {
      return "mcp_authorization_required";
    }
    if (current.issues.some((issue) => issue.errorCode === "mcp_tool_disabled")) return "mcp_tool_disabled";
    if (current.issues.some((issue) => issue.errorCode === "mcp_tool_not_available")) return "mcp_accepted_generation_changed";
    return mcpRuntimeErrorCode(current.issues.find((issue) => issue.errorCode)?.errorCode);
  }
  const binding = current.bindings.find((candidate) => candidate.serverId === route.serverId);
  const server = current.snapshot.servers.find((candidate) => candidate.serverId === route.serverId);
  const tool = current.snapshot.tools.find((candidate) => candidate.serverId === route.serverId &&
    candidate.namespacedName === route.tool.namespacedName && candidate.originalName === route.originalName);
  if (!binding || !server || !tool || binding.fingerprint !== route.fingerprint ||
    server.fingerprint !== route.fingerprint || binding.runtimeGenerationId !== generationId) {
    return "mcp_accepted_generation_changed";
  }
  return tool.definitionHash === route.tool.definitionHash ? null : "mcp_tool_definition_changed";
}

export function mcpDispatchError(code: McpDispatchFailureCode): Error {
  return Object.assign(new Error(code === "memory_egress_destination_revoked"
    ? code : mcpRuntimeErrorMessage(code)), { code });
}

/** A refusal built by `mcpDispatchError`, recognized by its own code rather than its message. */
export function isMcpDispatchError(error: unknown, code: McpDispatchFailureCode): boolean {
  return error instanceof Error && Object.hasOwn(error, "code") &&
    (error as Error & { code?: unknown }).code === code;
}
