import type { McpReadiness, UserMcpServer } from "@/lib/contracts/mcp";

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
  unavailable: { kind: "failed", label: "Activation failed" }
};

export function mcpReadinessPresentation(readiness: McpReadiness): McpReadinessPresentation {
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
  return servers.some((server) => server.enabled &&
    (server.operationalStatus === "checking" || isMcpReadinessTransitioning(server.readiness)));
}

export function mcpOperationalPresentation(server: UserMcpServer): McpReadinessPresentation {
  if (server.operationalStatus === "active") return { kind: "ready", label: "Active" };
  if (server.operationalStatus === "checking") return { kind: "progress", label: "Checking" };
  return { kind: "disabled", label: "Inactive" };
}
