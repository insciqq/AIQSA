import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST } from "@/lib/domain/workspace";
import { resolveRuntimeModulePath } from "../runtimeModulePath";
import {
  bindOfficialWorkspaceTools,
  injectWorkspaceToolArguments,
  namespacedWorkspaceToolNameFromOriginal,
  normalizeWorkspaceProviderToolName,
  originalWorkspaceToolName,
  WORKSPACE_BOUND_TOOL_CATALOG_HASH,
  workspaceHiddenArgumentRefusal
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
        ...(name === "sandbox_fs_copy" ? { toSandbox: { type: "string" } } : {}),
        ...(["sandbox_exec", "sandbox_shell", "sandbox_exec_start"].includes(name)
          ? { rlimits: { items: { type: "object" }, type: "array" } }
          : {})
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
  it("keeps original Workspace names as strict aliases of advertised names", () => {
    const shellName = namespacedWorkspaceToolNameFromOriginal("sandbox_shell");
    expect(shellName).toBe("mcp_workspace_sandbox_shell_596319da11");
    expect(namespacedWorkspaceToolNameFromOriginal("unknown_tool")).toBeNull();
    expect(normalizeWorkspaceProviderToolName("sandbox_shell", new Set([shellName!]))).toBe(shellName);
    expect(normalizeWorkspaceProviderToolName("sandbox_shell", new Set(["sandbox_shell"]))).toBe("sandbox_shell");
  });

  it("loads the actual pinned catalog from a nested application working directory", () => {
    const root = process.cwd();
    const runtimePath = resolve(root, "lib/server/workspace/microsandboxRuntime.ts");
    const result = execFileSync(process.execPath, [
      "--import", resolveRuntimeModulePath("tsx"), "-e",
      `const { loadPinnedOfficialWorkspaceToolCatalog } = require(${JSON.stringify(runtimePath)});
       loadPinnedOfficialWorkspaceToolCatalog().then(catalog => {
         process.stdout.write(JSON.stringify({ hash: catalog.hash, count: catalog.tools.length }));
       });`
    ], {
      cwd: resolve(root, "lib/server"),
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, "tsconfig.json") },
      timeout: 20_000
    });
    expect(JSON.parse(result)).toEqual({
      hash: WORKSPACE_BOUND_TOOL_CATALOG_HASH,
      count: WORKSPACE_MCP_TOOL_ALLOWLIST.length
    });
  }, 25_000);

  it("requires the complete allowlist and strips model-controlled identities", () => {
    const catalog = bindOfficialWorkspaceTools({
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      tools: officialTools()
    });
    expect(catalog.tools).toHaveLength(16);
    expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/u);
    const shellTool = catalog.tools.find((tool) => tool.originalName === "sandbox_shell");
    expect(shellTool).toBeDefined();
    expect(shellTool!.description).toContain(shellTool!.namespacedName);
    for (const tool of catalog.tools) {
      expect(tool.inputSchema).not.toHaveProperty("properties.name");
      expect(tool.inputSchema).not.toHaveProperty("properties.toSandbox");
      expect(tool.inputSchema).not.toHaveProperty("properties.maxBytes");
      expect(tool.inputSchema).not.toHaveProperty("properties.timeoutMs");
      expect(tool.inputSchema).not.toHaveProperty("properties.rlimits");
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

  it("refuses a hidden argument the model still sends as an ordinary, correctable error", () => {
    const shellName = namespacedWorkspaceToolNameFromOriginal("sandbox_shell")!;
    // The production shape: uppercase names the guest rejects.
    const rlimits = [{ hard: 60, resource: "RLIMIT_CPU", soft: 30 }, { resource: "RLIMIT_NOFILE", soft: 1024 }];
    for (const originalName of ["sandbox_exec", "sandbox_shell", "sandbox_exec_start"] as const) {
      const refusal = workspaceHiddenArgumentRefusal(originalName, { command: "python3 job.py", rlimits });
      expect(refusal).toMatchObject({ errorCode: "workspace_request_invalid", status: "error" });
      const body = JSON.parse(refusal!.content[0]!.text!) as { error: { code: string; message: string }; ok: boolean };
      expect(body).toMatchObject({ error: { code: "workspace_request_invalid" }, ok: false });
      expect(body.error.message).toContain("Nothing ran");
      expect(body.error.message).toContain("`rlimits`");
      expect(body.error.message).toContain(`\`ulimit\` before it in ${shellName}`);
      // The model's own values never come back in the refusal.
      expect(body.error.message).not.toContain("RLIMIT_");
      // The catalog's own fence stays behind it.
      expect(() => injectWorkspaceToolArguments({ arguments: { command: "true", rlimits }, originalName,
        sandboxName: "aiqsa-ws-opaque" })).toThrow("workspace_tool_identity_forbidden");
    }
    const timeout = workspaceHiddenArgumentRefusal("sandbox_shell", { command: "sleep 1", timeoutMs: 1, maxBytes: 1 });
    expect(JSON.parse(timeout!.content[0]!.text!).error.message).toMatch(/does not take `maxBytes`, `timeoutMs` here\. Send the call again without them\.$/u);
    expect(workspaceHiddenArgumentRefusal("sandbox_fs_copy", { toSandbox: "other" })).toMatchObject({ errorCode: "workspace_request_invalid" });
    expect(workspaceHiddenArgumentRefusal("sandbox_shell", { command: "ulimit -t 30; python3 job.py" })).toBeNull();
    expect(workspaceHiddenArgumentRefusal("sandbox_exec_poll", { execSessionId: "exec-1" })).toBeNull();
  });
});
