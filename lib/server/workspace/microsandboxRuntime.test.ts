import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxNotFoundError } from "microsandbox";
import { workspaceAttachmentPath, workspaceSandboxName } from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "./config";
import { MicrosandboxWorkspaceRuntime } from "./microsandboxRuntime";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "./runtime";

const sdk = vi.hoisted(() => ({
  builder: vi.fn(),
  get: vi.fn(),
  callTool: vi.fn(),
  closeMcp: vi.fn(async () => undefined)
}));

vi.mock("microsandbox", () => ({
  Sandbox: { builder: sdk.builder, get: sdk.get },
  SandboxNotFoundError: class extends Error {},
  NetworkPolicy: { none: () => ({}) }
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn(async () => undefined);
    getServerVersion = () => ({ version: "0.6.16" });
    listTools = async () => ({ tools: [] });
    callTool = sdk.callTool;
  }
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class { close = sdk.closeMcp; }
}));
// Catalog schema validation has its own official-catalog contract tests.
// This fixture isolates lifecycle decisions from the MCP subprocess.
vi.mock("./toolCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toolCatalog")>();
  return {
    ...actual,
    bindOfficialWorkspaceTools: () => ({
      hash: actual.WORKSPACE_BOUND_TOOL_CATALOG_HASH,
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      tools: []
    })
  };
});

const config = getWorkspaceConfig({});
const sessionId = "ws_" + "1".repeat(40);
const sandboxName = workspaceSandboxName(sessionId);
const runtimeSandboxId = "runtime_fixture";
const sessionInput = { runtimeSandboxId, sessionId };
const ensureInput = {
  ...sessionInput,
  cpus: config.cpus,
  diskMiB: config.diskMiB,
  imageRef: config.imageRef,
  internetEnabled: false,
  memoryMiB: config.memoryMiB,
  sandboxName
};
const callInput: Parameters<WorkspaceRuntime["callBoundTool"]>[0] = {
  ...sessionInput,
  arguments: { command: "printf marker" },
  modelRunId: "run_fixture",
  modelRunToolCallId: "call_fixture",
  originalName: "sandbox_shell"
};

function fixture() {
  let state = "running";
  const files = new Map<string, Uint8Array>();
  const fs = {
    exists: vi.fn(async (path: string) => [...files.keys()].some((file) => file.startsWith(path))),
    read: vi.fn(async (path: string) => files.get(path)!),
    stat: vi.fn(async (path: string) => ({ kind: "file", size: files.get(path)!.length })),
    list: vi.fn(async (directory: string) => [...files.entries()]
      .filter(([path]) => path.startsWith(directory + "/"))
      .map(([path, bytes]) => ({ kind: "file", path, size: bytes.length }))),
    readStream: vi.fn(async (path: string) => {
      const bytes = files.get(path)!;
      return {
        async *[Symbol.asyncIterator]() { yield bytes; },
        async [Symbol.asyncDispose]() {}
      };
    })
  };
  const sandbox = {
    exec: vi.fn(async () => ({ success: true })),
    fs: () => fs,
    id: runtimeSandboxId,
    name: sandboxName,
    stopWithTimeout: vi.fn(async () => { state = "stopped"; })
  };
  const handle = {
    connectOrStart: vi.fn(async (_options?: { detached?: boolean }) => {
      state = "running";
      return sandbox;
    }),
    connectWithTimeout: vi.fn(async (_timeout: number) => sandbox),
    destroy: vi.fn(async () => { state = "missing"; }),
    id: runtimeSandboxId,
    name: sandboxName,
    get status() { return state; },
    stopWithTimeout: vi.fn(async () => { state = "stopped"; })
  };
  const builder = {
    connectOrCreate: vi.fn(async () => sandbox),
    detached: vi.fn().mockReturnThis(),
    image: vi.fn().mockReturnThis(),
    rootDisk: vi.fn().mockReturnThis(),
    cpus: vi.fn().mockReturnThis(),
    memory: vi.fn().mockReturnThis(),
    workdir: vi.fn().mockReturnThis(),
    deploymentProfile: vi.fn().mockReturnThis(),
    security: vi.fn().mockReturnThis(),
    idleTimeout: vi.fn().mockReturnThis(),
    labels: vi.fn().mockReturnThis(),
    network: vi.fn().mockReturnThis()
  };
  sdk.get.mockImplementation(async () => {
    if (state === "missing") throw new SandboxNotFoundError(sandboxName);
    return handle;
  });
  sdk.builder.mockReturnValue(builder);
  sdk.callTool.mockImplementation(async () => {
    if (state !== "running") return { isError: true, content: [{ type: "text", text: "opaque error" }] };
    return { content: [{ type: "text", text: "ok" }] };
  });
  return {
    builder, files, fs, handle, sandbox,
    runtime: new MicrosandboxWorkspaceRuntime(config),
    setState(value: string) { state = value; }
  };
}

describe("Microsandbox Workspace lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes private output captures after a restart discovers the guest disk is gone", async () => {
    const value = fixture();
    const root = await mkdtemp(join(tmpdir(), "aiqsa-micro-capture-test-"));
    try {
      const runtime = new MicrosandboxWorkspaceRuntime(config, root);
      await runtime.ensureSession(ensureInput);
      value.files.set("/workspace/output/fixture/report.txt", new TextEncoder().encode("original"));
      const outputs = await runtime.collectOutputs({ ...sessionInput, modelRunId: "fixture",
        outputDirectory: "/workspace/output/fixture", capture: { create: true, id: "a".repeat(32) } });
      await outputs[0]!.body.cancel();
      value.setState("missing");
      const restarted = new MicrosandboxWorkspaceRuntime(config, root);
      await expect(restarted.collectOutputs({ ...sessionInput, modelRunId: "fixture",
        outputDirectory: "/workspace/output/fixture", capture: { create: false, id: "a".repeat(32) } }))
        .rejects.toMatchObject({ code: "workspace_session_lost" });
      await restarted.removeSession({ sessionId, runtimeSandboxId: null });
      expect(await readdir(root)).toEqual([]);
      expect(value.builder.connectOrCreate).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("creates a persistent VM detached from the creator handle", async () => {
    const value = fixture();
    value.setState("missing");
    await value.runtime.ensureSession({ ...ensureInput, runtimeSandboxId: null });
    expect(value.builder.detached).toHaveBeenCalledWith(true);
    expect(value.builder.connectOrCreate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("resumes an exact stopped disk detached (cached=%s)", async (cached) => {
    const value = fixture();
    if (cached) await value.runtime.ensureSession(ensureInput);
    value.setState("stopped");
    value.handle.connectOrStart.mockClear();
    await value.runtime.ensureSession(ensureInput);
    expect(value.handle.connectOrStart).toHaveBeenCalledExactlyOnceWith({ detached: true });
    expect(sdk.builder).not.toHaveBeenCalled();
  });

  it.each(["stopped", "crashed"])("resumes %s before dispatch and executes only once", async (state) => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    value.setState(state);
    value.handle.connectOrStart.mockClear();
    await expect(value.runtime.callBoundTool(callInput)).resolves.toMatchObject({ status: "complete" });
    expect(value.handle.connectOrStart).toHaveBeenCalledExactlyOnceWith({ detached: true });
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
    expect(sdk.builder).not.toHaveBeenCalled();
  });

  it("reattaches after losing the runner cache without declaring disk loss", async () => {
    const value = fixture();
    await expect(value.runtime.callBoundTool(callInput)).resolves.toMatchObject({ status: "complete" });
    expect(sdk.get).toHaveBeenCalledWith(sandboxName);
    expect(sdk.builder).not.toHaveBeenCalled();
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "replacement"])("refuses a %s disk, only actual absence permits recreation", async (reason) => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    if (reason === "missing") value.setState("missing");
    else value.handle.id = "replacement_runtime";
    await expect(value.runtime.callBoundTool(callInput)).rejects.toMatchObject({
      code: reason === "missing" ? "workspace_session_lost_before_dispatch" : "workspace_runtime_incompatible"
    });
    expect(sdk.callTool).not.toHaveBeenCalled();
    if (reason === "missing") {
      await value.runtime.ensureSession({ ...ensureInput, runtimeSandboxId: null });
      expect(value.builder.connectOrCreate).toHaveBeenCalledTimes(1);
    } else {
      await expect(value.runtime.ensureSession(ensureInput)).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
      expect(sdk.builder).not.toHaveBeenCalled();
    }
  });

  it("never retries or promotes an error received after MCP dispatch", async () => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    sdk.callTool.mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_session_lost"));
    await expect(value.runtime.callBoundTool(callInput)).rejects.toMatchObject({ code: "workspace_session_lost" });
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
  });

  it("resumes a stopped disk for byte-exact output collection", async () => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    value.setState("stopped");
    const bytes = new TextEncoder().encode("synthetic output");
    const outputDirectory = "/workspace/output/run_fixture";
    value.files.set(`${outputDirectory}/result.txt`, bytes);
    const outputs = await value.runtime.collectOutputs({
      ...sessionInput, modelRunId: "run_fixture", outputDirectory
    });
    expect(value.handle.connectOrStart).toHaveBeenLastCalledWith({ detached: true });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Buffer.from(await new Response(outputs[0]!.body).arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  it.each(["same size", "short read", "long read", "unreadable", "symlink", "index checksum", "forged index", "replacement"] as const)(
    "rejects an indexed original with %s while reusing intact bytes", async (change) => {
      const value = fixture();
      await value.runtime.ensureSession(ensureInput);
      const bytes = Buffer.from("original bytes");
      const path = workspaceAttachmentPath({ attachmentId: "att_integrity", messageId: "msg_integrity", originalName: "input.bin" });
      const entry = { attachmentId: "att_integrity", byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), sandboxPath: path };
      const index = "/workspace/inbox/index.json";
      value.files.set(path, bytes);
      value.files.set(index, Buffer.from(JSON.stringify({ version: 1, attachments: [entry], manifests: [] })));
      const listing = { ...sessionInput, attachments: [entry] };
      await expect(value.runtime.listStagedAttachments(listing)).resolves.toEqual([entry]);
      let stats = 0;
      value.fs.stat.mockImplementation(async (name) => ({
        kind: name === path && (change === "symlink" || change === "replacement" && ++stats > 1) ? "symlink" : "file",
        size: name === path ? entry.byteSize : value.files.get(name)!.length
      }));
      if (change === "same size") value.files.set(path, Buffer.from("tampered bytes"));
      if (change === "short read") value.files.set(path, bytes.subarray(1));
      if (change === "long read") value.files.set(path, Buffer.concat([bytes, Buffer.from("!")]));
      if (change === "unreadable") {
        const read = value.fs.readStream.getMockImplementation()!;
        value.fs.readStream.mockImplementation(async (name) => {
          if (name === path) throw new Error("synthetic_read_failure");
          return read(name);
        });
      }
      if (change === "index checksum") value.files.set(index, Buffer.from(JSON.stringify({ version: 1, attachments: [{ ...entry, checksum: "a".repeat(64) }], manifests: [] })));
      if (change === "forged index") {
        const changed = Buffer.from("tampered bytes");
        value.files.set(path, changed);
        value.files.set(index, Buffer.from(JSON.stringify({ version: 1, attachments: [{ ...entry, checksum: createHash("sha256").update(changed).digest("hex") }], manifests: [] })));
      }
      await expect(value.runtime.listStagedAttachments(listing)).resolves.toEqual([]);
    }
  );

  it("does not read guest-index files absent from canonical admission", async () => {
    const value = fixture();
    const bytes = Buffer.from("synthetic unrelated original");
    const path = workspaceAttachmentPath({ attachmentId: "att_unrelated", messageId: "msg_unrelated", originalName: "unrelated.bin" });
    value.files.set(path, bytes);
    value.files.set("/workspace/inbox/index.json", Buffer.from(JSON.stringify({ version: 1, attachments: [{
      attachmentId: "att_unrelated", byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), sandboxPath: path
    }] })));
    await expect(value.runtime.listStagedAttachments({ ...sessionInput, attachments: [] })).resolves.toEqual([]);
    expect(value.fs.readStream).not.toHaveBeenCalled();
  });

  it("disposes an output opened after its pending read was cancelled", async () => {
    const value = fixture();
    const outputDirectory = "/workspace/output/run_fixture";
    const bytes = Buffer.from("synthetic output");
    value.files.set(`${outputDirectory}/result.txt`, bytes);
    let opened!: (stream: Awaited<ReturnType<typeof value.fs.readStream>>) => void;
    let opening!: () => void;
    const started = new Promise<void>((resolve) => { opening = resolve; });
    const held = new Promise<Awaited<ReturnType<typeof value.fs.readStream>>>((resolve) => { opened = resolve; });
    const dispose = vi.fn(async () => {});
    const stream = { async *[Symbol.asyncIterator]() { yield bytes; }, [Symbol.asyncDispose]: dispose };
    value.fs.readStream.mockResolvedValueOnce({ async *[Symbol.asyncIterator]() { yield bytes; }, async [Symbol.asyncDispose]() {} });
    value.fs.readStream.mockImplementationOnce(() => { opening(); return held; });
    const outputs = await value.runtime.collectOutputs({ ...sessionInput, modelRunId: "run_fixture", outputDirectory });
    const reader = outputs[0]!.body.getReader();
    const reading = reader.read();
    await started;
    await reader.cancel();
    opened(stream);
    await reading;
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it.each(["paused", "draining"])("does not restart or dispatch against %s state", async (state) => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    value.setState(state);
    value.handle.connectOrStart.mockClear();
    await expect(value.runtime.callBoundTool(callInput)).rejects.toMatchObject({ code: "workspace_runtime_unavailable" });
    expect(value.handle.connectOrStart).not.toHaveBeenCalled();
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("bounds reconciliation to one start and never dispatches on resume failure", async () => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    value.setState("stopped");
    value.handle.connectOrStart.mockClear().mockRejectedValueOnce(new Error("synthetic SDK failure"));
    await expect(value.runtime.callBoundTool(callInput)).rejects.toMatchObject({ code: "workspace_runtime_unavailable" });
    expect(value.handle.connectOrStart).toHaveBeenCalledTimes(1);
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("rejects a same-name replacement returned during connect", async () => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    value.sandbox.id = "replacement_runtime";
    await expect(value.runtime.callBoundTool(callInput)).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("keeps official MCP errors opaque and does not turn text into a retry", async () => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    sdk.callTool.mockResolvedValueOnce({ isError: true, content: [{
      type: "text", text: "status: Stopped; sandbox fixture-runtime; SDK details"
    }] });
    await expect(value.runtime.callBoundTool(callInput)).resolves.toEqual({
      content: [{ type: "text", text: "The Workspace operation failed." }], status: "error"
    });
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch after cancellation during reconnect", async () => {
    const value = fixture();
    const controller = new AbortController();
    value.handle.connectWithTimeout.mockImplementationOnce(async () => {
      controller.abort();
      return value.sandbox;
    });
    await expect(value.runtime.callBoundTool({ ...callInput, signal: controller.signal }))
      .rejects.toMatchObject({ code: "workspace_tool_cancelled" });
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it.each(["stopSession", "removeSession"] as const)("retains explicit %s authority", async (operation) => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    await value.runtime[operation](sessionInput);
    if (operation === "stopSession") expect(value.handle.stopWithTimeout).toHaveBeenCalledWith(10_000);
    else expect(value.handle.destroy).toHaveBeenCalledWith({ timeoutMs: 10_000 });
  });

  it.each(["cancelled", "failed"])("stops the allocated VM when bootstrap is %s", async (outcome) => {
    const value = fixture();
    const controller = new AbortController();
    value.setState("missing");
    if (outcome === "cancelled") {
      value.builder.connectOrCreate.mockImplementationOnce(async () => {
        controller.abort();
        return value.sandbox;
      });
    } else value.sandbox.exec.mockResolvedValueOnce({ success: false });
    await expect(value.runtime.ensureSession({ ...ensureInput, runtimeSandboxId: null, signal: controller.signal }))
      .rejects.toMatchObject({ code: outcome === "cancelled" ? "workspace_tool_cancelled" : "workspace_session_create_failed" });
    expect(value.sandbox.stopWithTimeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it.each(["stopSession", "removeSession"] as const)("%s waits for an accepted bootstrap and then cleans its exact VM", async (operation) => {
    const value = fixture();
    value.setState("missing");
    let acquired!: () => void;
    const started = new Promise<void>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    value.builder.connectOrCreate.mockImplementationOnce(async () => {
      acquired();
      await blocked;
      value.setState("running");
      return value.sandbox;
    });
    const initializing = value.runtime.ensureSession({ ...ensureInput, runtimeSandboxId: null });
    await started;
    const cleanup = value.runtime[operation]({ sessionId, runtimeSandboxId: null });
    release();
    await initializing;
    await cleanup;
    if (operation === "stopSession") expect(value.handle.stopWithTimeout).toHaveBeenCalledExactlyOnceWith(10_000);
    else expect(value.handle.destroy).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 10_000 });
  });

  it.each(["stopSession", "removeSession"] as const)("%s keeps cached identity after cleanup failure even without a persisted id", async (operation) => {
    const value = fixture();
    await value.runtime.ensureSession({ ...ensureInput, runtimeSandboxId: null });
    if (operation === "stopSession") value.handle.stopWithTimeout.mockRejectedValueOnce(new Error("unavailable"));
    else value.handle.destroy.mockRejectedValueOnce(new Error("unavailable"));
    await expect(value.runtime[operation]({ sessionId, runtimeSandboxId: null })).rejects.toMatchObject({ code: "workspace_runtime_unavailable" });
    value.handle.id = "replacement_runtime";
    await expect(value.runtime[operation]({ sessionId, runtimeSandboxId: null })).rejects.toMatchObject({ code: "workspace_session_lost" });
    expect(value.handle.stopWithTimeout).toHaveBeenCalledTimes(operation === "stopSession" ? 1 : 0);
    expect(value.handle.destroy).toHaveBeenCalledTimes(operation === "removeSession" ? 1 : 0);
  });

  it("bounds an unresolved bootstrap cleanup without claiming absence, then permits exact cleanup", async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.setState("missing");
    let acquired!: () => void;
    const started = new Promise<void>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    value.builder.connectOrCreate.mockImplementationOnce(async () => {
      acquired();
      await blocked;
      value.setState("running");
      return value.sandbox;
    });
    const initializing = value.runtime.ensureSession({ ...ensureInput, runtimeSandboxId: null });
    try {
      await started;
      const cleanup = expect(value.runtime.stopSession({ sessionId, runtimeSandboxId: null }))
        .rejects.toMatchObject({ code: "workspace_execution_cleanup_failed" });
      await vi.advanceTimersByTimeAsync(10_000);
      await cleanup;
      expect(value.handle.stopWithTimeout).not.toHaveBeenCalled();
    } finally {
      release();
      await initializing;
      vi.useRealTimers();
    }
    await value.runtime.stopSession({ sessionId, runtimeSandboxId: null });
    expect(value.handle.stopWithTimeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });
});


describe("Microsandbox terminal process proof", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { name: "bare done after EOF", data: { done: true, exitStatus: null, error: null } },
    { name: "done after a broken reader", data: { done: true, exitStatus: null, error: "synthetic reader failure" } },
    { name: "ambiguous negative exit", data: { done: true, exitStatus: { code: -1 }, error: null } },
    { name: "leader exit with unobserved descendants", data: { done: true, exitStatus: { code: 0 }, error: null } },
    { name: "signal and close acknowledgements", data: { done: false, exitStatus: null, error: null } }
  ])("does not certify all processes from $name", async ({ data }) => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      await value.runtime.ensureSession(ensureInput);
      sdk.callTool.mockImplementation(async ({ name }) => ({ content: [{ type: "text", text: JSON.stringify({
        data: name === "sandbox_exec_poll" ? data : { accepted: true, closed: true }
      }) }] }));
      const result = value.runtime.terminateExecutions({
        ...sessionInput, executions: [{ modelRunId: "run_fixture", runtimeExecSessionId: "exec_fixture" }]
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toEqual([{ outcome: "unknown", runtimeExecSessionId: "exec_fixture" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes again after KILL and never disposes an unobserved execution as proof", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      await value.runtime.ensureSession(ensureInput);
      sdk.callTool.mockImplementation(async () => ({ content: [{ type: "text", text: JSON.stringify({
        data: { done: false, exitStatus: null, error: null }
      }) }] }));
      const result = value.runtime.terminateExecutions({
        ...sessionInput, executions: [{ modelRunId: "run_fixture", runtimeExecSessionId: "exec_fixture" }]
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await result;
      const actions = sdk.callTool.mock.calls.map(([call]) => `${call.name}:${call.arguments.signal ?? ""}`);
      expect(actions).toEqual([
        "sandbox_exec_signal:term", "sandbox_exec_poll:", "sandbox_exec_signal:kill", "sandbox_exec_poll:"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});


it("keeps descendant cleanup authority after the model closes the MCP observation", async () => {
  vi.useFakeTimers();
  try {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    sdk.callTool.mockImplementation(async () => ({ content: [{ type: "text", text: JSON.stringify({
      data: { execSessionId: "exec_fixture", done: true, exitStatus: { code: 0 }, error: null }
    }) }] }));
    await value.runtime.callBoundTool({ ...callInput, originalName: "sandbox_exec_start" });
    await value.runtime.callBoundTool({ ...callInput, originalName: "sandbox_exec_close", arguments: { execSessionId: "exec_fixture" } });
    const checked = value.runtime.collectOutputs({ ...sessionInput, modelRunId: "run_fixture", outputDirectory: "/workspace/output/fixture" })
      .then(() => ({ status: "resolved" }), (error: WorkspaceRuntimeError) => ({ status: "rejected", code: error.code }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await checked).toEqual({ status: "rejected", code: "workspace_execution_cleanup_failed" });
  } finally {
    vi.useRealTimers();
  }
});
