import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { getContext, runWithContext } from "../observability";
import { observeWorkspaceHealth } from "./lifecycleObservability";
import { AGENT_PROMPT_MAX_BYTES } from "../agents/guest";
import { CODEX_DEVELOPER_INSTRUCTIONS_MAX_BYTES } from "../agents/codexProfile";
import { CODEX_OUTPUT_LIMITS } from "../agents/codexProtocol";
import { AGENT_START_BODY_MAX_BYTES, createWorkspaceRunnerServer } from "./runnerServer";
import { WorkspaceRuntimeError, type WorkspaceRuntime, type WorkspaceRuntimeHealth } from "./runtime";

const token = "synthetic_runner_token_with_at_least_32_characters";
const sessionId = "ws_" + "a".repeat(40);
const body = { cpus: 1, diskMiB: 1024, memoryMiB: 512, imageRef: "fixture_image", internetEnabled: false,
  runtimeSandboxId: null, sessionId, sandboxName: workspaceSandboxName(sessionId),
  operation: { generation: 1, owner: "run:fixture" } };

/** The real request callback, without opening a socket or launching a server. */
function fixture(runtime: Partial<WorkspaceRuntime>) {
  const server = createWorkspaceRunnerServer({ runtime: runtime as WorkspaceRuntime, token });
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
    const tool = (invocationId: unknown) => request(`/v1/sessions/${sessionId}/tools/sandbox_shell/call`,
      { operation: body.operation, arguments: { command: "python3 report.py" }, runtimeSandboxId: "sandbox_fixture",
        modelRunId: "server_run", modelRunToolCallId: "server_call", ...(invocationId === undefined ? {} : { invocationId }) });
    expect((await tool("e".repeat(32))).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(callBoundTool).toHaveBeenLastCalledWith(expect.objectContaining({ invocationId: "e".repeat(32) }));
    expect((await tool(undefined)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(callBoundTool).toHaveBeenLastCalledWith(expect.not.objectContaining({ invocationId: expect.anything() }));
    for (const invalid of ["E".repeat(32), "e".repeat(31), 1, null]) {
      expect((await tool(invalid)).writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
    expect(callBoundTool).toHaveBeenCalledTimes(2);
    const secrets = (runEnvironment: unknown) => request(`/v1/sessions/${sessionId}/secrets`, { operation: body.operation,
      secrets: [], modelRunId: "server_run", runtimeSandboxId: "sandbox_fixture", ...(runEnvironment === undefined ? {} : { runEnvironment }) });
    const bearer = { AIQSA_GATEWAY_URL: "http://host.microsandbox.internal:4311", AIQSA_RUN_TOKEN: "r".repeat(43) };
    expect((await secrets(bearer)).writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(syncPersonalSecrets).toHaveBeenLastCalledWith(expect.objectContaining({ runEnvironment: bearer }));
    for (const invalid of [{ ...bearer, AIQSA_GATEWAY_URL: "https://attacker.example" }, { PATH: "/tmp" }, "AIQSA_RUN_TOKEN=x"]) {
      expect((await secrets(invalid)).writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
    expect(syncPersonalSecrets).toHaveBeenCalledOnce();
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

  describe("Agent transport bounds", () => {
    const identity = { operation: body.operation, modelRunId: "run_fixture", runtimeExecSessionId: "agent-fixture",
      runtimeSandboxId: "sandbox_fixture" };
    const ensureSession = vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: body.sandboxName, state: "ready" as const }));
    const profile = { gatewayOrigin: "http://gateway.invalid", modelId: "fixture-model", contextWindowTokens: 8_192,
      maxOutputTokens: 1_024, developerInstructions: "\u0001".repeat(CODEX_DEVELOPER_INSTRUCTIONS_MAX_BYTES),
      mcpMode: "off", mcpTimeoutSeconds: 30 };
    const start = { ...identity, profile, skillManifestHash: "b".repeat(64), runToken: "run_token_fixture", timeoutSeconds: null };

    it("accepts a maximal worst-case escaped prompt and server instructions at the default configuration", async () => {
      const prompts: string[] = [];
      const startAgent = vi.fn(async (input: Parameters<NonNullable<WorkspaceRuntime["startAgent"]>>[0]) => {
        prompts.push(input.prompt);
      });
      const request = fixture({ ensureSession, startAgent, stopSession: vi.fn(async () => undefined) });
      await request("/v1/sessions/ensure", body);
      for (const unit of ["\u0001", "\"\\", "é🧪"]) {
        const prompt = unit.repeat(Math.floor(AGENT_PROMPT_MAX_BYTES / Buffer.byteLength(unit)));
        // The escaped control-character prompt alone exceeds the former 2 MiB body bound.
        if (unit === "\u0001") expect(Buffer.byteLength(JSON.stringify(prompt))).toBeGreaterThan(4 * AGENT_PROMPT_MAX_BYTES);
        const response = await request(`/v1/sessions/${sessionId}/agent/start`, { ...start, prompt });
        expect(response.end).toHaveBeenCalledWith(JSON.stringify({ started: true }));
        expect(prompts.at(-1) === prompt).toBe(true);
      }
      expect(startAgent).toHaveBeenCalledTimes(3);
    });

    it("rejects a start body above its bound as oversized before dispatch", async () => {
      capture();
      const startAgent = vi.fn(async () => undefined);
      const request = fixture({ ensureSession, startAgent, stopSession: vi.fn(async () => undefined) });
      await request("/v1/sessions/ensure", body);
      const response = await request(`/v1/sessions/${sessionId}/agent/start`,
        { ...start, prompt: "fixture", padding: "x".repeat(AGENT_START_BODY_MAX_BYTES) });
      expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "workspace_request_too_large" }));
      const tool = await request(`/v1/sessions/${sessionId}/tools/sandbox_fs_write/call`, { ...identity,
        modelRunToolCallId: "call_fixture", arguments: { path: "/workspace/project/a", content: "x".repeat(2 * 1_024 * 1_024) } });
      expect(tool.end).toHaveBeenCalledWith(JSON.stringify({ error: "workspace_request_too_large" }));
      expect(startAgent).not.toHaveBeenCalled();
    });

    it("pages Agent output past 64 MiB up to the execution total, never beyond it", async () => {
      capture();
      const cursors: number[] = [];
      const pollAgent = vi.fn(async (input: Parameters<NonNullable<WorkspaceRuntime["pollAgent"]>>[0]) => {
        cursors.push(input.cursor);
        return { cursor: input.cursor, nextCursor: input.cursor, stdoutBase64: "", done: false, exitCode: null };
      });
      const request = fixture({ ensureSession, pollAgent, stopSession: vi.fn(async () => undefined) });
      await request("/v1/sessions/ensure", body);
      for (const cursor of [64 * 1_024 * 1_024 + 1, CODEX_OUTPUT_LIMITS.totalBytes]) {
        const response = await request(`/v1/sessions/${sessionId}/agent/poll`, { ...identity, cursor });
        expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      }
      const beyond = await request(`/v1/sessions/${sessionId}/agent/poll`, { ...identity, cursor: CODEX_OUTPUT_LIMITS.totalBytes + 1 });
      expect(beyond.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(cursors).toEqual([64 * 1_024 * 1_024 + 1, CODEX_OUTPUT_LIMITS.totalBytes]);
      expect(CODEX_OUTPUT_LIMITS.totalBytes).toBeGreaterThan(64 * 1_024 * 1_024);
    });
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
