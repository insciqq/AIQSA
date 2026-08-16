import { describe, expect, it } from "vitest";
import { decodeMcpDiscoveryState } from "./discoveryState";

const toolId = "mcp_jira_create_issue_1234567890";
const valid = {
  catalog: {
    servers: [{
      description: "Issue tracking",
      namespace: "jira",
      revisionId: "revision-jira",
      serverId: "server-jira",
      serverName: "Jira",
      tools: [{
        arguments: [{ description: "Issue title", name: "title", types: ["string"] }],
        description: "Create an issue",
        namespacedName: toolId,
        originalName: "create_issue"
      }]
    }],
    version: 1
  },
  epochs: [{
    epoch: 1,
    goal: "create an issue",
    modelRunToolCallId: "persisted-find-tools-call",
    roundIndex: 0,
    toolIds: [toolId]
  }],
  version: 2
};

describe("MCP discovery state decoder", () => {
  it("accepts the exact schema-free v2 checkpoint", () => {
    expect(decodeMcpDiscoveryState(valid)).toEqual(valid);
    expect(JSON.stringify(valid)).not.toContain("inputSchema");
  });

  it.each([
    [{ ...valid, version: 1 }],
    [{ ...valid, unexpected: true }],
    [{
      ...valid,
      epochs: [...valid.epochs, { ...valid.epochs[0], epoch: 2 }]
    }],
    [{
      ...valid,
      epochs: [{ ...valid.epochs[0], toolIds: ["unknown-tool"] }]
    }],
    [{
      ...valid,
      catalog: {
        ...valid.catalog,
        servers: [{
          ...valid.catalog.servers[0],
          tools: [{ ...valid.catalog.servers[0]!.tools[0], inputSchema: { type: "object" } }]
        }]
      }
    }]
  ])("rejects malformed, ambiguous, or schema-bearing persisted state", (candidate) => {
    expect(decodeMcpDiscoveryState(candidate)).toBeNull();
  });
});
