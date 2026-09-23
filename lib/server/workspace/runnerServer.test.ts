import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { getContext, runWithContext } from "../observability";
import { observeWorkspaceHealth } from "./lifecycleObservability";
import { createWorkspaceRunnerServer } from "./runnerServer";
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
