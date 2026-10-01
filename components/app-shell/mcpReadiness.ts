import { mcpRuntimeErrorMessage, type McpReadiness, type UserMcpServer } from "@/lib/contracts/mcp";

export type McpReadinessPresentation = Readonly<{
  kind: "attention" | "disabled" | "failed" | "progress" | "ready";
  label: string;
}>;

const presentations: Record<McpReadiness, McpReadinessPresentation> = {
  authorizing: { kind: "progress", label: "Authorizing" },
  disabled: { kind: "disabled", label: "Disabled" },
  idle: { kind: "ready", label: "Available on demand" },
  needs_authorization: { kind: "attention", label: "Needs authorization" },
  needs_setup: { kind: "attention", label: "Needs setup" },
  queued: { kind: "progress", label: "Activating" },
  ready: { kind: "ready", label: "Ready" },
  reauthorization_required: { kind: "attention", label: "Reconnect required" },
  restarting: { kind: "progress", label: "Restarting" },
  starting: { kind: "progress", label: "Starting runtime" },
  unavailable: { kind: "failed", label: "Runtime unavailable" }
};

/**
 * Copy for the registry runtime codes the local-network and tool-continuity
 * contracts add; every other code keeps the shared contract message.
 */
const registryRuntimeMessages: Readonly<Record<string, string>> = {
  mcp_internal_address_forbidden: "This address belongs to AIQSA itself, so MCP cannot use it.",
  mcp_local_network_disabled: "The administrator turned off MCP connections to the local network.",
  mcp_tool_definition_changed: "An MCP tool changed. Start a new request to use the current tool.",
  mcp_tool_disabled: "This MCP tool is switched off. Switch it on in Settings → Connections, then start a new request."
};

export function mcpRuntimeFailureMessage(code: string): string {
  return Object.hasOwn(registryRuntimeMessages, code) ? registryRuntimeMessages[code]! : mcpRuntimeErrorMessage(code);
}

export function mcpReadinessPresentation(readiness: McpReadiness, runtimeErrorCode?: string | null): McpReadinessPresentation {
  if (readiness === "unavailable" && runtimeErrorCode) return { kind: "failed", label: mcpRuntimeFailureMessage(runtimeErrorCode) };
  return presentations[readiness];
}

export function mcpSetupAttention(server: Pick<UserMcpServer, "fields" | "oauthState" | "readiness">) {
  if (server.fields.some((field) => !field.configured)) return "needs_setup" as const;
  if (server.oauthState === "reauthorization_required") return "reauthorization_required" as const;
  if (server.oauthState === "disconnected") return "needs_authorization" as const;
  if (server.readiness === "needs_setup" || server.readiness === "needs_authorization" ||
    server.readiness === "reauthorization_required" || server.readiness === "unavailable") {
    return server.readiness;
  }
  return null;
}

export function isMcpReadinessTransitioning(readiness: McpReadiness): boolean {
  return presentations[readiness].kind === "progress";
}

export function hasTransitioningMcpServer(servers: readonly UserMcpServer[]): boolean {
  return servers.some((server) => server.enabled && isMcpReadinessTransitioning(server.readiness));
}
