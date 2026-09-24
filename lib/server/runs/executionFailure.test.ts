import { describe, expect, it } from "vitest";
import { executionFailure } from "./executionFailure";
import { RunSettlementError } from "./settlementFailure";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { mcpDispatchError } from "../mcp/dispatchStatus";

describe("safe execution failure projection", () => {
  it.each(["workspace_path_not_found", "workspace_request_invalid", "workspace_path_access_denied", "workspace_session_lost", "workspace_tool_timeout", "workspace_tool_outcome_unknown"] as const)("retains confirmed %s without exception prose", code => {
    const error = new WorkspaceRuntimeError(code);
    error.message = "PRIVATE Authorization bearer signed-url /host/path";
    expect(executionFailure(error)).toMatchObject({ code });
    expect(JSON.stringify(executionFailure(error))).not.toContain("PRIVATE");
  });
  it("keeps opaque errors generic and exact MCP authority distinct from liveness", () => {
    expect(executionFailure(new Error("EACCES missing timeout PRIVATE"))).toMatchObject({ code: "tool_call_failed" });
    expect(executionFailure(mcpDispatchError("mcp_tool_access_denied"))).toMatchObject({ code: "mcp_tool_access_denied", message: expect.stringContaining("access") });
    expect(executionFailure(mcpDispatchError("mcp_session_closed"))).toMatchObject({ code: "mcp_session_closed", message: expect.stringContaining("session") });
    expect(JSON.stringify(executionFailure(Object.assign(new Error("PRIVATE"), { code: "PRIVATE" })))).not.toContain("PRIVATE");
  });
  it("identifies internal settlement separately from provider failure", () => {
    const value = executionFailure(new RunSettlementError("accounting", new Error("PRIVATE")));
    expect(value).toMatchObject({ code: "run_usage_persistence_failed" });
    expect(value.message).not.toContain("PRIVATE");
  });
});
