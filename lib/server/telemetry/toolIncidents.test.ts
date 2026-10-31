import { describe, expect, it } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { logEvent, runWithToolCallObservation } from "../observability";
import { dispatchMcpTool, mcpToolExecutionResult } from "../mcp/toolExecutor";
import type { McpRunToolRoute } from "../mcp/toolExecutor";
import { beginMcpToolStage } from "../mcp/toolObservability";
import { recordToolCall } from "../engine/toolCallTelemetry";
import { workspaceMcpFailure } from "../workspace/operationFailure";
import { observeWorkspaceToolExecution } from "../workspace/toolObservability";
import { createTelemetryAggregator } from "./aggregator";

const route = { serverId: "PRIVATE_SERVER_ID", originalName: "PRIVATE_TOOL", tool: { definitionHash: "a".repeat(64),
  inputSchema: { type: "object" } } } as unknown as McpRunToolRoute;

describe("one MCP incident per failed call", () => {
  it.each([false, true])("counts one failure through request, executor and terminal record (thrown=%s)", async (thrown) => {
    const observation = await captureRunObservation();
    const call = { id: "call", name: "PRIVATE_TOOL", arguments: {} };
    await runWithToolCallObservation(async () => {
      try {
        const result = await dispatchMcpTool({ arguments: {}, assertCurrent: async () => {}, generationId: "generation", route,
          callTool: async (input) => {
            await input.beforeDispatch();
            const finish = beginMcpToolStage("request");
            finish({ outcome: "failed", code: thrown ? "mcp_call_failed" : "mcp_tool_reported_error" });
            if (thrown) throw Object.assign(new Error("PRIVATE_FAILURE"), { code: "mcp_call_failed" });
            return { isError: true, text: ["PRIVATE_RESULT"], unsupportedContentTypes: [] };
          }
        });
        recordToolCall({ kind: "mcp", toolName: call.name, settled: { kind: "result", result: mcpToolExecutionResult(call, result) } });
      } catch (error) {
        recordToolCall({ kind: "mcp", toolName: call.name, settled: { kind: "thrown", error, effectUnknown: true,
          result: { status: "error", content: [] } } });
      }
    });
    const aggregator = createTelemetryAggregator();
    observation.records().forEach(aggregator.observe);
    const batch = aggregator.drain();
    expect(batch.incidents).toHaveLength(1);
    expect(batch.incidents[0]).toMatchObject({ event: "tool_call", code: thrown ? "tool_call_outcome_unknown" : "mcp_tool_reported_error",
      details: { mcp_server: expect.stringMatching(/^[0-9a-f]{32}$/u) } });
    expect(batch.counters.filter((row) => row.level === "error").reduce((sum, row) => sum + row.count, 0)).toBe(1);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_");
  });

  it("keeps retry attempts and concurrent calls out of the terminal failure count", async () => {
    const observation = await captureRunObservation();
    await Promise.all([false, true].map((failed) => runWithToolCallObservation(async () => {
      const server = (failed ? "a" : "b").repeat(32);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        logEvent("tool_execution", { tool_kind: "mcp", stage: "admission", outcome: "started", mcp_server: server });
        await Promise.resolve();
        logEvent("transport_stage", { transport: "mcp", stage: "fetch", outcome: "failed", code: "mcp_http_request_failed" });
        logEvent("tool_execution", { tool_kind: "mcp", stage: "execution", outcome: "failed", code: "mcp_call_failed", mcp_server: server });
      }
      recordToolCall({ kind: "mcp", settled: { kind: "result", result: { status: failed ? "error" : "complete",
        rawPreview: { isError: failed }, content: [] } } });
    })));
    const aggregator = createTelemetryAggregator();
    observation.records().forEach(aggregator.observe);
    expect(aggregator.drain().incidents).toMatchObject([{ event: "tool_call", code: "mcp_tool_reported_error",
      details: { mcp_server: "a".repeat(32), cause: "mcp_call_failed" } }]);
  });

  it("records one Workspace incident with the guest category carried from the executor", async () => {
    const observation = await captureRunObservation();
    await runWithToolCallObservation(async () => {
      const result = await observeWorkspaceToolExecution(async () => workspaceMcpFailure({ isError: true, content: [{ type: "text",
        text: JSON.stringify({ error: { code: "operation_failed", message: "PRIVATE_GUEST_MESSAGE" } }) }] }, 4096, "sandbox_fs_read")!);
      recordToolCall({ kind: "workspace", settled: { kind: "result", result } });
    });
    const aggregator = createTelemetryAggregator();
    observation.records().forEach(aggregator.observe);
    const batch = aggregator.drain();
    expect(batch.incidents).toMatchObject([{ event: "tool_call", code: "workspace_operation_failed",
      details: { reason: "guest_filesystem_failed" } }]);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_");
  });

});
