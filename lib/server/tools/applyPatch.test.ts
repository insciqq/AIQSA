// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";
import {
  APPLY_PATCH_TOOL_NAME,
  ApplyPatchFileError,
  applyPatchTool,
  executeApplyPatch,
  resolveApplyPatchPath,
  workspaceApplyPatchFiles,
  type ApplyPatchFiles,
  type WorkspaceToolCaller
} from "./applyPatch";
import { invalidProviderToolArguments, type ToolExecutionResult } from "./types";

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const call = (input: unknown) => ({ arguments: input === undefined ? {} : { input }, id: "call_1", name: APPLY_PATCH_TOOL_NAME });

function memory(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const operations: string[] = [];
  const port: ApplyPatchFiles = {
    read: vi.fn(async (path: string) => {
      operations.push(`read ${path}`);
      return files.has(path) ? { content: files.get(path)!, kind: "file" as const } : { kind: "missing" as const };
    }),
    remove: vi.fn(async (path: string) => { operations.push(`remove ${path}`); files.delete(path); }),
    write: vi.fn(async (path: string, content: string) => { operations.push(`write ${path}`); files.set(path, content); })
  };
  return { files, operations, port };
}

function body(result: ToolExecutionResult): { code: string; message: string } {
  const entry = result.content[0];
  if (entry?.type !== "json") throw new Error("expected json");
  return entry.value as { code: string; message: string };
}

describe("apply_patch descriptor", () => {
  it("declares a local effect that needs the Workspace VM and no approval", () => {
    expect(applyPatchTool).toMatchObject({ effects: "local", name: "apply_patch", needsApproval: false, requiresVm: true });
    expect(applyPatchTool.tool).toMatchObject({ capability: "workspace", name: "apply_patch", strict: true });
    expect(applyPatchTool.description).toContain("*** Begin Patch");
  });
});

describe("apply_patch paths", () => {
  it("resolves relative paths in the project and keeps absolute ones inside the writable directories", () => {
    expect(resolveApplyPatchPath("src/app.py")).toBe("/workspace/project/src/app.py");
    expect(resolveApplyPatchPath("/workspace/output/run_1/report.md")).toBe("/workspace/output/run_1/report.md");
    expect(resolveApplyPatchPath("/workspace/tmp/a/../b.txt")).toBe("/workspace/tmp/b.txt");
  });

  it.each([
    ["../inbox/a.csv", "/workspace/inbox/a.csv is an original attachment and read-only"],
    ["/workspace/secrets/files/x", "managed by AIQSA"],
    ["/workspace/SECRETS.md", "managed by AIQSA"],
    ["../../etc/passwd", "resolves to /etc/passwd, outside the directories apply_patch edits"],
    ["dir/", "names a directory"]
  ])("refuses %s", (raw, message) => {
    expect(() => resolveApplyPatchPath(raw)).toThrow(message);
  });
});

describe("apply_patch execution", () => {
  it("adds, updates, moves and deletes files and reports them like Codex", async () => {
    const { files, port } = memory({
      "/workspace/project/app.py": "def greet():\n    print('Hi')\n",
      "/workspace/project/old.txt": "x\n"
    });
    const result = await executeApplyPatch(port, call(patch(
      "*** Add File: notes/hello.txt", "+Hello",
      "*** Update File: app.py", "*** Move to: main.py", "@@ def greet():", "-    print('Hi')", "+    print('Hello')",
      "*** Delete File: old.txt"
    )));
    expect(result).toMatchObject({ callId: "call_1", name: "apply_patch", status: "complete" });
    expect(result.content).toEqual([{ text: "Success. Updated the following files:\nA /workspace/project/notes/hello.txt\nM /workspace/project/app.py -> /workspace/project/main.py\nD /workspace/project/old.txt", type: "text" }]);
    expect(Object.fromEntries(files)).toEqual({
      "/workspace/project/main.py": "def greet():\n    print('Hello')\n",
      "/workspace/project/notes/hello.txt": "Hello\n"
    });
  });

  it("writes nothing when any section fails, and says so", async () => {
    const { operations, port } = memory({ "/workspace/project/a.txt": "a\n" });
    const result = await executeApplyPatch(port, call(patch(
      "*** Update File: a.txt", "@@", "-a", "+b",
      "*** Update File: missing.txt", "@@", "-x", "+y"
    )));
    expect(result.status).toBe("error");
    expect(body(result)).toEqual({ code: "apply_patch_mismatch",
      message: "Patch line 6: /workspace/project/missing.txt does not exist. Use '*** Add File: missing.txt' to create it. No file was changed." });
    expect(operations.filter((operation) => !operation.startsWith("read"))).toEqual([]);
  });

  it.each([
    [patch("*** Add File: a.txt", "+x"), "apply_patch_mismatch", "/workspace/project/a.txt already exists. Use '*** Update File: a.txt'"],
    [patch("*** Update File: a.txt", "*** Move to: b.txt"), "apply_patch_mismatch", "because /workspace/project/b.txt already exists"],
    [patch("*** Delete File: ../inbox/a.txt"), "apply_patch_invalid", "Patch line 2: /workspace/inbox/a.txt is an original attachment"],
    ["*** Update File: a.txt", "apply_patch_invalid", "Patch line 1: the patch must start with '*** Begin Patch'"]
  ])("refuses an unsafe or malformed patch before writing (%#)", async (text, code, message) => {
    const { operations, port } = memory({ "/workspace/project/a.txt": "a\n", "/workspace/project/b.txt": "b\n" });
    const error = body(await executeApplyPatch(port, call(text)));
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
    expect(operations.filter((operation) => !operation.startsWith("read"))).toEqual([]);
  });

  it("lets a later section see an earlier one in the same patch", async () => {
    const { files, port } = memory({ "/workspace/project/a.txt": "one\n" });
    const result = await executeApplyPatch(port, call(patch(
      "*** Delete File: a.txt", "*** Add File: a.txt", "+two", "*** Update File: a.txt", "@@", "-two", "+three"
    )));
    expect(result.status).toBe("complete");
    expect(files.get("/workspace/project/a.txt")).toBe("three\n");
    expect(port.read).toHaveBeenCalledOnce();
  });

  it("reports a partly applied patch with the changed and unchanged files", async () => {
    const { port } = memory({ "/workspace/project/a.txt": "a\n" });
    vi.mocked(port.write).mockImplementation(async (path) => {
      if (path.endsWith("b.txt")) throw new ApplyPatchFileError("apply_patch_workspace_failed", `${path}: disk full`);
    });
    const result = await executeApplyPatch(port, call(patch("*** Update File: a.txt", "@@", "-a", "+A", "*** Add File: b.txt", "+b", "*** Add File: c.txt", "+c")));
    expect(body(result)).toMatchObject({ changed: ["/workspace/project/a.txt"], code: "apply_patch_partially_applied",
      unchanged: ["/workspace/project/b.txt", "/workspace/project/c.txt"] });
    expect(body(result).message).toContain("/workspace/project/b.txt: disk full The patch was applied only partly");
  });

  it("refuses missing, non-JSON and oversized input", async () => {
    const { port } = memory({});
    expect(body(await executeApplyPatch(port, call(undefined))).code).toBe("apply_patch_invalid");
    expect(body(await executeApplyPatch(port, { ...call(undefined), arguments: invalidProviderToolArguments() })).code).toBe("apply_patch_invalid");
    expect(body(await executeApplyPatch(port, call(patch("*** Add File: a.txt", `+${"x".repeat(600 * 1_024)}`)))).code).toBe("apply_patch_too_large");
  });

  it("propagates cancellation instead of reporting a result", async () => {
    const { port } = memory({ "/workspace/project/a.txt": "a\n" });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(executeApplyPatch(port, call(patch("*** Delete File: a.txt")), { signal: controller.signal })).rejects.toThrow("stopped");
  });
});

describe("apply_patch over Workspace tools", () => {
  type Handler = (args: Record<string, unknown>) => unknown;
  function workspace(handlers: Partial<Record<WorkspaceMcpToolName, Handler>>) {
    const calls: [WorkspaceMcpToolName, Record<string, unknown>][] = [];
    const caller: WorkspaceToolCaller = async (name, args) => {
      calls.push([name, args]);
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected ${name}`);
      const value = handler(args) as { status?: "error"; envelope: unknown; truncated?: boolean };
      return { callId: "inner", content: [{ text: JSON.stringify(value.envelope), type: "text" }], name,
        ...(value.truncated ? { rawPreview: { truncated: true } } : {}), status: value.status ?? "complete" };
    };
    return { calls, files: workspaceApplyPatchFiles(caller) };
  }

  it("reads an existing UTF-8 file and reports a missing one without reading it", async () => {
    const { calls, files } = workspace({
      sandbox_fs_exists: ({ path }) => ({ envelope: { data: { exists: path === "/workspace/project/a.txt", path }, ok: true } }),
      sandbox_fs_read: ({ path }) => ({ envelope: { data: { content: "hello\n", encoding: "utf8", path }, ok: true } })
    });
    await expect(files.read("/workspace/project/a.txt")).resolves.toEqual({ content: "hello\n", kind: "file" });
    await expect(files.read("/workspace/project/b.txt")).resolves.toEqual({ kind: "missing" });
    expect(calls.map(([name]) => name)).toEqual(["sandbox_fs_exists", "sandbox_fs_read", "sandbox_fs_exists"]);
    expect(calls[1]![1]).toEqual({ encoding: "utf8", path: "/workspace/project/a.txt" });
  });

  it.each([
    [{ envelope: { data: { content: "part" }, ok: true, truncated: [{ field: "content" }] } }, "apply_patch_file_too_large"],
    [{ envelope: { data: { content: "part" }, ok: true }, truncated: true }, "apply_patch_file_too_large"],
    [{ envelope: { data: { content: "bin�" }, ok: true } }, "apply_patch_file_unreadable"],
    [{ envelope: { error: { code: "operation_failed", message: "is a directory" }, ok: false }, status: "error" }, "apply_patch_workspace_failed"]
  ])("refuses a file it cannot patch whole (%#)", async (read, code) => {
    const { files } = workspace({
      sandbox_fs_exists: () => ({ envelope: { data: { exists: true }, ok: true } }),
      sandbox_fs_read: () => read
    });
    await expect(files.read("/workspace/project/a.bin")).rejects.toMatchObject({ code });
  });

  it("creates a missing parent directory with a direct mkdir before writing", async () => {
    const { calls, files } = workspace({
      sandbox_exec: () => ({ envelope: { data: { exitCode: 0, stderr: "", stdout: "", success: true }, ok: true } }),
      sandbox_fs_exists: () => ({ envelope: { data: { exists: false }, ok: true } }),
      sandbox_fs_remove: () => ({ envelope: { data: { removed: true }, ok: true } }),
      sandbox_fs_write: () => ({ envelope: { data: { written: 2 }, ok: true } })
    });
    await files.write("/workspace/project/new/dir/a.txt", "x\n");
    await files.remove("/workspace/project/old.txt");
    expect(calls).toEqual([
      ["sandbox_fs_exists", { path: "/workspace/project/new/dir" }],
      ["sandbox_exec", { args: ["-p", "--", "/workspace/project/new/dir"], command: "mkdir" }],
      ["sandbox_fs_write", { content: "x\n", encoding: "utf8", path: "/workspace/project/new/dir/a.txt" }],
      ["sandbox_fs_remove", { kind: "file", path: "/workspace/project/old.txt" }]
    ]);
  });
});
