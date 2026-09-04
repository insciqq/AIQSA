import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_BOUND_TOOL_CATALOG_HASH,
  bindOfficialWorkspaceTools
} from "./toolCatalog";

describe("pinned official Microsandbox MCP catalog", () => {
  it("matches the reviewed provider-facing schema hash", async () => {
    const transport = new StdioClientTransport({
      args: [join(process.cwd(), "node_modules", "microsandbox-mcp", "bin", "microsandbox-mcp.js")],
      command: process.execPath,
      stderr: "pipe"
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "aiqsa-workspace-catalog-test", version: "1" });
    try {
      await client.connect(transport);
      const response = await client.listTools();
      const version = client.getServerVersion()?.version;
      expect(version).toBe("0.6.16");
      const catalog = bindOfficialWorkspaceTools({
        mcpVersion: version ?? "",
        runtimeVersion: "0.6.16",
        tools: response.tools.map((tool) => ({
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          name: tool.name
        }))
      });
      expect(catalog.hash).toBe(WORKSPACE_BOUND_TOOL_CATALOG_HASH);
    } finally {
      await transport.close();
    }
  });
});
