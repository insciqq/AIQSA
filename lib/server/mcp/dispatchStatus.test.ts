import { describe, expect, it } from "vitest";
import type { McpReadiness } from "@/lib/contracts/mcp";
import { observedFailureCode } from "../providers/providerObservability";
import { executionFailure } from "../runs/executionFailure";
import { currentMcpDispatchFailure, isMcpDispatchError, mcpDispatchError } from "./dispatchStatus";
import type { McpRunPlanResult, McpRunPlanSnapshot } from "./runPlan";
import { resolveMcpRunTool } from "./toolExecutor";

const accepted: McpRunPlanSnapshot = {
  servers: [{ fingerprint: "fingerprint-1", revisionId: "revision-1", serverId: "server-1", serverName: "Tasks" }],
  tools: [{
    definitionHash: "a".repeat(64), description: null, inputSchema: { type: "object" }, name: "write",
    namespacedName: "mcp_tasks_write", originalName: "write", serverId: "server-1", serverName: "Tasks"
  }],
  version: 1
};
const route = resolveMcpRunTool(accepted, "mcp_tasks_write")!;

function notReady(readiness: McpReadiness, errorCode: string | null): McpRunPlanResult {
  return { code: "mcp_not_ready", issues: [{ errorCode, name: "Tasks", readiness }], ok: false };
}

function current(overrides: Readonly<{ definitionHash?: string; fingerprint?: string; generationId?: string }> = {}): McpRunPlanResult {
  const fingerprint = overrides.fingerprint ?? "fingerprint-1";
  return {
    bindings: [{ fingerprint, runtimeGenerationId: overrides.generationId ?? "generation-1", serverId: "server-1" }],
    ok: true,
    snapshot: {
      ...accepted,
      servers: accepted.servers.map((server) => ({ ...server, fingerprint })),
      tools: accepted.tools.map((tool) => ({ ...tool, definitionHash: overrides.definitionHash ?? tool.definitionHash }))
    }
  };
}

describe("MCP dispatch causes", () => {
  it.each([
    ["a disabled connection", notReady("disabled", null), "memory_egress_destination_revoked"],
    ["a deleted connection", notReady("unavailable", "mcp_server_unavailable"), "memory_egress_destination_revoked"],
    ["missing configuration", notReady("needs_setup", "configuration_required"), "memory_egress_destination_revoked"],
    ["a connection that needs sign-in", notReady("needs_authorization", "oauth_required"), "mcp_authorization_required"],
    ["a connection that needs sign-in again", notReady("reauthorization_required", "oauth_reauthorization_required"), "mcp_authorization_required"],
    ["a runtime that failed reauthorization", notReady("unavailable", "mcp_oauth_reauthorization_required"), "mcp_authorization_required"],
    ["the owner's switch-off", notReady("unavailable", "mcp_tool_disabled"), "mcp_tool_disabled"],
    ["a tool the runtime no longer offers", notReady("unavailable", "mcp_tool_not_available"), "mcp_accepted_generation_changed"],
    ["a failed runtime", notReady("unavailable", "mcp_health_check_failed"), "mcp_health_check_failed"],
    ["a queued runtime", notReady("queued", null), "mcp_runtime_unavailable"],
    ["a changed fingerprint", current({ fingerprint: "fingerprint-2" }), "mcp_accepted_generation_changed"],
    ["another generation", current({ generationId: "generation-2" }), "mcp_accepted_generation_changed"],
    ["a changed definition", current({ definitionHash: "b".repeat(64) }), "mcp_tool_definition_changed"],
    ["an unavailable plan", null, "mcp_runtime_unavailable"],
    ["the accepted binding", current(), null]
  ] as const)("names %s", (_label, plan, expected) => {
    expect(currentMcpDispatchFailure(plan, route, "generation-1")).toBe(expected);
  });

  it.each(["mcp_tool_disabled", "mcp_tool_definition_changed"] as const)(
    "registers %s as an observable code with its own message", (code) => {
      const error = mcpDispatchError(code);
      expect(observedFailureCode(error)).toBe(code);
      expect(executionFailure(error)).toEqual({ code, message: error.message });
      expect(error.message).not.toBe(mcpDispatchError("mcp_accepted_generation_changed").message);
      expect(isMcpDispatchError(error, code)).toBe(true);
      expect(isMcpDispatchError(error, "mcp_runtime_unavailable")).toBe(false);
      expect(isMcpDispatchError(Object.assign(new Error("PRIVATE"), { message: code }), code)).toBe(false);
    }
  );
});
