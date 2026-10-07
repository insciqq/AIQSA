import { describe, expect, it } from "vitest";
import { decodeThreadWorkspaceActivityCodeMcp } from "@/lib/contracts/workspace";
import { summarizeWorkspaceCodeCalls, workspaceCodeCallActivity, workspaceCodeCallSummaryLine } from "./codeMcpSummary";

const labels = new Map([
  ["mcp_gitlab_list_commits_0000000000", { serverName: "GitLab", toolName: "list_commits" }],
  ["mcp_gitlab_get_job_log_1111111111", { serverName: "GitLab", toolName: "get_job_log" }]
]);

describe("code MCP call summary", () => {
  it("renders one compact, content-free line per command", () => {
    const summary = summarizeWorkspaceCodeCalls([
      { count: 35, errorCode: null, state: "complete", toolName: "mcp_gitlab_list_commits_0000000000" },
      { count: 1, errorCode: null, state: "complete", toolName: "mcp_gitlab_get_job_log_1111111111" },
      { count: 1, errorCode: "upstream_unavailable", state: "error", toolName: "mcp_gitlab_get_job_log_1111111111" }
    ], 0, labels)!;
    expect(workspaceCodeCallSummaryLine(summary)).toBe(
      "code made 37 MCP calls: GitLab.list_commits ×35, GitLab.get_job_log ×2 (1 failed: upstream_unavailable)");
    expect(workspaceCodeCallActivity(summary)).toEqual({ calls: 37, failed: 1, tools: [
      { calls: 35, failed: 0, serverName: "GitLab", toolName: "list_commits" },
      { calls: 2, failed: 1, serverName: "GitLab", toolName: "get_job_log" }
    ] });
    expect(decodeThreadWorkspaceActivityCodeMcp(workspaceCodeCallActivity(summary))).toEqual(workspaceCodeCallActivity(summary));
  });

  it("names unknown outcomes and budget refusals, and bounds the listed tools", () => {
    const groups = Array.from({ length: 10 }, (_, index) => ({
      count: 10 - index, errorCode: null, state: index === 0 ? "unknown" : "complete", toolName: `mcp_tool_${index}`
    }));
    const summary = summarizeWorkspaceCodeCalls(groups, 3, new Map())!;
    const line = workspaceCodeCallSummaryLine(summary);
    expect(line).toMatch(/^code made 55 MCP calls: mcp_tool_0 ×10 \(10 outcome unknown, do not repeat writes\), /u);
    expect(line).toContain(", +2 more tools; 3 more refused: the run's code MCP call budget is exhausted");
    expect(workspaceCodeCallActivity(summary)).toMatchObject({ calls: 55, failed: 10, refused: 3 });
    expect(workspaceCodeCallActivity(summary).tools).toHaveLength(8);
    expect(workspaceCodeCallSummaryLine(summarizeWorkspaceCodeCalls([], 2, new Map())!))
      .toBe("code made no MCP calls; 2 more refused: the run's code MCP call budget is exhausted");
    expect(summarizeWorkspaceCodeCalls([], 0, new Map())).toBeNull();
  });

  it("keeps only stable error codes", () => {
    const summary = summarizeWorkspaceCodeCalls([
      { count: 1, errorCode: "Bearer secret value", state: "error", toolName: "mcp_x" },
      { count: 1, errorCode: "authorization_required", state: "error", toolName: "mcp_x" }
    ], 0, new Map())!;
    expect(workspaceCodeCallSummaryLine(summary)).toBe("code made 2 MCP calls: mcp_x ×2 (2 failed: authorization_required)");
  });
});
