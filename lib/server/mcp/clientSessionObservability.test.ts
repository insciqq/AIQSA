import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import { McpClientSession } from "./clientSession";

function capture() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

async function session() {
  vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  vi.spyOn(Client.prototype, "getServerVersion").mockReturnValue({ name: "PRIVATE_SERVER_CANARY", version: "1.0.0" });
  vi.spyOn(Client.prototype, "getServerCapabilities").mockReturnValue({ tools: {} });
  const value = new McpClientSession({
    url: new URL("https://PRIVATE_URL_CANARY.example/mcp"), fetch: vi.fn(), headers: { authorization: "Bearer PRIVATE_TOKEN_CANARY" }, requestTimeoutMs: 60_000,
    limits: { maxListPages: 4, maxToolArgumentBytes: 1_024, maxToolMetadataBytes: 2_048, maxToolResultBytes: 2_048, maxToolSchemaBytes: 2_048, maxTools: 16 }
  });
  await value.initialize();
  return value;
}

describe("MCP tool request observations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records the effective SDK deadline before preserving its public timeout", async () => {
    const records = capture();
    const value = await session();
    const call = vi.spyOn(Client.prototype, "callTool").mockRejectedValue(new SdkError(SdkErrorCode.RequestTimeout, "PRIVATE_TIMEOUT_CANARY"));
    await expect(runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 1 }, () =>
      value.callTool("PRIVATE_TOOL_CANARY", { secret: "PRIVATE_ARGUMENT_CANARY" }, { timeoutMs: 20 }))).rejects.toMatchObject({ code: "mcp_request_timeout" });
    expect(call).toHaveBeenCalledOnce();
    expect(records()).toContainEqual(expect.objectContaining({ event: "tool_deadline", tool_kind: "mcp", configured_timeout_ms: 60_000, effective_timeout_ms: 20, request_timeout_ms: 20 }));
    expect(records()).toContainEqual(expect.objectContaining({ event: "nested_abort", trace_id: "1".repeat(32), tool_call_id: "stored", abort_source: "mcp_deadline", deadline_kind: "sdk_request", timeout_ms: 20 }));
    expect(records()).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "request", outcome: "failed", code: "mcp_request_timeout", reason: "deadline" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("reports a returned MCP error without replay or exposing content", async () => {
    const records = capture();
    const value = await session();
    const call = vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ isError: true, content: [{ type: "text", text: "PRIVATE_RESULT_CANARY" }] });
    await expect(value.callTool("PRIVATE_TOOL_CANARY", {})).resolves.toMatchObject({ isError: true, text: ["PRIVATE_RESULT_CANARY"] });
    expect(call).toHaveBeenCalledOnce();
    expect(records()).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "request", outcome: "failed" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("keeps the first observed parent abort when a late SDK timeout follows", async () => {
    const records = capture();
    const value = await session();
    const controller = new AbortController();
    let reject!: (error: unknown) => void;
    vi.spyOn(Client.prototype, "callTool").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored" }, () => value.callTool("tool", {}, { signal: controller.signal, timeoutMs: 20 }))
      .catch((error: unknown) => error);
    runWithContext({ trace_id: "2".repeat(32) }, () => controller.abort(new Error("PRIVATE_STOP_CANARY")));
    reject(new SdkError(SdkErrorCode.RequestTimeout, "PRIVATE_LATE_TIMEOUT_CANARY"));
    expect(await pending).toMatchObject({ code: "mcp_request_cancelled" });
    expect(records().filter((entry) => entry.event === "nested_abort")).toEqual([
      expect.objectContaining({ trace_id: "1".repeat(32), tool_call_id: "stored", abort_source: "parent_signal", deadline_kind: "sdk_request" })
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });
});
