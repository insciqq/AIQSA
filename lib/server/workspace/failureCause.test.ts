import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { serializeEvent } from "../observability/runtime.cjs";
import { getWorkspaceConfig } from "./config";
import { workspaceMcpFailure } from "./operationFailure";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";
import { createWorkspaceRunnerServer } from "./runnerServer";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "./runtime";
import {
  observeWorkspaceToolExecution, retainWorkspaceFailureCause, WORKSPACE_FAILURE_CAUSES, workspaceFailureCause
} from "./toolObservability";

const token = "synthetic_runner_token_with_at_least_32_characters";
const sessionId = "ws_" + "b".repeat(40);
const operation = { generation: 1, owner: "run:fixture" };
const ensure = { cpus: 1, diskMiB: 1024, memoryMiB: 512, imageRef: "fixture_image", internetEnabled: false,
  runtimeSandboxId: null, sessionId, sandboxName: workspaceSandboxName(sessionId), operation };
const call = { arguments: { path: "PRIVATE_PATH_CANARY" }, modelRunId: "run_fixture", modelRunToolCallId: "call_fixture",
  originalName: "sandbox_fs_read" as const, operation, runtimeSandboxId: "sandbox_fixture", sessionId };

/** The runner's real request callback over a fake runtime, without a socket; answers its status and body. */
async function runnerAnswer(callBoundTool: WorkspaceRuntime["callBoundTool"]): Promise<Response> {
  const runtime = { callBoundTool, stopSession: vi.fn(async () => undefined),
    ensureSession: vi.fn(async () => ({ runtimeSandboxId: "sandbox_fixture", sandboxName: ensure.sandboxName, state: "ready" as const })) };
  const server = createWorkspaceRunnerServer({ runtime: runtime as unknown as WorkspaceRuntime, token });
  const handler = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  const send = async (url: string, value: unknown) => {
    const request = Object.assign(Readable.from([JSON.stringify(value)]), {
      headers: { authorization: `Bearer ${token}` }, method: "POST", url });
    let status = 0;
    let body = "";
    const response = Object.assign(new EventEmitter(), { headersSent: false, setHeader: vi.fn(),
      writeHead: vi.fn((code: number) => { status = code; response.headersSent = true; }),
      end: vi.fn((chunk?: unknown) => { body = chunk === undefined ? "" : String(chunk); }), destroy: vi.fn() });
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return new Response(body, { status });
  };
  await send("/v1/sessions/ensure", ensure);
  return send(`/v1/sessions/${sessionId}/tools/sandbox_fs_read/call`, { operation, arguments: call.arguments,
    runtimeSandboxId: "sandbox_fixture", modelRunId: call.modelRunId, modelRunToolCallId: call.modelRunToolCallId });
}

function app(answer: Response) {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(answer));
  const runtime = new RemoteWorkspaceRuntime({ ...getWorkspaceConfig({}), runtimeMode: "remote",
    runnerUrl: new URL("https://runner.example"), runnerToken: token });
  return { runtime, records: () => writer.mock.calls.flatMap(([line]) => {
    try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; }
  }).filter((record) => record.event === "tool_execution" && record.outcome !== "started") };
}

describe("Workspace failure causes from the runner to the app", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("carries a guest operation failure's cause into the app's tool records, never into the result", async () => {
    const answer = await runnerAnswer(async () => workspaceMcpFailure({ isError: true, content: [{ type: "text",
      text: JSON.stringify({ ok: false, error: { code: "operation_failed", message: "PRIVATE_SDK_MESSAGE" } }) }] }, 4096, "sandbox_fs_read")!);
    const wire = await answer.clone().json() as Record<string, unknown>;
    expect(wire).toMatchObject({ status: "error", errorCode: "workspace_operation_failed", failureCause: "guest_operation_failed" });
    const { runtime, records } = app(answer);
    const result = await observeWorkspaceToolExecution(() => runtime.callBoundTool(call));
    expect(result).not.toHaveProperty("failureCause");
    expect(workspaceFailureCause(result)).toBe("guest_operation_failed");
    expect(records().map((record) => [record.stage, record.code, record.reason, record.operation ?? null])).toEqual([
      ["request", "workspace_operation_failed", "guest_operation_failed", "sandbox_fs_read"],
      ["execution", undefined, "guest_operation_failed", null],
      ["result", undefined, "guest_operation_failed", null]
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("carries a thrown failure's cause beside its code and ignores an unreviewed one", async () => {
    const answer = await runnerAnswer(async () => {
      throw retainWorkspaceFailureCause(new WorkspaceRuntimeError("workspace_tool_outcome_unknown"), "transport_closed");
    });
    expect(answer.status).toBe(400);
    expect(await answer.clone().json()).toEqual({ error: "workspace_tool_outcome_unknown", cause: "transport_closed" });
    const { runtime, records } = app(answer);
    await expect(runtime.callBoundTool(call)).rejects.toMatchObject({ code: "workspace_tool_outcome_unknown" });
    expect(records()).toEqual([expect.objectContaining({ stage: "request", outcome: "failed",
      code: "workspace_tool_outcome_unknown", reason: "transport_closed", operation: "sandbox_fs_read", httpStatus: 400 })]);

    vi.restoreAllMocks();
    const forged = app(new Response(JSON.stringify({ error: "workspace_tool_outcome_unknown", cause: "PRIVATE_CAUSE" }), { status: 400 }));
    await expect(forged.runtime.callBoundTool(call)).rejects.toMatchObject({ code: "workspace_tool_outcome_unknown" });
    expect(JSON.stringify(forged.records())).not.toContain("PRIVATE_");
  });

  it("validates every cause and Workspace operation at the logging leaf", () => {
    for (const cause of WORKSPACE_FAILURE_CAUSES) {
      const line = JSON.parse(serializeEvent("tool_execution", { tool_kind: "workspace", stage: "request", outcome: "failed",
        reason: cause, operation: "sandbox_exec_start" })!) as Record<string, unknown>;
      expect(line).toMatchObject({ reason: cause, operation: "sandbox_exec_start" });
    }
    const forged = JSON.parse(serializeEvent("tool_execution", { tool_kind: "workspace", stage: "request", outcome: "failed",
      reason: "PRIVATE" as never, operation: "PRIVATE_TOOL" })!) as Record<string, unknown>;
    expect(forged).not.toHaveProperty("reason");
    expect(forged).not.toHaveProperty("operation");
  });
});
