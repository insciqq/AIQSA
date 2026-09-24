import { workspaceOperationFailureMessage, type WorkspaceOperationFailureCode } from "@/lib/contracts/workspaceFailure";
import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { boundedOutputPreview } from "./activityProjection";
import type { WorkspaceToolResult } from "./runtime";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function workspaceOperationFailureResult(code: WorkspaceOperationFailureCode): WorkspaceToolResult {
  return { errorCode: code, content: [{ type: "text", text: JSON.stringify({ ok: false,
    error: { code, message: workspaceOperationFailureMessage(code) } }) }], status: "error" };
}

/** The pinned microsandbox-mcp contract: fail(code, message, {details}).
 * Most filesystem failures are only operation_failed; their raw message does
 * not prove errno or missing/denied paths. No keywords or retry probes here.
 */
export function workspaceMcpFailure(value: unknown, maximum: number, tool: WorkspaceMcpToolName): WorkspaceToolResult | null {
  if (!record(value)) return null;
  let envelope: Record<string, unknown> | null = null;
  let originalByteCount = 0;
  if (Array.isArray(value.content) && value.content.length === 1) {
    const block = value.content[0];
    // The upstream applies maxBytes separately to stdout/stderr and JSON may
    // escape them. Never parse an unbounded error or copy its raw message.
    if (record(block) && block.type === "text" && typeof block.text === "string" &&
      Buffer.byteLength(block.text) <= Math.min(8 * 1024 * 1024, maximum * 12 + 8192)) {
      try { const parsed: unknown = JSON.parse(block.text); if (record(parsed)) { envelope = parsed; originalByteCount = Buffer.byteLength(block.text); } } catch { /* Opaque. */ }
    }
  }
  const error = envelope && record(envelope.error) ? envelope.error : null;
  const isCommand = tool === "sandbox_exec" || tool === "sandbox_shell";
  const data = envelope && record(envelope.data) ? envelope.data : null;
  const details = error?.code === "exec_failed" && record(error.details) ? error.details : null;
  const output = value.isError === true ? details : data;
  const exit = output?.exitCode;
  // Negative sentinel exits and missing exits never become observed failure.
  const exitCode = isCommand && Number.isSafeInteger(exit) && Number(exit) >= 0 && Number(exit) <= 255 ? Number(exit) : undefined;
  if (exitCode !== undefined && exitCode !== 0) {
    const bounded = boundedOutputPreview({ failed: true,
      stdout: typeof output?.stdout === "string" ? output.stdout : "",
      stderr: typeof output?.stderr === "string" ? output.stderr : "" }, Math.floor(Math.max(0, maximum - 512) / 6));
    const code = "workspace_command_failed";
    const text = JSON.stringify({ ok: false, error: { code, message: workspaceOperationFailureMessage(code) },
      data: { exitCode, stdout: bounded.stdoutPreview, stderr: bounded.stderrPreview } });
    return { errorCode: code, content: [{ type: "text", text }], exitCode, status: "error",
      originalByteCount, truncated: bounded.truncated };
  }
  if (value.isError !== true) return null;
  return workspaceOperationFailureResult(error?.code === "host_path_denied" ? "workspace_path_access_denied" : "workspace_operation_failed");
}
