import { describe, expect, it } from "vitest";
import {
  auditCodexJsonEvents,
  codexAgentMessageContains,
  codexLbOverridesFromConfig,
  databaseUrlForOwnedSmoke,
  findAuthorizationUrl,
  ownedMemoryMcpSmokeDatabaseName,
  parseCodexMcpList,
  parseDisposableAdminDatabaseUrl,
  parseInspectorInitialize,
  parseInspectorToolNames
} from "./memory-mcp-codex-smoke-support";

describe("Personal Memory MCP Codex smoke support", () => {
  it("admits only an explicitly acknowledged loopback disposable admin database", () => {
    const admin = parseDisposableAdminDatabaseUrl(
      "DISPOSABLE",
      "postgresql://aiqsa:dev@127.0.0.1:5432/postgres"
    );
    const name = ownedMemoryMcpSmokeDatabaseName("abcdef123456");
    expect(databaseUrlForOwnedSmoke(admin, name)).toBe(
      "postgresql://aiqsa:dev@127.0.0.1:5432/aiqsa_memory_mcp_e2e_abcdef123456?schema=public"
    );
    expect(parseDisposableAdminDatabaseUrl(
      "DISPOSABLE",
      "postgresql://aiqsa:dev@127.0.0.1:55433/postgres"
    ).port).toBe("55433");
    expect(() => parseDisposableAdminDatabaseUrl(
      undefined,
      "postgresql://aiqsa:dev@127.0.0.1:5432/postgres"
    )).toThrow("memory_mcp_smoke_disposable_opt_in_required");
    expect(() => parseDisposableAdminDatabaseUrl(
      "DISPOSABLE",
      "postgresql://aiqsa:dev@db.example:5432/postgres"
    )).toThrow("memory_mcp_smoke_admin_database_not_disposable");
  });

  it("extracts only the reviewed codex-lb provider from user config", () => {
    const result = codexLbOverridesFromConfig(`
model = "gpt-5.6-luna"
model_provider = "codex-lb"
[model_providers.codex-lb]
name = "Codex LB"
base_url = "http://127.0.0.1:2455/v1"
wire_api = "responses"
supports_websockets = false
env_key = "CODEX_LB_API_KEY"
requires_openai_auth = false
[mcp_servers.other]
url = "https://unrelated.example/mcp"
`);
    expect(result.configuredModel).toBe("gpt-5.6-luna");
    expect(result.args.join(" ")).toContain("model_providers.codex-lb.base_url");
    expect(result.args.join(" ")).not.toContain("unrelated.example");
  });

  it("audits successful Memory calls while rejecting shell and foreign MCP calls", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", server: "test", tool: "search_memories", arguments: { query: "What should I call you?" }, result: { structuredContent: { items: [{ memoryRef: "mcm1.synthetic-ref", text: "synthetic-marker" }] } } } },
      { type: "item.completed", item: { type: "command_execution", command: "pwd" } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "other", tool: "get_memory" } }
    ].map((event) => JSON.stringify(event)).join("\n");
    const audit = auditCodexJsonEvents({
      events,
      evidenceNeedles: { recall: "synthetic-marker" },
      expectedServer: "test"
    });
    expect(audit.completedTools).toEqual(["search_memories", "get_memory"]);
    expect(audit.evidence).toEqual({ recall: true });
    expect(audit.forbiddenItemTypes).toEqual(["command_execution"]);
    expect(audit.foreignMcpCalls).toBe(1);
    expect(audit.capturedSearchCalls).toEqual([{
      limit: null,
      memoryRefs: ["mcm1.synthetic-ref"],
      query: "What should I call you?"
    }]);
  });

  it("captures completed search arguments and refs from JSON text without retaining results", () => {
    const events = JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "test",
        tool: "search_memories",
        input: JSON.stringify({ query: "  Who am I?  " }),
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              items: [{ memoryRef: "mcm1.ref-from-text", text: "private fact" }]
            })
          }]
        }
      }
    });
    const audit = auditCodexJsonEvents({ events, expectedServer: "test" });
    expect(audit.capturedSearchCalls).toEqual([{
      limit: null,
      memoryRefs: ["mcm1.ref-from-text"],
      query: "Who am I?"
    }]);
    expect(audit.toolCalls).toEqual([{
      errorCodes: [],
      status: "COMPLETED",
      tool: "search_memories"
    }]);
  });

  it("reports only allowlisted stable error codes for failed Memory calls", () => {
    const events = JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "test",
        tool: "get_memory",
        status: "failed",
        result: {
          content: [{ text: '{"error":"memory_not_found","detail":"private"}' }]
        }
      }
    });
    const audit = auditCodexJsonEvents({ events, expectedServer: "test" });
    expect(audit.failedTools).toEqual(["get_memory"]);
    expect(audit.toolCalls).toEqual([{
      errorCodes: ["memory_not_found"],
      status: "FAILED",
      tool: "get_memory"
    }]);
    expect(audit.toolErrorCodes).toEqual({ get_memory: ["memory_not_found"] });
    expect(JSON.stringify(audit)).not.toContain("private");
  });

  it("recognizes answer evidence only in completed Codex agent messages", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", result: "Cedar Finch" } },
      { type: "item.completed", item: { type: "agent_message", text: "Your name is Cedar Finch." } }
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(codexAgentMessageContains(events, "cedar finch")).toBe(true);
    expect(codexAgentMessageContains(events, "another name")).toBe(false);
    expect(codexAgentMessageContains(
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", result: "Cedar Finch" }
      }),
      "Cedar Finch"
    )).toBe(false);
  });

  it("parses only bounded client/protocol projections and finds the local auth URL", () => {
    expect(parseCodexMcpList(JSON.stringify([{
      name: "memory",
      transport: { type: "streamable_http", url: "http://127.0.0.1/mcp" },
      auth_status: "oauth",
      enabled: true
    }]))).toEqual([{
      authStatus: "oauth",
      enabled: true,
      name: "memory",
      transportType: "streamable_http"
    }]);
    expect(findAuthorizationUrl(
      "Open http://127.0.0.1:3000/oauth/authorize?state=opaque",
      "http://127.0.0.1:3000"
    )).toContain("/oauth/authorize");
    expect(parseInspectorInitialize(JSON.stringify({
      result: { protocolVersion: "2026-07-28", serverInfo: {} }
    }))).toEqual({ protocolVersion: "2026-07-28" });
    expect(parseInspectorToolNames(JSON.stringify({
      result: { tools: [{ name: "add_memory" }, { name: "search_memories" }] }
    }))).toEqual(["add_memory", "search_memories"]);
  });
});
