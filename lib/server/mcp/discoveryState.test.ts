import { describe, expect, it } from "vitest";
import { decodeMcpDiscoveryState, mcpDiscoveryUnavailableServers } from "./discoveryState";

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

  it("keeps an epoch's unavailable servers and reads an absent set as none", () => {
    const unavailable = [{ reason: "mcp_reauthorization_required", serverId: "server-jira" }];
    const withSet = { ...valid, epochs: [{ ...valid.epochs[0], unavailable }] };
    expect(decodeMcpDiscoveryState(withSet)).toEqual(withSet);
    // An empty set is canonical absence.
    expect(decodeMcpDiscoveryState({ ...valid, epochs: [{ ...valid.epochs[0], unavailable: [] }] })).toEqual(valid);
    expect(decodeMcpDiscoveryState(valid)?.epochs[0]).not.toHaveProperty("unavailable");
  });

  it.each([
    [[{ reason: "mcp_server_unavailable", serverId: "server-unknown" }]],
    [[{ reason: "PRIVATE_UPSTREAM_TEXT", serverId: "server-jira" }]],
    [[{ reason: "mcp_server_unavailable", serverId: "server-jira" }, { reason: "mcp_plan_too_large", serverId: "server-jira" }]],
    [[{ reason: "mcp_server_unavailable", serverId: "server-jira", serverName: "Jira" }]],
    [Array.from({ length: 6 }, () => ({ reason: "mcp_server_unavailable", serverId: "server-jira" }))],
    [{ reason: "mcp_server_unavailable", serverId: "server-jira" }]
  ])("rejects a malformed unavailable set", (unavailable) => {
    expect(decodeMcpDiscoveryState({ ...valid, epochs: [{ ...valid.epochs[0], unavailable }] })).toBeNull();
  });

  it("projects a call's unavailable servers by catalog name and never fails the reader", () => {
    const discovery = { ...valid, epochs: [{ ...valid.epochs[0], unavailable: [
      { reason: "mcp_personal_credential_rejected", serverId: "server-jira" },
      { reason: "mcp_server_unavailable", serverId: "server-gone" },
      { reason: "PRIVATE", serverId: "server-jira" }
    ] }] };
    expect(mcpDiscoveryUnavailableServers(discovery, "persisted-find-tools-call")).toEqual([
      { reason: "mcp_personal_credential_rejected", serverName: "Jira" }
    ]);
    expect(mcpDiscoveryUnavailableServers(discovery, "another-call")).toEqual([]);
    expect(mcpDiscoveryUnavailableServers(valid, "persisted-find-tools-call")).toEqual([]);
    expect(mcpDiscoveryUnavailableServers({ epochs: "x" }, "persisted-find-tools-call")).toEqual([]);
    expect(mcpDiscoveryUnavailableServers(null, "persisted-find-tools-call")).toEqual([]);
  });
});
