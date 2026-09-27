import { workspaceOperationFailureMessage, type WorkspaceOperationFailureCode } from "@/lib/contracts/workspaceFailure";
import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { plainWorkspaceActivityText } from "./activityText";
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
    const code = "workspace_command_failed";
    const bounded = boundedCommandFailureText({ code, exitCode, maximum,
      stdout: typeof output?.stdout === "string" ? output.stdout : "",
      stderr: typeof output?.stderr === "string" ? output.stderr : "" });
    return { errorCode: code, content: [{ type: "text", text: bounded.text }], exitCode, status: "error",
      originalByteCount, truncated: bounded.truncated };
  }
  if (value.isError !== true) return null;
  return workspaceOperationFailureResult(error?.code === "host_path_denied" ? "workspace_path_access_denied" : "workspace_operation_failed");
}

/** UTF-8 bytes a string adds inside a `JSON.stringify` literal, quotes excluded. */
function serializedCost(value: string, start = 0, end = value.length): number {
  let bytes = 0;
  for (let index = start; index < end; index += 1) bytes += unitCost(value, index);
  return bytes;
}

/** Cost of the character starting at `index`; a valid surrogate pair is charged on its high half. */
function unitCost(value: string, index: number): number {
  const unit = value.charCodeAt(index);
  if (unit === 0x22 || unit === 0x5c) return 2;
  if (unit < 0x20) return unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d ? 2 : 6;
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6;
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    const previous = value.charCodeAt(index - 1);
    return previous >= 0xd800 && previous <= 0xdbff ? 0 : 6;
  }
  return 3;
}

const omissionMarker = (bytes: number) => `\n… [${bytes} bytes omitted] …\n`;

/**
 * Head+tail of `value` whose serialized JSON literal costs at most `budget`
 * bytes, with an explicit omitted-bytes marker. Never splits a character.
 */
function headTailSerialized(value: string, budget: number): Readonly<{ cost: number; text: string; truncated: boolean }> {
  const total = serializedCost(value);
  if (total <= budget) return { cost: total, text: value, truncated: false };
  const totalBytes = Buffer.byteLength(value);
  // Reserve the widest marker this value can need; the real one is never longer.
  const reserved = serializedCost(omissionMarker(totalBytes));
  if (budget < reserved) return { cost: 0, text: "", truncated: true };
  const remaining = budget - reserved;
  const headBudget = Math.floor(remaining / 2);
  let head = 0;
  let headCost = 0;
  while (head < value.length) {
    const width = value.charCodeAt(head) >= 0xd800 && value.charCodeAt(head) <= 0xdbff &&
      value.charCodeAt(head + 1) >= 0xdc00 && value.charCodeAt(head + 1) <= 0xdfff ? 2 : 1;
    const cost = serializedCost(value, head, head + width);
    if (headCost + cost > headBudget) break;
    head += width;
    headCost += cost;
  }
  const tailBudget = remaining - headCost;
  let tail = value.length;
  let tailCost = 0;
  while (tail > head) {
    const width = value.charCodeAt(tail - 1) >= 0xdc00 && value.charCodeAt(tail - 1) <= 0xdfff && tail - 2 >= head &&
      value.charCodeAt(tail - 2) >= 0xd800 && value.charCodeAt(tail - 2) <= 0xdbff ? 2 : 1;
    const cost = serializedCost(value, tail - width, tail);
    if (tailCost + cost > tailBudget) break;
    tail -= width;
    tailCost += cost;
  }
  const [kept, rest] = [value.slice(0, head), value.slice(tail)];
  const marker = omissionMarker(totalBytes - Buffer.byteLength(kept) - Buffer.byteLength(rest));
  return { cost: headCost + serializedCost(marker) + tailCost, text: `${kept}${marker}${rest}`, truncated: true };
}

/**
 * Model-visible failed-command envelope with the same serialized byte budget
 * as a successful result. Stderr keeps priority; the UI preview is separate.
 */
function boundedCommandFailureText(input: Readonly<{
  code: WorkspaceOperationFailureCode;
  exitCode: number;
  maximum: number;
  stderr: string;
  stdout: string;
}>): Readonly<{ text: string; truncated: boolean }> {
  const envelope = (stdout: string, stderr: string, truncated: boolean) => JSON.stringify({ ok: false,
    error: { code: input.code, message: workspaceOperationFailureMessage(input.code) },
    data: { exitCode: input.exitCode, stdout, stderr, truncated } });
  const stdout = plainWorkspaceActivityText(input.stdout);
  const stderr = plainWorkspaceActivityText(input.stderr);
  const complete = envelope(stdout, stderr, false);
  if (Buffer.byteLength(complete) <= input.maximum) return { text: complete, truncated: false };
  const budget = Math.max(0, input.maximum - Buffer.byteLength(envelope("", "", true)));
  const stdoutCost = serializedCost(stdout);
  const stderrCost = serializedCost(stderr);
  const stderrShare = Math.min(stderrCost, Math.max(Math.floor(budget * 0.75), budget - stdoutCost));
  const boundedStderr = headTailSerialized(stderr, stderrShare);
  const boundedStdout = headTailSerialized(stdout, budget - boundedStderr.cost);
  return { text: envelope(boundedStdout.text, boundedStderr.text, true), truncated: true };
}
