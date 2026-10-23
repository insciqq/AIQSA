import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import observedFailureCodes from "../observability/failureCodes.json";
import { logEvent, type EventFields, type ToolCallKind } from "../observability";
import { MCP_APPROVAL_REQUIRED } from "../mcp/writeApproval";

const registeredCodes = new Set<string>(observedFailureCodes);
/** A failed call whose result names no registered code. */
export const TOOL_CALL_FAILED_CODE = "tool_call_failed";
/** An MCP server reported an error; its own content is never read for a code. */
export const MCP_TOOL_REPORTED_ERROR_CODE = "mcp_tool_reported_error";
/** An external call that threw after it may have been sent: its effect is unknown. */
export const TOOL_CALL_OUTCOME_UNKNOWN_CODE = "tool_call_outcome_unknown";
export const TOOL_CALL_CANCELLED_CODE = "tool_call_cancelled";
export const TOOL_CALL_TIMEOUT_CODE = "tool_call_timeout";
const MAX_PARSED_TEXT = 4_096;
const MAX_INSPECTED_PARTS = 4;
/** Search reports its refusals as `Search failed: <code>` text. */
const searchFailedText = /^Search failed: ([a-z][a-z0-9_]{0,95})(?![a-z0-9_])/u;
/** A failure envelope's code leads it, so a long one (a command's output) still names its code. */
const failureEnvelopeText = /^\{"ok":false,"error":\{"code":"([a-z][a-z0-9_]{0,95})"/u;
/** A command that ran and exited non-zero: the tool worked and the model reads the exit status. */
const WORKSPACE_COMMAND_FAILED_CODE = "workspace_command_failed";

type Outcome = EventFields["tool_call"]["outcome"];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Own data properties only: no getter, proxy trap or `toJSON` of a result runs. */
const own = (value: unknown, key: string): unknown =>
  record(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

const registered = (value: unknown): string | undefined =>
  typeof value === "string" && registeredCodes.has(value) ? value : undefined;

/** A code an error object names: `{ error: code }`, `{ error: { code } }` or `{ code }`. */
function namedCode(value: unknown): string | undefined {
  const error = own(value, "error");
  return registered(error) ?? registered(own(error, "code")) ?? registered(own(value, "code"));
}

function partCode(part: unknown): string | undefined {
  const type = own(part, "type");
  if (type === "json") return namedCode(own(part, "value"));
  const text = own(part, "text");
  if (type !== "text" || typeof text !== "string") return undefined;
  const searchCode = searchFailedText.exec(text)?.[1];
  if (searchCode) return registered(searchCode);
  const envelopeCode = failureEnvelopeText.exec(text)?.[1];
  if (envelopeCode) return registered(envelopeCode);
  if (text.length > MAX_PARSED_TEXT || !text.startsWith("{")) return undefined;
  try { return namedCode(JSON.parse(text)); } catch { return undefined; }
}

/**
 * The registered failure code a tool's error result names, else `tool_call_failed`.
 * Only codes of the failure registry ever leave: never text, names, arguments
 * or any other value of the result.
 */
export function toolResultFailureCode(result: unknown): string {
  const preview = own(result, "rawPreview");
  if (own(preview, "isError") === true) return MCP_TOOL_REPORTED_ERROR_CODE;
  if (record(preview)) {
    for (const key of Object.keys(preview).slice(0, MAX_INSPECTED_PARTS)) {
      const code = registered(own(own(preview, key), "code"));
      if (code) return code;
    }
  }
  const content = own(result, "content");
  if (Array.isArray(content)) {
    for (const part of content.slice(0, MAX_INSPECTED_PARTS)) {
      const code = partCode(part);
      if (code) return code;
    }
  }
  return TOOL_CALL_FAILED_CODE;
}

// A call the write-approval gate held is paused for its initiator, not failed.
const outcomeOf = (code: string): Outcome =>
  code === TOOL_CALL_CANCELLED_CODE ? "cancelled" : code === TOOL_CALL_TIMEOUT_CODE ? "timeout"
    : code === MCP_APPROVAL_REQUIRED ? "awaiting_approval" : "failed";

/** The terminal outcome and code of one settled result (a tool result or a refusal's recorded result). */
export function toolCallOutcome(result: unknown): Readonly<{ outcome: Outcome; code?: string }> {
  if (own(result, "status") !== "error") return { outcome: "completed" };
  const code = toolResultFailureCode(result);
  // Like `tool_execution`, a non-zero exit is not a failure of the tool, so Admin Health does not count it as one.
  if (code === WORKSPACE_COMMAND_FAILED_CODE) return { outcome: "completed", code };
  return { outcome: outcomeOf(code), code };
}

const byteCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The sizes of an MCP result the client cut to its byte limit, from its rawPreview. */
function truncationFields(result: unknown) {
  const preview = own(result, "rawPreview");
  const originalBytes = own(preview, "originalBytes"), deliveredBytes = own(preview, "deliveredBytes");
  return own(preview, "truncated") === true && byteCount(originalBytes) && byteCount(deliveredBytes)
    ? { truncated: true, original_bytes: originalBytes, delivered_bytes: deliveredBytes } : {};
}

/** How one model tool call settled in its batch. */
export type SettledToolCall =
  /** It ran, or was refused before running, and this is its result. */
  | Readonly<{ kind: "result"; result: unknown }>
  /** It waits for its initiator's approval and was not sent. */
  | Readonly<{ kind: "awaiting_approval" }>
  /** The tool threw after its retries, settled as `result`; an external one may have taken effect. */
  | Readonly<{ kind: "thrown"; error: unknown; effectUnknown: boolean; result: unknown }>
  /** The run stopped (Stop or its deadline, by the run signal's reason) while it ran. */
  | Readonly<{ kind: "aborted"; reason: unknown }>;

function fieldsOf(settled: SettledToolCall, kind: ToolCallKind) {
  switch (settled.kind) {
    case "result": {
      const { outcome, code } = toolCallOutcome(settled.result);
      return { outcome, ...(code ? { code } : {}), ...(kind === "mcp" ? truncationFields(settled.result) : {}) };
    }
    case "awaiting_approval":
      return { outcome: "awaiting_approval" as const, code: MCP_APPROVAL_REQUIRED };
    case "thrown":
      return { outcome: "failed" as const, error_category: "unexpected" as const, error: settled.error,
        code: settled.effectUnknown ? TOOL_CALL_OUTCOME_UNKNOWN_CODE : toolResultFailureCode(settled.result) };
    case "aborted":
      return own(settled.reason, "code") === RUN_TIME_LIMIT_FAILURE.code
        ? { outcome: "timeout" as const, code: TOOL_CALL_TIMEOUT_CODE }
        : { outcome: "cancelled" as const, code: TOOL_CALL_CANCELLED_CODE };
  }
}

/**
 * One content-free terminal record per settled model tool call: its family,
 * outcome, a registered failure code and, for MCP, the sizes of a truncated
 * result. An exception the tool threw (not a structured error result) is
 * unexpected and carries its content-free error site. It never throws into
 * the batch, so telemetry never changes a call's settlement.
 */
export function recordToolCall(input: Readonly<{ durationMs?: number; kind: ToolCallKind; settled: SettledToolCall }>): void {
  try {
    logEvent("tool_call", {
      tool_kind: input.kind,
      ...(input.durationMs === undefined ? {} : { duration_ms: Math.max(0, Math.round(input.durationMs)) }),
      ...fieldsOf(input.settled, input.kind)
    });
  } catch { /* Telemetry never changes a tool call's settlement. */ }
}
