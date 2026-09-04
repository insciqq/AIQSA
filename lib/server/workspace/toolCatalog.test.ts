import { describe, expect, it } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST } from "@/lib/domain/workspace";
import {
  bindOfficialWorkspaceTools,
  injectWorkspaceToolArguments,
  originalWorkspaceToolName
} from "./toolCatalog";

function officialTools() {
  return WORKSPACE_MCP_TOOL_ALLOWLIST.map((name) => ({
    description: `${name} description`,
    inputSchema: {
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        maxBytes: { type: "number" },
        timeoutMs: { type: "number" },
        ...(["sandbox_exec_poll", "sandbox_exec_write_stdin", "sandbox_exec_signal", "sandbox_exec_close"].includes(name)
          ? { execSessionId: { type: "string" } }
          : { name: { type: "string" } }),
        ...(name === "sandbox_fs_copy" ? { toSandbox: { type: "string" } } : {})
      },
      required: [
        ...(["sandbox_exec_poll", "sandbox_exec_write_stdin", "sandbox_exec_signal", "sandbox_exec_close"].includes(name)
          ? ["execSessionId"]
          : ["name"])
      ],
      type: "object"
    },
    name
  }));
}

describe("official Microsandbox MCP binding", () => {
  it("requires the complete allowlist and strips model-controlled identities", () => {
    const catalog = bindOfficialWorkspaceTools({
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      tools: officialTools()
    });
    expect(catalog.tools).toHaveLength(16);
    expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/u);
    for (const tool of catalog.tools) {
      expect(tool.inputSchema).not.toHaveProperty("properties.name");
      expect(tool.inputSchema).not.toHaveProperty("properties.toSandbox");
      expect(tool.inputSchema).not.toHaveProperty("properties.maxBytes");
      expect(tool.inputSchema).not.toHaveProperty("properties.timeoutMs");
      expect(tool.inputSchema.required).not.toContain("name");
      expect(originalWorkspaceToolName(catalog, tool.namespacedName)).toBe(tool.originalName);
    }
    expect(() => bindOfficialWorkspaceTools({
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      tools: officialTools().slice(1)
    })).toThrow("workspace_tool_catalog_incomplete");
  });

  it("injects the bound sandbox and rejects every model-supplied selector", () => {
    expect(injectWorkspaceToolArguments({
      arguments: { command: "pwd" },
      originalName: "sandbox_shell",
      sandboxName: "aiqsa-ws-opaque"
    })).toEqual({ command: "pwd", name: "aiqsa-ws-opaque" });
    expect(injectWorkspaceToolArguments({
      arguments: { execSessionId: "exec-1" },
      originalName: "sandbox_exec_poll",
      sandboxName: "aiqsa-ws-opaque"
    })).toEqual({ execSessionId: "exec-1" });
    for (const key of ["name", "sandbox", "sandboxId", "sandboxName", "toSandbox"]) {
      expect(() => injectWorkspaceToolArguments({
        arguments: { [key]: "other" },
        originalName: "sandbox_fs_copy",
        sandboxName: "aiqsa-ws-opaque"
      })).toThrow("workspace_tool_identity_forbidden");
    }
  });
});
