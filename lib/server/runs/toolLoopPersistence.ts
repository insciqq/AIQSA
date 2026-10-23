import { getMcpRequestMaxBytes } from "../mcp/responseLimits";
import { PROVIDER_RESPONSE_MAX_TOOL_CALLS } from "../tools/types";

/**
 * The persisted form of a run's tool calls (`ModelRunToolCall`): their JSON
 * values, states and bounds, and the result a call keeps when its run ended
 * before it settled.
 */
export type ToolLoopJsonValue =
  | boolean
  | number
  | string
  | null
  | ToolLoopJsonValue[]
  | { [key: string]: ToolLoopJsonValue };

export type PersistedToolLoopCallState = "pending" | "running" | "complete" | "error" | "cancelled";

export type PersistedToolLoopCall = Readonly<{
  arguments: Readonly<Record<string, ToolLoopJsonValue>>;
  completedAt: string | null;
  id: string;
  mcpBinding: Readonly<{
    id: string;
    runtimeGenerationFingerprint: string;
    runtimeGenerationId: string | null;
  }> | null;
  /** Present on repository records; omitted only by historical/in-memory fixtures. */
  workspaceBindingId?: string | null;
  ordinal: number;
  providerCallId: string;
  result: ToolLoopJsonValue | null;
  roundIndex: number;
  startedAt: string | null;
  state: PersistedToolLoopCallState;
  toolName: string;
  /** Present on repository records. Optional only for historical/in-memory
   * fixtures; a missing value is conservatively treated as unaccounted. */
  usageAccountedAt?: string | null;
}>;

export const toolLoopPersistenceLimits = Object.freeze({
  get argumentsBytes() { return getMcpRequestMaxBytes(); },
  /** Exactly the calls one provider response may carry. */
  batchCalls: PROVIDER_RESPONSE_MAX_TOOL_CALLS,
  get checkpointBytes() { return Math.max(4 * 1024 * 1024, 2 * getMcpRequestMaxBytes() + 64 * 1024); },
  providerCallIdLength: 256,
  providerCursorLength: 4_096,
  resultBytes: 256 * 1_024,
  roundIndex: 2_147_483_647,
  toolNameLength: 256
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RUN_ENDED_TOOL_CALL_CODE = "run_ended_before_tool_settled";

/** Content-free result of a call that was still running when its run became
 * final. Its outcome stays unknown (it may have had effects), and only the
 * call's own late settlement may replace it. */
export function runEndedToolCallResult(): { code: string; outcome: "unknown" } {
  return { code: RUN_ENDED_TOOL_CALL_CODE, outcome: "unknown" };
}

export function isRunEndedToolCallResult(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 2 &&
    value.code === RUN_ENDED_TOOL_CALL_CODE && value.outcome === "unknown";
}

/** What history shows for a call: once its run has ended, a call left open or
 * closed only by that ending is a stopped step, never a live one. */
export function displayedToolCallState(
  call: Readonly<{ result?: unknown; state: string }>,
  runStatus: string | undefined
): string {
  const ended = runStatus === "complete" || runStatus === "cancelled" || runStatus === "error";
  if (ended && (call.state === "pending" || call.state === "running")) return "cancelled";
  if (call.state === "error" && isRunEndedToolCallResult(call.result)) return "cancelled";
  return call.state;
}

function jsonSnapshot(value: unknown, maxBytes: number): ToolLoopJsonValue | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) return null;
    const snapshot = JSON.parse(serialized) as unknown;
    return isToolLoopJsonValue(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

export function isToolLoopJsonValue(value: unknown): value is ToolLoopJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isToolLoopJsonValue);
  return isRecord(value) && Object.values(value).every(isToolLoopJsonValue);
}

export function snapshotToolLoopJson(value: unknown, maxBytes: number): ToolLoopJsonValue | null {
  return jsonSnapshot(value, maxBytes);
}
