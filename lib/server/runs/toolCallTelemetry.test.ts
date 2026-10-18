import { afterEach, describe, expect, it, vi } from "vitest";
import { recordToolCall } from "./toolCallTelemetry";

describe("tool_call telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records the sizes of a truncated MCP result on its completed call, never its content", () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const value = { callId: "call", name: "PRIVATE_NAME", status: "complete", content: [{ type: "text", text: "PRIVATE_TEXT" }],
      rawPreview: { isError: false, unsupportedContentTypes: [], truncated: true, originalBytes: 9_437_184, deliveredBytes: 8_388_600 } };
    recordToolCall({ durationMs: 5, kind: "mcp", result: { status: "complete", value } });
    // Another kind's own truncation metadata is not an MCP result truncation.
    recordToolCall({ durationMs: 5, kind: "workspace", result: { status: "complete", value } });
    const [mcp, workspace] = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(mcp).toMatchObject({ event: "tool_call", tool_kind: "mcp", outcome: "completed",
      truncated: true, original_bytes: 9_437_184, delivered_bytes: 8_388_600 });
    expect(workspace).not.toHaveProperty("truncated");
    expect(JSON.stringify(writer.mock.calls)).not.toContain("PRIVATE_");
  });

  it("records a call held for write approval as awaiting approval at info, not as a failure", () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const value = { callId: "call", name: "PRIVATE_NAME", status: "error",
      content: [{ type: "json", value: { error: "mcp_approval_required", message: "PRIVATE_MESSAGE" } }] };
    recordToolCall({ durationMs: 1, kind: "mcp", result: { status: "complete", value } });
    recordToolCall({ durationMs: 1, kind: "mcp", result: { status: "complete",
      value: { ...value, content: [{ type: "json", value: { error: "mcp_call_failed" } }] } } });
    const [held, failed] = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(held).toMatchObject({ event: "tool_call", level: "info", outcome: "awaiting_approval", code: "mcp_approval_required" });
    expect(failed).toMatchObject({ event: "tool_call", level: "warn", outcome: "failed", code: "mcp_call_failed" });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("PRIVATE_");
  });
});
