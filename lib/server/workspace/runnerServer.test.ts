import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { getContext, runWithContext } from "../observability";
import { observeWorkspaceHealth } from "./lifecycleObservability";
import { createWorkspaceRunnerServer } from "./runnerServer";
import { WorkspaceRuntimeError, type WorkspaceRuntime, type WorkspaceRuntimeHealth } from "./runtime";
import { parseWorkspaceRunEnvironment } from "./codeMcp";
import { RUNNER_GATEWAY_ORIGIN } from "./runnerGatewayRelay";

const token = "synthetic_runner_token_with_at_least_32_characters";
const sessionId = "ws_" + "a".repeat(40);
const body = { cpus: 1, diskMiB: 1024, memoryMiB: 512, imageRef: "fixture_image", internetEnabled: false,
  runtimeSandboxId: null, sessionId, sandboxName: workspaceSandboxName(sessionId),
  operation: { generation: 1, owner: "run:fixture" } };

/** The real request callback, without opening a socket or launching a server. */
function fixture(runtime: Partial<WorkspaceRuntime>, idleRefresh?: Readonly<{ intervalMs: number; lifetimeMs: number }>) {
  const server = createWorkspaceRunnerServer({ ...(idleRefresh ? { idleRefresh } : {}), runtime: runtime as WorkspaceRuntime, token });
  const handler = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  return async (url: string, value?: unknown, raw?: { body: Readable; headers: Record<string, string> }) => {
    const request = Object.assign(raw?.body ?? Readable.from(value === undefined ? [] : [JSON.stringify(value)]), {
      headers: { authorization: `Bearer ${token}`, ...raw?.headers }, method: value === undefined && !raw ? "GET" : "POST", url
    });
    const response = Object.assign(new EventEmitter(), { headersSent: false,
      setHeader: vi.fn(), writeHead: vi.fn(() => { response.headersSent = true; }), end: vi.fn(), destroy: vi.fn() });
    await handler(request as IncomingMessage, response as unknown as ServerResponse);
    return response;
  };
}

function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
  return { lines, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

afterEach(() => vi.restoreAllMocks());

describe("Workspace runner lifecycle diagnostics", () => {
  it("keeps the guest of a claimed operation awake until the operation is retired", async () => {
    vi.useFakeTimers();
    try {
      const touchSession = vi.fn(async () => undefined);
      const request = fixture({ stopSession: vi.fn(async () => undefined), touchSession },
        { intervalMs: 300_000, lifetimeMs: 3_900_000 });
      const operation = { operation: body.operation, runtimeSandboxId: null };
      expect((await request(`/v1/sessions/${sessionId}/operations/claim`, operation)).writeHead)
        .toHaveBeenCalledWith(200, expect.any(Object));
      await vi.advanceTimersByTimeAsync(600_000);
      expect(touchSession).toHaveBeenCalledTimes(2);
      expect(touchSession).toHaveBeenCalledWith({ sessionId });
      expect((await request(`/v1/sessions/${sessionId}/operations/retire`, operation)).writeHead)
        .toHaveBeenCalledWith(200, expect.any(Object));
      await vi.advanceTimersByTimeAsync(900_000);
      expect(touchSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read the original ahead while guest staging is stalled", async () => {
    let produced = 0;
    const stageAttachments = vi.fn(async (input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(produced).toBeLessThanOrEqual(8);
      await input.attachments[0]!.body.cancel();
    });
    const request = fixture({ stageAttachments, stopSession: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: body.sandboxName, state: "ready" as const })) });
    await request("/v1/sessions/ensure", body);
    const source = Readable.from((async function* () {
      for (let i = 0; i < 128; i++) { produced += 1; yield Buffer.alloc(64 * 1024); }
    })(), { objectMode: false, highWaterMark: 64 * 1024 });
    const response = await request(`/v1/sessions/${sessionId}/stage`, undefined, { body: source, headers: {
      "x-aiqsa-runtime-sandbox-id": "sandbox_fixture", "x-aiqsa-attachment-id": "attachment_fixture",
      "x-aiqsa-message-id": "message_fixture", "x-aiqsa-file-name": Buffer.from("original.bin").toString("base64url"),
      "x-aiqsa-file-kind": "file", "x-aiqsa-checksum": "a".repeat(64), "x-aiqsa-byte-size": String(128 * 64 * 1024),
      "x-aiqsa-mime-type": "application/octet-stream", "x-aiqsa-workspace-operation": JSON.stringify(body.operation)
    } });
    expect(stageAttachments).toHaveBeenCalledOnce();
    expect(response.writeHead).toHaveBeenCalledWith(204);
    expect(source.destroyed).toBe(true);
  });

  it("joins the authenticated tool request to its existing server run and call identities", async () => {
    let context: ReturnType<typeof getContext>;
    const callBoundTool = vi.fn(async () => {
      context = getContext();
      return { content: [], status: "complete" as const };
    });
    const request = fixture({ callBoundTool, stopSession: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: body.sandboxName, state: "ready" as const })) });
    await request("/v1/sessions/ensure", body);
    const response = await runWithContext({ run_id: "foreign_run", tool_call_id: "foreign_call" }, () => request(
      `/v1/sessions/${sessionId}/tools/sandbox_fs_read/call`,
      { operation: body.operation, arguments: {}, runtimeSandboxId: "sandbox_fixture",
        modelRunId: "server_run", modelRunToolCallId: "server_call" }
    ));
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(callBoundTool).toHaveBeenCalledOnce();
    expect(context).toMatchObject({ run_id: "server_run", tool_call_id: "server_call" });
    expect(context).not.toHaveProperty("execution_index");
    expect(getContext()).toBeUndefined();
  });

  it("passes a code invocation id and run environment only in their exact shapes", async () => {
    const callBoundTool = vi.fn(async () => ({ content: [], status: "complete" as const }));
    const syncPersonalSecrets = vi.fn(async () => undefined);
    const request = fixture({ callBoundTool, syncPersonalSecrets, stopSession: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: body.sandboxName, state: "ready" as const })) });
    await request("/v1/sessions/ensure", body);
    const tool = (invocationId: unknown, agent?: unknown) => request(`/v1/sessions/${sessionId}/tools/sandbox_shell/call`,
      { operation: body.operation, arguments: { command: "python3 report.py" }, runtimeSandboxId: "sandbox_fixture",
        modelRunId: "server_run", modelRunToolCallId: "server_call", ...(invocationId === undefined ? {} : { invocationId }),
        ...(agent === undefined ? {} : { agent }) });
    const browserAgent = { kind: "subagent", name: "shop-amazon", threadId: "thread-7" };
    expect((await tool("e".repeat(32), browserAgent)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(callBoundTool).toHaveBeenLastCalledWith(expect.objectContaining({ invocationId: "e".repeat(32) }));
    expect(callBoundTool).toHaveBeenLastCalledWith(expect.objectContaining({ agent: browserAgent }));
    expect((await tool(undefined)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(callBoundTool).toHaveBeenLastCalledWith(expect.not.objectContaining({ invocationId: expect.anything() }));
    for (const invalid of ["E".repeat(32), "e".repeat(31), 1, null]) {
      expect((await tool(invalid)).writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
    expect(callBoundTool).toHaveBeenCalledTimes(2);
    const secrets = (runEnvironment: unknown, agent?: unknown) => request(`/v1/sessions/${sessionId}/secrets`, { operation: body.operation,
      secrets: [], modelRunId: "server_run", runtimeSandboxId: "sandbox_fixture", ...(runEnvironment === undefined ? {} : { runEnvironment }),
      ...(agent === undefined ? {} : { agent }) });
    const bearer = { AIQSA_GATEWAY_URL: "http://host.microsandbox.internal:4311", AIQSA_RUN_TOKEN: "r".repeat(43) };
    expect((await secrets(bearer)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(syncPersonalSecrets).toHaveBeenLastCalledWith(expect.objectContaining({ runEnvironment: bearer }));
    const agent = { kind: "subagent", name: "shop-amazon", threadId: "thread-7" };
    expect((await secrets(bearer, agent)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(syncPersonalSecrets).toHaveBeenLastCalledWith(expect.objectContaining({ agent,
      runEnvironment: bearer }));
    const forwardedEnvironment = syncPersonalSecrets.mock.lastCall?.[0].runEnvironment;
    expect(parseWorkspaceRunEnvironment(forwardedEnvironment, RUNNER_GATEWAY_ORIGIN)).toEqual(bearer);
    for (const invalid of [{ ...bearer, AIQSA_GATEWAY_URL: "https://attacker.example" }, { PATH: "/tmp" }, "AIQSA_RUN_TOKEN=x"]) {
      expect((await secrets(invalid)).writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
    expect(syncPersonalSecrets).toHaveBeenCalledTimes(2);
    const bounded = (boundUvCache: unknown) => request(`/v1/sessions/${sessionId}/secrets`, { operation: body.operation,
      secrets: [], modelRunId: "server_run", runtimeSandboxId: "sandbox_fixture", boundUvCache });
    expect((await bounded(true)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(syncPersonalSecrets).toHaveBeenLastCalledWith(expect.objectContaining({ boundUvCache: true }));
    expect((await bounded(false)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(syncPersonalSecrets).toHaveBeenLastCalledWith(expect.not.objectContaining({ boundUvCache: expect.anything() }));
    expect((await bounded("yes")).writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(syncPersonalSecrets).toHaveBeenCalledTimes(4);
  });

  it.each([
    { code: "workspace_session_create_failed" as const, status: 400, level: "error", outcome: "failed" },
    { code: "workspace_operation_stale" as const, status: 409, level: "info", outcome: "stale" },
    { code: "workspace_tool_cancelled" as const, status: 400, level: "info", outcome: "cancelled" }
  ])("observes $code while preserving the public status", async ({ code, status, level, outcome }) => {
    const output = capture();
    const runtimeContexts: Array<ReturnType<typeof getContext>> = [];
    const request = fixture({ stopSession: vi.fn(async () => undefined), ensureSession: vi.fn(async () => {
      runtimeContexts.push(getContext());
      throw Object.assign(new WorkspaceRuntimeError(code), { message: "PRIVATE_RUNNER_DETAIL" });
    }) });
    await runWithContext({ trace_id: "a".repeat(32), run_id: "foreign_run", job_id: "foreign_job" }, async () => {
      const response = await request("/v1/sessions/ensure?private=PRIVATE_QUERY", body);
      expect(response.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
      expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: code }));
    });
    expect(output.records()).toEqual([expect.objectContaining({
      event: "runtime_lifecycle", subsystem: "workspace", stage: "initialize", code, level, outcome, httpStatus: status
    })]);
    expect(runtimeContexts[0]).not.toHaveProperty("run_id");
    expect(runtimeContexts[0]).not.toHaveProperty("job_id");
    expect(runtimeContexts[0]?.trace_id).not.toBe("a".repeat(32));
    expect(output.lines.join("")).not.toContain("PRIVATE");
    expect(output.lines.join("")).not.toContain("foreign_");
  });

  it("serves the live browser channel under the run's operation, quietly, with exact actions only", async () => {
    const output = capture();
    const browserLive = vi.fn(async (input: Parameters<NonNullable<WorkspaceRuntime["browserLive"]>>[0]) =>
      input.action === "poll" ? { action: "poll" as const, chunks: ["@2 {}\n"], done: false, nextCursor: input.cursor + 1, truncated: false }
        : { action: "start" as const, execSessionId: "exec_fixture" });
    const request = fixture({ browserLive, stopSession: vi.fn(async () => undefined),
      ensureSession: vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: body.sandboxName, state: "ready" as const })) });
    await request("/v1/sessions/ensure", body);
    const identity = { operation: body.operation, modelRunId: "run_fixture", runtimeSandboxId: "sandbox_fixture" };
    const live = (value: Record<string, unknown>) => request(`/v1/sessions/${sessionId}/browser-live`, { ...identity, ...value });
    const started = await live({ action: "start", stdin: "{\"t\":\"frames\",\"on\":true}\n" });
    expect(started.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(started.end).toHaveBeenCalledWith(JSON.stringify({ action: "start", execSessionId: "exec_fixture" }));
    expect((await live({ action: "poll", cursor: 4, execSessionId: "exec_fixture" })).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(browserLive).toHaveBeenLastCalledWith(expect.objectContaining({ action: "poll", cursor: 4, execSessionId: "exec_fixture",
      modelRunId: "run_fixture", runtimeSandboxId: "sandbox_fixture", sessionId }));
    for (const invalid of [{ action: "exec", command: "sh" }, { action: "poll", cursor: -1, execSessionId: "exec_fixture" },
      { action: "write", data: "x".repeat(70_000), execSessionId: "exec_fixture" }, { action: "close", execSessionId: "../x" }]) {
      expect((await live(invalid)).writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
    const stale = await live({ action: "poll", cursor: 0, execSessionId: "exec_fixture", operation: { generation: 9, owner: "run:other" } });
    expect(stale.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
    expect(browserLive).toHaveBeenCalledTimes(2);
    // Answered requests write nothing; only refusals leave a content-free record.
    expect(output.records().every((record) => record.event === "runtime_lifecycle" && record.outcome !== "completed")).toBe(true);
    expect(output.lines.join("")).not.toContain("frames");
  });

  it("rejects a tool call body above its bound before dispatch and serves no Agent routes", async () => {
    capture();
    const ensureSession = vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: body.sandboxName, state: "ready" as const }));
    const callBoundTool = vi.fn();
    const request = fixture({ ensureSession, callBoundTool, stopSession: vi.fn(async () => undefined) });
    await request("/v1/sessions/ensure", body);
    const identity = { operation: body.operation, modelRunId: "run_fixture", runtimeSandboxId: "sandbox_fixture" };
    const tool = await request(`/v1/sessions/${sessionId}/tools/sandbox_fs_write/call`, { ...identity,
      modelRunToolCallId: "call_fixture", arguments: { path: "/workspace/project/a", content: "x".repeat(2 * 1_024 * 1_024) } });
    expect(tool.end).toHaveBeenCalledWith(JSON.stringify({ error: "workspace_request_too_large" }));
    expect(callBoundTool).not.toHaveBeenCalled();
    // The Codex Agent's start, poll and interrupt routes went with it.
    for (const route of ["start", "poll", "interrupt"]) {
      const response = await request(`/v1/sessions/${sessionId}/agent/${route}`, { ...identity, runtimeExecSessionId: "agent-fixture" });
      expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    }
  });

  it("keeps healthy probes quiet and recovers only the matching health boundary", async () => {
    const output = capture();
    let health: WorkspaceRuntimeHealth = { state: "ready" };
    const probe = vi.fn(async () => health);
    const request = fixture({ health: probe });
    await request("/health");
    await request("/health");
    expect(output.records()).toEqual([]);
    health = { state: "unavailable", reasonCode: "workspace_runtime_unavailable" };
    for (let index = 0; index < 4; index += 1) await request("/health");
    observeWorkspaceHealth({ state: "ready" }, "app");
    expect(output.records()).toHaveLength(1);
    health = { state: "ready" };
    await request("/health");
    await request("/health");
    expect(output.records()).toEqual([
      expect.objectContaining({ event: "runtime_lifecycle", code: "workspace_runtime_unavailable", outcome: "failed" }),
      expect.objectContaining({ event: "subsystem.recovered", repeat_count: 3 })
    ]);
    expect(probe).toHaveBeenCalledTimes(8);
  });
});
