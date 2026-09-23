import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runWithContext } from "../observability";
import { SandboxNotFoundError, SandboxNotRunningError } from "microsandbox";
import { workspaceAttachmentPath, workspaceSandboxName } from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "./config";
import { MicrosandboxWorkspaceRuntime } from "./microsandboxRuntime";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "./runtime";
import { AGENT_GATEWAY_ORIGIN } from "../agents/relay";
import { tarGzipStream } from "../chats/tarArchive";

const sdk = vi.hoisted(() => ({
  builder: vi.fn(),
  get: vi.fn(),
  installed: vi.fn(() => true),
  image: vi.fn(async () => ({})),
  list: vi.fn(async () => []),
  listWith: vi.fn(),
  callTool: vi.fn(),
  closeMcp: vi.fn(async () => undefined)
}));

vi.mock("microsandbox", () => ({
  Image: { get: sdk.image },
  isInstalled: sdk.installed,
  Sandbox: { builder: sdk.builder, get: sdk.get, list: sdk.list, listWith: sdk.listWith },
  SandboxNotFoundError: class extends Error {},
  SandboxNotRunningError: class extends Error {},
  NetworkPolicy: { none: () => ({}) }
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const access = vi.fn(original.access);
  return { ...original, access, default: { ...original, access } };
});
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
const skillDirectories: string[] = [];
const skillIdentity = { ...sessionInput, modelRunId: "run_fixture", manifestHash: "a".repeat(64) };
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
    write: vi.fn(async (path: string, bytes: string | Uint8Array) => {
      files.set(path, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes.slice());
    }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
    writeStream: vi.fn(async (path: string) => ({
      write: vi.fn(async (bytes: Uint8Array) => { files.set(path, bytes.slice()); }),
      close: vi.fn(async () => {}),
      async [Symbol.asyncDispose]() {}
    })),
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
    execWith: vi.fn(async (_command: string, _configure: unknown) => ({ success: true, stdout: (): string => "{}", stdoutBytes: () => Buffer.from("{}") })),
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
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(skillDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  it.each(["valid", "corrupt", "short", "disk_full"])("publishes only verified originals and cleans temporary staging on %s", async outcome => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    value.sandbox.execWith.mockResolvedValueOnce({ success: true,
      stdout: () => outcome === "disk_full" ? "16" : "1000000000",
      stdoutBytes: () => Buffer.from(outcome === "disk_full" ? "16" : "1000000000") });
    const sandboxPath = workspaceAttachmentPath({ attachmentId: "attachment_fixture", messageId: "message_fixture", originalName: "original.bin" });
    value.files.set(sandboxPath, Buffer.from("old"));
    const next = Buffer.from(outcome === "short" ? "ab" : "abc");
    const pending = value.runtime.stageAttachments({ ...sessionInput,
      attachments: [{ attachmentId: "attachment_fixture", byteSize: 3, checksum: outcome === "corrupt" ? "0".repeat(64) : createHash("sha256").update("abc").digest("hex"),
        body: new ReadableStream({ start(controller) { controller.enqueue(next); controller.close(); } }),
        kind: "file", messageId: "message_fixture", mimeType: "application/octet-stream", originalName: "original.bin", sandboxPath }],
      manifests: [], inboxIndex: { attachments: [], manifests: [], version: 1 } });
    if (outcome === "valid") await pending;
    else await expect(pending).rejects.toMatchObject({ code: outcome === "disk_full" ? "workspace_storage_full" : "workspace_attachment_unavailable" });
    expect(Buffer.from(value.files.get(sandboxPath)!).toString()).toBe(outcome === "valid" ? "abc" : "old");
    expect([...value.files.keys()].some(path => path.includes("/.upload-"))).toBe(false);
    if (outcome === "disk_full") expect(value.fs.writeStream).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])("qualifies Agent only when its gateway is configured: %s", async (agentGatewayEnabled) => {
    vi.mocked(access).mockResolvedValueOnce(undefined);
    const runtime = new MicrosandboxWorkspaceRuntime({ ...config, agentGatewayEnabled });
    const health = await runtime.health();
    expect(health).toMatchObject({ state: "ready", agentReady: agentGatewayEnabled === true });
  });

  it.each([null, 2])("passes Agent deadline %s explicitly, omitting the SDK timer in Off", async (timeoutSeconds) => {
    const value = fixture();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-runtime-")); skillDirectories.push(directory);
    const runtime = new MicrosandboxWorkspaceRuntime({ ...config, agentGatewayEnabled: true }, undefined, directory);
    await runtime.ensureSession(ensureInput);
    await runtime.prepareSkillRun({ ...skillIdentity, initial: [] });
    await runtime.completeSkillRunPreparation(skillIdentity);
    const builder = { args: vi.fn().mockReturnThis(), cwd: vi.fn().mockReturnThis(), timeout: vi.fn().mockReturnThis(),
      envs: vi.fn().mockReturnThis(), stdinBytes: vi.fn().mockReturnThis() };
    const handle = { recv: vi.fn(async () => null), kill: vi.fn(async () => {}) };
    Object.assign(value.sandbox, { execStreamWith: vi.fn(async (_command: string, configure: (builder: unknown) => unknown) => {
      configure(builder); return handle;
    }) });
    await runtime.startAgent({ ...sessionInput, modelRunId: "run_fixture", runtimeExecSessionId: `agent-${randomUUID()}`,
      skillManifestHash: skillIdentity.manifestHash,
      prompt: "Synthetic task", runToken: "a".repeat(43), timeoutSeconds,
      profile: { gatewayOrigin: AGENT_GATEWAY_ORIGIN, modelId: "fixture", contextWindowTokens: 128000,
        maxOutputTokens: 4096, developerInstructions: "Synthetic instructions", mcpMode: "off", mcpTimeoutSeconds: 90 } });
    if (timeoutSeconds === null) expect(builder.timeout).not.toHaveBeenCalled();
    else expect(builder.timeout).toHaveBeenCalledWith(2000);
    expect(builder.envs).toHaveBeenCalledWith(expect.objectContaining({ HOME: "/root" }));
  });

  it("requires a settled exact native predecessor before resuming and never replays a lost start", async () => {
    const value = fixture();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-runtime-")); skillDirectories.push(directory);
    const runtime = new MicrosandboxWorkspaceRuntime({ ...config, agentGatewayEnabled: true }, undefined, directory);
    await runtime.ensureSession(ensureInput);
    await runtime.prepareSkillRun({ ...skillIdentity, initial: [] });
    await runtime.completeSkillRunPreparation(skillIdentity);
    const threadId = randomUUID(), firstId = `agent-${randomUUID()}`, nextId = `agent-${randomUUID()}`;
    const bytes = (events: unknown[]) => Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
    let exit!: () => void;
    const stop = new Promise<void>(resolve => { exit = resolve; });
    const handle = { recv: vi.fn()
      .mockResolvedValueOnce({ kind: "stdout", data: bytes([{ type: "thread.started", thread_id: threadId }, { type: "turn.started" }]) })
      .mockImplementationOnce(async () => { await stop; return { kind: "exited", code: 1 }; }).mockResolvedValue(null),
      signal: vi.fn(async (signal: number) => { expect(signal).toBe(2); exit(); }), kill: vi.fn() };
    const execStreamWith = vi.fn().mockResolvedValueOnce(handle).mockRejectedValueOnce(new Error("lost_native_start_ack"));
    Object.assign(value.sandbox, { execStreamWith });
    const start = { ...sessionInput, modelRunId: "run_fixture", runtimeExecSessionId: firstId,
      skillManifestHash: skillIdentity.manifestHash, prompt: "Synthetic", runToken: "a".repeat(43), timeoutSeconds: null,
      profile: { gatewayOrigin: AGENT_GATEWAY_ORIGIN, modelId: "fixture", contextWindowTokens: 128000,
        maxOutputTokens: 4096, developerInstructions: "Synthetic", mcpMode: "off" as const, mcpTimeoutSeconds: 90 } };
    await runtime.startAgent(start);
    const next = { ...start, runtimeExecSessionId: nextId, previousExecSessionId: firstId, threadId };
    await expect(runtime.startAgent(next)).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    expect(await runtime.interruptAgent(start)).toBe(true);
    await vi.waitFor(async () => expect((await runtime.pollAgent({ ...start, cursor: 0 })).done).toBe(true));
    await expect(runtime.startAgent({ ...next, threadId: randomUUID() })).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    await expect(runtime.startAgent(next)).rejects.toThrow("lost_native_start_ack");
    await expect(runtime.startAgent(next)).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    await expect(runtime.startAgent({ ...next, runtimeExecSessionId: `agent-${randomUUID()}` })).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    expect(execStreamWith).toHaveBeenCalledTimes(2); expect(handle.kill).not.toHaveBeenCalled();
    expect(handle.signal).toHaveBeenCalledOnce();
  });

  it("serializes a bundle transfer with Agent start and rejects subsequent mutation while the Agent is owned", async () => {
    const value = fixture();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-runtime-")); skillDirectories.push(directory);
    const runtime = new MicrosandboxWorkspaceRuntime({ ...config, agentGatewayEnabled: true }, undefined, directory);
    await runtime.ensureSession(ensureInput);
    const start = { ...sessionInput, modelRunId: "run_fixture", runtimeExecSessionId: `agent-${randomUUID()}`,
      skillManifestHash: skillIdentity.manifestHash, prompt: "Synthetic task", runToken: "a".repeat(43), timeoutSeconds: 30,
      profile: { gatewayOrigin: AGENT_GATEWAY_ORIGIN, modelId: "fixture", contextWindowTokens: 128000,
        maxOutputTokens: 4096, developerInstructions: "Synthetic", mcpMode: "off" as const, mcpTimeoutSeconds: 90 } };
    await expect(runtime.startAgent(start)).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
    await runtime.prepareSkillRun({ ...skillIdentity, initial: [] });
    await runtime.completeSkillRunPreparation(skillIdentity);
    await expect(runtime.startAgent({ ...start, skillManifestHash: "f".repeat(64) })).rejects.toMatchObject({ code: "workspace_skills_prepare_failed" });
    const bytes = Buffer.from(await new Response(tarGzipStream((async function* () {
      yield { path: "SKILL.md", content: "Synthetic", mtime: new Date(0) };
    })())).arrayBuffer());
    const install = { ...skillIdentity, bundle: { alias: "example", revisionId: "revision", bundleDigest: "b".repeat(64), discover: false },
      byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") };
    const archive = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    value.fs.writeStream.mockImplementationOnce(async () => ({ write: vi.fn(async () => { entered(); await barrier; }),
      close: vi.fn(async () => {}), async [Symbol.asyncDispose]() {} }));
    const execStreamWith = vi.fn(async () => ({ recv: vi.fn(async () => null), kill: vi.fn(async () => {}) }));
    Object.assign(value.sandbox, { execStreamWith });
    const pendingInstall = runtime.installSkillBundle({ ...install, archive: archive() });
    await writing;
    const pendingStart = runtime.startAgent(start);
    await Promise.resolve(); expect(execStreamWith).not.toHaveBeenCalled();
    release(); await pendingInstall; await pendingStart;
    expect(value.fs.writeStream).toHaveBeenCalledTimes(1);
    await expect(runtime.installSkillBundle({ ...install, archive: archive() })).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    await expect(runtime.prepareSkillRun({ ...skillIdentity, modelRunId: "next", initial: [] })).rejects.toMatchObject({ code: "workspace_runtime_incompatible" });
    expect(value.fs.writeStream).toHaveBeenCalledTimes(1);
  });

  it("retains the Skills mutex until cancellation has stopped the exact guest", async () => {
    const value = fixture();
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-runtime-")); skillDirectories.push(directory);
    const runtime = new MicrosandboxWorkspaceRuntime(config, undefined, directory);
    await runtime.ensureSession(ensureInput);
    await runtime.prepareSkillRun({ ...skillIdentity, initial: [] });
    let reading!: () => void; let stopped!: () => void;
    const entered = new Promise<void>(resolve => { reading = resolve; });
    const stop = new Promise<void>(resolve => { stopped = resolve; });
    value.sandbox.stopWithTimeout.mockImplementationOnce(async () => { await stop; });
    const controller = new AbortController();
    const pending = runtime.installSkillBundle({ ...skillIdentity, signal: controller.signal,
      bundle: { alias: "example", revisionId: "revision", bundleDigest: "b".repeat(64), discover: false },
      byteSize: 1, checksum: "c".repeat(64), archive: new ReadableStream<Uint8Array>({ pull() { reading(); } }, { highWaterMark: 0 }) });
    const rejected = expect(pending).rejects.toThrow("synthetic_cancelled");
    await entered; controller.abort(new Error("synthetic_cancelled"));
    const next = runtime.prepareSkillRun({ ...skillIdentity, modelRunId: "next", initial: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(value.sandbox.stopWithTimeout).toHaveBeenCalledTimes(1);
    expect(value.sandbox.execWith).toHaveBeenCalledTimes(1);
    stopped(); await rejected; await next;
    expect(value.sandbox.execWith).toHaveBeenCalledTimes(2);
    expect(value.fs.writeStream).not.toHaveBeenCalled();
  });

  it.each([true, false])("reports only a proven SDK timeout before the public fallback (typed=%s)", async (typed) => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    sdk.callTool.mockRejectedValueOnce(typed ? new McpError(ErrorCode.RequestTimeout, "PRIVATE_TIMEOUT_CANARY") : new Error("PRIVATE_UNKNOWN_CANARY"));
    await expect(runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 1 }, () => value.runtime.callBoundTool(callInput)))
      .rejects.toMatchObject({ code: "workspace_tool_timeout" });
    expect(sdk.callTool).toHaveBeenCalledOnce();
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({ event: "tool_deadline", tool_kind: "workspace", configured_timeout_ms: config.syncToolTimeoutSeconds * 1_000,
      effective_timeout_ms: config.syncToolTimeoutSeconds * 1_000, request_timeout_ms: config.syncToolTimeoutSeconds * 1_000 + 5_000 }));
    expect(records).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "request", outcome: "failed", reason: typed ? "deadline" : "unknown", tool_call_id: "stored" }));
    expect(records.filter((entry) => entry.event === "nested_abort")).toHaveLength(typed ? 1 : 0);
    if (typed) expect(records).toContainEqual(expect.objectContaining({ event: "nested_abort", abort_source: "workspace_deadline", deadline_kind: "sdk_request", timeout_ms: config.syncToolTimeoutSeconds * 1_000 + 5_000 }));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("delivers accepted env to separate exec, shell and long-lived commands, then removes it for the next run", async () => {
    const value = fixture();
    await value.runtime.ensureSession(ensureInput);
    const builder = { args: vi.fn().mockReturnThis(), timeout: vi.fn().mockReturnThis(), stdinBytes: vi.fn().mockReturnThis() };
    value.sandbox.execWith.mockImplementationOnce(async (_command, configure) => {
      (configure as (input: typeof builder) => unknown)(builder);
      return { success: true, stdout: () => "", stdoutBytes: () => Buffer.from("") };
    });
    const token = "synthetic '\"$HOME`command`\nvalue";
    await value.runtime.syncPersonalSecrets({ ...sessionInput, modelRunId: callInput.modelRunId, secrets: [{
      id: randomUUID(), versionId: randomUUID(), name: "API access", description: "Synthetic fixture",
      value: { kind: "env", entries: [{ name: "SERVICE_TOKEN", value: token }] }
    }] });
    expect(JSON.stringify(builder.args.mock.calls)).not.toContain("SERVICE_TOKEN");
    expect(JSON.parse(builder.stdinBytes.mock.calls[0]![0].toString())).toMatchObject({ environment: { SERVICE_TOKEN: token } });
    expect(process.env.SERVICE_TOKEN).not.toBe(token);
    sdk.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ ok: true, data: { execSessionId: "synthetic_exec" } }) }] });
    for (const originalName of ["sandbox_shell", "sandbox_exec", "sandbox_exec_start"] as const) {
      await value.runtime.callBoundTool({ ...callInput, originalName, arguments: { command: "env", env: { CALL_ONLY: "explicit" } } });
      expect(sdk.callTool).toHaveBeenLastCalledWith(expect.objectContaining({ arguments: expect.objectContaining({ env: { SERVICE_TOKEN: token, CALL_ONLY: "explicit" } }) }), undefined, expect.anything());
    }
    await value.runtime.syncPersonalSecrets({ ...sessionInput, modelRunId: "next_run", secrets: [] });
    await value.runtime.callBoundTool({ ...callInput, modelRunId: "next_run" });
    expect(sdk.callTool.mock.calls.at(-1)![0].arguments.env).toBeUndefined();
  });

  it("recovers managed env after receiver restart and fails preparation without dispatching a model command", async () => {
    const value = fixture();
    const environment = JSON.stringify({ RECOVERED_TOKEN: "synthetic-recovered" });
    value.sandbox.execWith.mockResolvedValueOnce({ success: true, stdout: () => environment, stdoutBytes: () => Buffer.from(environment) });
    const restarted = new MicrosandboxWorkspaceRuntime(config);
    await restarted.callBoundTool(callInput);
    expect(sdk.callTool).toHaveBeenLastCalledWith(expect.objectContaining({ arguments: expect.objectContaining({ env: { RECOVERED_TOKEN: "synthetic-recovered" } }) }), undefined, expect.anything());
    sdk.callTool.mockClear();
    value.sandbox.execWith.mockResolvedValue({ success: false, stdout: () => "", stdoutBytes: () => Buffer.from("") });
    await expect(restarted.syncPersonalSecrets({ ...sessionInput, modelRunId: "next", secrets: [] })).rejects.toMatchObject({ code: "workspace_secrets_prepare_failed" });
    await expect(restarted.callBoundTool({ ...callInput, modelRunId: "next" })).rejects.toMatchObject({ code: "workspace_secrets_prepare_failed" });
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("reads labelled inventory pages without connecting, touching or starting stopped environments", async () => {
    const value = fixture();
    const list = { cursor: vi.fn().mockReturnThis(), label: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis() };
    const touch = vi.fn();
    sdk.listWith.mockImplementationOnce(async (configure) => {
      expect(configure(list)).toBe(list);
      return { nextCursor: "next-fixture", sandboxes: [
        { ...value.handle, status: "stopped", touch },
        { ...value.handle, id: "second-runtime", name: "second-name", status: "running", touch }
      ] };
    });
    expect(await value.runtime.listSessions({ cursor: "first-fixture" })).toEqual({
      entries: [
        { runtimeSandboxId, sandboxName, state: "stopped" },
        { runtimeSandboxId: "second-runtime", sandboxName: "second-name", state: "running" }
      ], nextCursor: "next-fixture"
    });
    expect(list.label).toHaveBeenCalledWith("aiqsa.workspace", "true");
    expect(list.limit).toHaveBeenCalledWith(100);
    expect(list.cursor).toHaveBeenCalledWith("first-fixture");
    expect(touch).not.toHaveBeenCalled();
    expect(sdk.get).not.toHaveBeenCalled();
    expect(sdk.builder).not.toHaveBeenCalled();
    expect(value.handle.connectOrStart).not.toHaveBeenCalled();
    expect(value.handle.stopWithTimeout).not.toHaveBeenCalled();
    expect(value.sandbox.exec).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(value.runtime.listSessions({ signal: controller.signal })).rejects.toMatchObject({ code: "workspace_tool_cancelled" });
    expect(sdk.listWith).toHaveBeenCalledTimes(1);
  });

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

  it("treats stopping an already stopped disk as successful", async () => {
    const value = fixture();
    value.setState("stopped");
    value.handle.stopWithTimeout.mockRejectedValueOnce(new SandboxNotRunningError("already stopped"));
    await expect(value.runtime.stopSession({ ...sessionInput })).resolves.toBeUndefined();
    expect(value.handle.stopWithTimeout).toHaveBeenCalledOnce();
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

  it.each([true, false])("ignores empty package markers while exporting available deliverables (%s)", async (withArchive) => {
    const value = fixture();
    const outputDirectory = "/workspace/output/run_fixture";
    const emptyPath = `${outputDirectory}/tests/__init__.py`;
    const archivePath = `${outputDirectory}/project.tar.gz`;
    const archive = Buffer.from("synthetic archive bytes");
    value.files.set(emptyPath, Buffer.alloc(0));
    if (withArchive) value.files.set(archivePath, archive);
    value.fs.list.mockImplementation(async (directory) => directory === outputDirectory ? [
      { kind: "directory", path: `${outputDirectory}/tests`, size: 4096 },
      ...(withArchive ? [{ kind: "file", path: archivePath, size: archive.length }] : [])
    ] : [{ kind: "file", path: emptyPath, size: 0 }]);
    const outputs = await value.runtime.collectOutputs({ ...sessionInput, modelRunId: "run_fixture", outputDirectory });
    expect(outputs.map((output) => output.relativePath)).toEqual(withArchive ? ["project.tar.gz"] : []);
    expect(value.fs.readStream).not.toHaveBeenCalledWith(emptyPath);
    if (withArchive) {
      expect(outputs[0]!.checksum).toBe(createHash("sha256").update(archive).digest("hex"));
      expect(Buffer.from(await new Response(outputs[0]!.body).arrayBuffer())).toEqual(archive);
    }
  });

  it.each([-1, Number.NaN, 1.5])("still rejects an invalid output size %s", async (size) => {
    const value = fixture();
    const outputDirectory = "/workspace/output/run_fixture";
    value.files.set(`${outputDirectory}/result.txt`, Buffer.from("result"));
    value.fs.list.mockResolvedValueOnce([{ kind: "file", path: `${outputDirectory}/result.txt`, size }]);
    await expect(value.runtime.collectOutputs({ ...sessionInput, modelRunId: "run_fixture", outputDirectory }))
      .rejects.toMatchObject({ code: "workspace_output_export_failed" });
    expect(value.fs.readStream).not.toHaveBeenCalled();
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
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    sdk.callTool.mockResolvedValueOnce({ isError: true, content: [{
      type: "text", text: "status: Stopped; sandbox fixture-runtime; SDK details"
    }] });
    await expect(value.runtime.callBoundTool(callInput)).resolves.toEqual({
      content: [{ type: "text", text: "The Workspace operation failed." }], status: "error"
    });
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "request", outcome: "failed" }));
    expect(JSON.stringify(records)).not.toContain("SDK details");
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
