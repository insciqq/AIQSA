import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import { getWorkspaceConfig } from "./config";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";

const input = { arguments: { command: "PRIVATE_COMMAND_CANARY" }, modelRunId: "PRIVATE_RUN_CANARY", modelRunToolCallId: "PRIVATE_CALL_CANARY",
  originalName: "sandbox_shell" as const, operation: { generation: 1, owner: "PRIVATE_OWNER_CANARY" }, runtimeSandboxId: "PRIVATE_SANDBOX_CANARY", sessionId: "PRIVATE_SESSION_CANARY" };
function fixture() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  const runtime = new RemoteWorkspaceRuntime({ ...getWorkspaceConfig({}), runtimeMode: "remote", runnerUrl: new URL("https://PRIVATE_HOST_CANARY.example"), runnerToken: "PRIVATE_TOKEN_CANARY" });
  return { request, runtime, records: () => writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>) };
}

describe("Workspace remote tool observations", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["complete", "error"] as const)("preserves HTTP 200 and returned %s without logging content", async (status) => {
    const { request, runtime, records } = fixture();
    const result = { status, content: [{ type: "text", text: "PRIVATE_RESULT_CANARY" }] };
    request.mockResolvedValue(new Response(JSON.stringify(result)));
    await expect(runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 3 }, () => runtime.callBoundTool(input))).resolves.toEqual(result);
    expect(request).toHaveBeenCalledOnce();
    expect(records()).toContainEqual(expect.objectContaining({ event: "tool_execution", tool_kind: "workspace", stage: "request", outcome: status === "error" ? "failed" : "completed", httpStatus: 200, tool_call_id: "stored", execution_index: 3 }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it.each([
    [503, '{"error":"workspace_tool_timeout","message":"PRIVATE_BODY_CANARY"}', "workspace_tool_timeout"],
    [200, 'PRIVATE_INVALID_JSON_CANARY{', "workspace_runtime_incompatible"],
    [200, '{"content":[],"status":"PRIVATE_INVALID_STATUS_CANARY"}', "workspace_runtime_incompatible"]
  ] as const)("retains HTTP %i on a failed RPC result", async (status, body, code) => {
    const { request, runtime, records } = fixture();
    request.mockResolvedValue(new Response(body, { status }));
    await expect(runtime.callBoundTool(input)).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledOnce();
    expect(records().filter((entry) => entry.outcome === "completed")).toHaveLength(0);
    expect(records()).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "request", outcome: "failed", httpStatus: status, code }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("records a socket failure before the existing generic runner mapping", async () => {
    const { request, runtime, records } = fixture();
    request.mockRejectedValue(Object.assign(new Error("PRIVATE_SOCKET_CANARY"), { code: "ECONNRESET" }));
    await expect(runtime.callBoundTool(input)).rejects.toMatchObject({ code: "workspace_runtime_unavailable" });
    const failures = records().filter((entry) => entry.outcome === "failed");
    expect(failures).toEqual([expect.objectContaining({ stage: "request", code: "ECONNRESET", reason: "network" })]);
    expect(failures[0]).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("keeps original context on parent cancellation from another request", async () => {
    const { request, runtime, records } = fixture();
    const controller = new AbortController();
    request.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored" }, () => runtime.callBoundTool({ ...input, signal: controller.signal })).catch((error: unknown) => error);
    runWithContext({ trace_id: "2".repeat(32) }, () => controller.abort(new Error("PRIVATE_STOP_CANARY")));
    expect(await pending).toMatchObject({ code: "workspace_tool_cancelled" });
    expect(records().filter((entry) => entry.event === "nested_abort")).toEqual([
      expect.objectContaining({ trace_id: "1".repeat(32), tool_call_id: "stored", layer: "workspace", abort_source: "parent_signal" })
    ]);
    expect(records()).toContainEqual(expect.objectContaining({ stage: "request", outcome: "cancelled" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("retains response status when cancellation happens inside the existing body reader", async () => {
    const { request, runtime, records } = fixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_BODY_STOP_CANARY");
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{"PRIVATE_BODY_CANARY":'));
      controller.signal.addEventListener("abort", () => stream.error(reason), { once: true });
    } });
    request.mockResolvedValue(new Response(body, { status: 206 }));
    const pending = runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored" }, () => runtime.callBoundTool({ ...input, signal: controller.signal })).catch((error: unknown) => error);
    await Promise.resolve();
    runWithContext({ trace_id: "2".repeat(32) }, () => controller.abort(reason));
    expect(await pending).toBe(reason);
    expect(records()).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "request", outcome: "cancelled", httpStatus: 206, reason: "cancelled" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });
});
