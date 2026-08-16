import { describe, expect, it } from "vitest";
import {
  mcpCatalogToolsByNames,
  mcpFindToolsArguments,
  mergeMcpRunPlanSnapshots
} from "./discovery";
import type { McpCapabilityCatalog, McpRunPlanSnapshot } from "./runPlan";

const catalog: McpCapabilityCatalog = {
  servers: [{
    description: "Issue tracking and sprint planning",
    namespace: "jira",
    revisionId: "revision-jira",
    serverId: "server-jira",
    serverName: "Jira",
    tools: [{
      description: "Create an issue in a project",
      namespacedName: "mcp_jira_create_issue_1",
      originalName: "create_issue",
      title: "Create issue"
    }, {
      description: "Read the current sprint",
      namespacedName: "mcp_jira_read_sprint_1",
      originalName: "read_sprint"
    }]
  }, {
    description: "Source code hosting",
    namespace: "github",
    revisionId: "revision-github",
    serverId: "server-github",
    serverName: "GitHub",
    tools: [{
      description: "Create a pull request",
      namespacedName: "mcp_github_create_pull_request_1",
      originalName: "create_pull_request"
    }]
  }],
  version: 1
};

function snapshot(toolName: string, index: number): McpRunPlanSnapshot {
  const serverId = `server-${index}`;
  return {
    servers: [{
      fingerprint: `fingerprint-${index}`,
      revisionId: `revision-${index}`,
      serverId,
      serverName: `Server ${index}`
    }],
    tools: [{
      definitionHash: index.toString(16).padStart(64, "0"),
      description: `Tool ${index}`,
      inputSchema: { type: "object" },
      name: toolName,
      namespacedName: `mcp_server_${toolName}_${index}`,
      originalName: toolName,
      serverId,
      serverName: `Server ${index}`
    }],
    version: 1
  };
}

describe("MCP Auto discovery", () => {
  it("keeps the frozen capability catalog schema-free", () => {
    expect(JSON.stringify(catalog)).not.toContain("inputSchema");
    expect(mcpCatalogToolsByNames(catalog, ["mcp_jira_create_issue_1"])[0]).toMatchObject({
      revisionId: "revision-jira",
      serverId: "server-jira"
    });
  });

  it("strictly validates the internal discovery call arguments", () => {
    expect(mcpFindToolsArguments({ goal: "  create issue  " })).toEqual({ goal: "create issue" });
    expect(mcpFindToolsArguments({ goal: "issue", limit: 1 })).toBeNull();
    expect(mcpFindToolsArguments({ goal: "issue", unexpected: true })).toBeNull();
    expect(mcpFindToolsArguments({ goal: "" })).toBeNull();
    expect(mcpFindToolsArguments({ query: "legacy query" })).toBeNull();
  });

  it("reconstructs an already checkpointed result without schemas or reranking", () => {
    expect(mcpCatalogToolsByNames(catalog, [
      "mcp_github_create_pull_request_1",
      "mcp_jira_create_issue_1"
    ])).toEqual([
      expect.objectContaining({
        namespacedName: "mcp_github_create_pull_request_1",
        revisionId: "revision-github"
      }),
      expect.objectContaining({
        namespacedName: "mcp_jira_create_issue_1",
        revisionId: "revision-jira"
      })
    ]);
  });

  it("grows an immutable run snapshot monotonically beyond the former 12-tool bound", () => {
    const first = snapshot("first", 1);
    const second = snapshot("second", 2);
    const merged = mergeMcpRunPlanSnapshots(first, second);

    expect(merged.tools.map((tool) => tool.originalName)).toEqual(["first", "second"]);
    expect(first.tools).toHaveLength(1);

    let current: McpRunPlanSnapshot | undefined;
    for (let index = 0; index < 13; index += 1) {
      current = mergeMcpRunPlanSnapshots(current, snapshot(`tool_${index}`, index + 10));
    }
    expect(current?.tools).toHaveLength(13);
  });

  it("keeps cumulative discovered schemas inside the run-plan byte bound", () => {
    const largeSchema = { description: "x".repeat(300_000), type: "string" };
    const first = snapshot("first", 1);
    const second = snapshot("second", 2);

    expect(() => mergeMcpRunPlanSnapshots(
      {
        ...first,
        tools: first.tools.map((tool) => ({ ...tool, inputSchema: largeSchema }))
      },
      {
        ...second,
        tools: second.tools.map((tool) => ({ ...tool, inputSchema: largeSchema }))
      }
    )).toThrow("mcp_plan_too_large");
  });
});
