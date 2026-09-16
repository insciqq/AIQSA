// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import type { createAgentRunStore } from "./store";
import { createAgentMcpGateway } from "./mcpGateway";

vi.mock("../prisma", () => ({ prisma: {} }));
describe("Agent MCP discovery surface", () => {
  it.each(["off", "auto", "all"] as const)("exposes selected Search immediately in MCP %s without loading external tools in Auto", async (mcpMode) => {
    const store = { mcpTools: async () => [], admitMcpPlan: async () => {} } as unknown as ReturnType<typeof createAgentRunStore>;
    const request = { agent: { mcpMode }, searchPlan: { mode: "all_selected", options: [{
      adapterKind: "provider_model_client", config: {}, optionId: "selected", displayName: "Selected source"
    }] }, mcp: { tools: [], servers: [], version: 1 } } as unknown as NormalizedRunRequest;
    const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
      signal: new AbortController().signal, onActivity: async () => {}, onFailure: async () => {}, onUsage: async () => {} });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : text);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort())
      .toEqual(mcpMode === "auto" ? ["aiqsa_search", "call_tool", "find_tools"] : ["aiqsa_search"]);
  });
});
