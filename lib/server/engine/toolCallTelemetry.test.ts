import { describe, expect, it } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { recordToolCall, toolCallOutcome } from "./toolCallTelemetry";

const failed = (value: unknown) => ({ callId: "c", content: [{ type: "json", value }], name: "PRIVATE_NAME", status: "error" });

describe("tool_call telemetry", () => {
  it("maps a result to its outcome and only a registered code", () => {
    expect(toolCallOutcome({ callId: "c", content: [{ text: "ok", type: "text" }], name: "n", status: "complete" }))
      .toEqual({ outcome: "completed" });
    expect(toolCallOutcome(failed({ error: "tool_call_repeat_blocked", repeatOf: [1, 2] })))
      .toEqual({ outcome: "failed", code: "tool_call_repeat_blocked" });
    expect(toolCallOutcome(failed({ error: "tool_call_limit_reached", message: "PRIVATE" })))
      .toEqual({ outcome: "failed", code: "tool_call_limit_reached" });
    expect(toolCallOutcome(failed({ error: "PRIVATE_unregistered_code" }))).toEqual({ outcome: "failed", code: "tool_call_failed" });
    expect(toolCallOutcome(failed({ error: "mcp_approval_required" }))).toEqual({ outcome: "awaiting_approval", code: "mcp_approval_required" });
    expect(toolCallOutcome({ content: [{ text: "Search failed: search_result_too_large", type: "text" }], status: "error" }))
      .toEqual({ outcome: "failed", code: "search_result_too_large" });
    expect(toolCallOutcome({ content: [{ text: "PRIVATE", type: "text" }], rawPreview: { isError: true }, status: "error" }))
      .toEqual({ outcome: "failed", code: "mcp_tool_reported_error" });
  });

  it("counts a command that exited non-zero as a completed call, however long its output", () => {
    const envelope = (stdout: string) => ({ content: [{ type: "text", text: JSON.stringify({ ok: false,
      error: { code: "workspace_command_failed", message: "PRIVATE" }, data: { exitCode: 1, stdout, stderr: "", truncated: false } }) }],
    status: "error" });
    expect(toolCallOutcome(envelope("PRIVATE"))).toEqual({ outcome: "completed", code: "workspace_command_failed" });
    expect(toolCallOutcome(envelope("x".repeat(20_000)))).toEqual({ outcome: "completed", code: "workspace_command_failed" });
    // A long envelope of a real failure still names its own code.
    const busy = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "workspace_busy" },
      data: "x".repeat(20_000) }) }], status: "error" };
    expect(toolCallOutcome(busy)).toEqual({ outcome: "failed", code: "workspace_busy" });
  });

  it("records the sizes of a truncated MCP result on its completed call, never its content", async () => {
    const observation = await captureRunObservation();
    const result = { callId: "call", name: "PRIVATE_NAME", status: "complete", content: [{ type: "text", text: "PRIVATE_TEXT" }],
      rawPreview: { isError: false, unsupportedContentTypes: [], truncated: true, originalBytes: 9_437_184, deliveredBytes: 8_388_600 } };
    recordToolCall({ durationMs: 5.4, kind: "mcp", settled: { kind: "result", result } });
    // Another kind's own truncation metadata is not an MCP result truncation.
    recordToolCall({ durationMs: 5, kind: "workspace", settled: { kind: "result", result } });
    const [mcp, workspace] = observation.records().filter((record) => record.event === "tool_call");
    expect(mcp).toMatchObject({ tool_kind: "mcp", outcome: "completed", duration_ms: 5,
      truncated: true, original_bytes: 9_437_184, delivered_bytes: 8_388_600 });
    expect(workspace).not.toHaveProperty("truncated");
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE_");
  });

  it("records approval waits at info, unknown effects and stopped calls by their own codes", async () => {
    const observation = await captureRunObservation();
    recordToolCall({ kind: "mcp", settled: { kind: "awaiting_approval" } });
    recordToolCall({ durationMs: 1, kind: "mcp", settled: { effectUnknown: true, error: new Error("PRIVATE_ERROR"), kind: "thrown",
      result: failed({ error: "tool_execution_failed" }) } });
    recordToolCall({ durationMs: 1, kind: "search", settled: { effectUnknown: false, error: new Error("PRIVATE_ERROR"), kind: "thrown",
      result: failed({ error: "tool_execution_failed" }) } });
    recordToolCall({ durationMs: 1, kind: "workspace", settled: { kind: "aborted", reason: { code: RUN_TIME_LIMIT_FAILURE.code } } });
    recordToolCall({ durationMs: 1, kind: "workspace", settled: { kind: "aborted", reason: new DOMException("stop", "AbortError") } });
    const records = observation.records().filter((record) => record.event === "tool_call");
    expect(records.map((record) => [record.level, record.outcome, record.code, record.error_category])).toEqual([
      ["info", "awaiting_approval", "mcp_approval_required", undefined],
      ["error", "failed", "tool_call_outcome_unknown", "unexpected"],
      ["error", "failed", "tool_execution_failed", "unexpected"],
      ["warn", "timeout", "tool_call_timeout", undefined],
      ["info", "cancelled", "tool_call_cancelled", undefined]
    ]);
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE_");
  });

  it("records a tool's own time limit as a warned timeout with its code, never an unexpected failure", async () => {
    const observation = await captureRunObservation();
    recordToolCall({ durationMs: 1, kind: "workspace", settled: { code: "workspace_tool_timeout", kind: "timed_out" } });
    recordToolCall({ durationMs: 1, kind: "workspace", settled: { code: "PRIVATE_unregistered", kind: "timed_out" } });
    const records = observation.records().filter((record) => record.event === "tool_call");
    expect(records.map((record) => [record.level, record.outcome, record.code, record.error_category])).toEqual([
      ["warn", "timeout", "workspace_tool_timeout", undefined],
      ["warn", "timeout", "tool_call_timeout", undefined]
    ]);
    expect(records.every((record) => !("error_fingerprint" in record))).toBe(true);
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE_");
  });

  it("never throws into the batch", () => {
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(() => recordToolCall({ kind: "other", settled: { kind: "result", result: hostile } })).not.toThrow();
  });
});
