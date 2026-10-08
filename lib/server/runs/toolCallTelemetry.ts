import observedFailureCodes from "../observability/failureCodes.json";
import { logEvent, type EventFields, type ToolCallKind } from "../observability";

const registeredCodes = new Set<string>(observedFailureCodes);
/** A failed call whose result names no registered code. */
export const TOOL_CALL_FAILED_CODE = "tool_failed";
/** An MCP server reported an error; its own content is never read for a code. */
export const MCP_TOOL_REPORTED_ERROR_CODE = "mcp_tool_reported_error";
const MAX_PARSED_TEXT = 4_096;
const MAX_INSPECTED_PARTS = 4;
/** Search reports its refusals as `Search failed: <code>` text. */
const searchFailedText = /^Search failed: ([a-z][a-z0-9_]{0,95})(?![a-z0-9_])/u;

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
  if (text.length > MAX_PARSED_TEXT || !text.startsWith("{")) return undefined;
  try { return namedCode(JSON.parse(text)); } catch { return undefined; }
}

/**
 * The registered failure code a tool's error result names, else `tool_failed`.
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

const outcomeOf = (code: string): Outcome =>
  code === "tool_call_cancelled" ? "cancelled" : code === "tool_call_timeout" ? "timeout" : "failed";

/**
 * The terminal outcome and code of one settled loop result: the loop's own
 * error (timeout, cancellation, a thrown or structured failure) or a tool
 * result whose status is `error`.
 */
export function toolCallOutcome(result: unknown): Readonly<{ outcome: Outcome; code?: string }> {
  if (own(result, "status") === "error") {
    const code = registered(own(own(result, "error"), "code")) ?? TOOL_CALL_FAILED_CODE;
    return { outcome: outcomeOf(code), code };
  }
  const value = own(result, "value");
  if (own(value, "status") !== "error") return { outcome: "completed" };
  const code = toolResultFailureCode(value);
  return { outcome: outcomeOf(code), code };
}

/**
 * One content-free terminal record per settled call. An exception the tool
 * threw (not a structured error result) is unexpected and becomes an incident
 * with its content-free error site. It never throws into the loop.
 */
export function recordToolCall(input: Readonly<{
  durationMs: number;
  kind: ToolCallKind;
  result: unknown;
  thrown?: Readonly<{ error: unknown }>;
}>): void {
  try {
    const { outcome, code } = toolCallOutcome(input.result);
    logEvent("tool_call", {
      tool_kind: input.kind, duration_ms: input.durationMs,
      ...(input.thrown
        ? { outcome: "failed" as const, code: code ?? TOOL_CALL_FAILED_CODE, error_category: "unexpected" as const, error: input.thrown.error }
        : { outcome, ...(code ? { code } : {}) })
    });
  } catch { /* Telemetry never changes a tool call's settlement. */ }
}
