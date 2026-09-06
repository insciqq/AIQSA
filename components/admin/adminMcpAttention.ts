import type { AdminMcpServer } from "@/lib/contracts/mcp";

export function adminMcpAttention(server: AdminMcpServer) {
  if (server.archivedAt) return null;
  if (server.draft.auth.mode === "oauth" && server.validationOAuth?.state === "disconnecting") {
    return { action: "View connection", href: null, label: "Disconnecting authorization", task: "validation" as const };
  }
  if (server.draft.auth.mode === "oauth" && server.validationOAuth?.state !== "ready") {
    const reconnect = server.validationOAuth?.state === "reauthorization_required";
    return {
      action: reconnect ? "Reconnect" : "Connect",
      href: `/api/admin/mcp/${encodeURIComponent(server.id)}/oauth/validation/${reconnect ? "reconnect" : "connect"}`,
      label: reconnect ? "Reconnect to check changes" : "Authorization required to check changes",
      task: "validation" as const
    };
  }
  if (server.activation?.stage === "failed") {
    return { action: "Review and retry", href: null, label: "Settings check failed", task: "validation" as const };
  }
  if (server.activeRevision?.artifactStatus === "missing" || server.runtimeProblem) {
    return {
      action: "Review connection", href: null,
      label: server.runtimeProblem === "reauthorization_required"
        ? "A user connection needs reconnecting" : "MCP runtime unavailable",
      task: "runtime" as const
    };
  }
  return null;
}
