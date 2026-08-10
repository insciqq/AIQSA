import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { projectThreadToolActivity, type ThreadToolActivity } from "../../domain/toolActivity";
import { resolveMcpRunTool } from "../mcp/toolExecutor";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { threadSearchExecutionsFromToolPreview } from "../search/providerOperations";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { parsePersistedToolExecutionResult } from "./toolExecutionPersistence";
import { isToolLoopJsonValue } from "./toolLoopPersistence";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";
import { KNOWLEDGE_TOOL_NAME } from "../knowledge/retrievalTypes";
import { isMemoryActionToolName } from "../memory/actions/tools";

const sensitiveKey = /(?:api.?key|(?:access|private|ssh|signing|encryption).?key|(?:^|[_.-])key(?:$|[_.-]|id$)|token|auth(?:orization)?|bearer|client.?secret|cookie|credential|passphrase|password|secret|verifier)/iu;
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const knownTokenValue = /\b(?:sk|m0|ntn|gh[opusr]|xox[abprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const jwtValue = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRedactedText(value: string, maxLength = 160): string {
  const redacted = value
    .replace(bearerValue, "Bearer [redacted]")
    .replace(knownTokenValue, "[redacted]")
    .replace(jwtValue, "[redacted]");
  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 1))}…`
    : redacted;
}

function previewValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return compactRedactedText(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= 3) return "[nested value]";
  seen.add(value);
  if (Array.isArray(value)) {
    const preview = value.slice(0, 5).map((entry) => previewValue(entry, depth + 1, seen));
    if (value.length > 5) preview.push(`[+${value.length - 5} items]`);
    return preview;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const preview: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, 8)) {
    preview[key] = sensitiveKey.test(key)
      ? "[redacted]"
      : previewValue(entry, depth + 1, seen);
  }
  if (entries.length > 8) preview._truncated = `${entries.length - 8} more fields`;
  return preview;
}

export function boundedRedactedToolPreview(value: unknown): unknown {
  const preview = previewValue(value, 0, new WeakSet());
  try {
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") <= 2_048) return preview;
  } catch {
    return "[preview unavailable]";
  }
  return {
    preview: "[preview exceeded 2048 bytes]",
    ...(value && typeof value === "object" && !Array.isArray(value)
      ? { keys: Object.keys(value as Record<string, unknown>).slice(0, 8) }
      : {})
  };
}

function toolSnapshot(mcp: McpRunPlanSnapshot | undefined, name: string) {
  const route = resolveMcpRunTool(mcp, name);
  if (!route) {
    return {
      capability: name === KNOWLEDGE_TOOL_NAME
        ? "knowledge"
        : isMemoryActionToolName(name) ? "memory" : "web_search",
      toolName: name
    };
  }
  const server = mcp?.servers.find((candidate) => candidate.serverId === route.serverId);
  return {
    capability: "mcp",
    credentialSources: server?.credentialSources ?? [],
    definitionHash: route.tool.definitionHash,
    externalAccountLabel: server?.externalAccountLabel ?? null,
    runtimeGenerationFingerprint: route.fingerprint,
    serverName: route.tool.serverName,
    toolName: route.originalName
  };
}

function resultPreview(result: ToolExecutionResult): Record<string, unknown> {
  return {
    content: boundedRedactedToolPreview(result.content),
    ...(Array.isArray(result.rawPreview?.unsupportedContentTypes)
      ? {
          unsupportedContentTypes: result.rawPreview.unsupportedContentTypes
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, 8)
        }
      : {})
  };
}

type PersistedToolActivityRecord = Readonly<{
  arguments: unknown;
  completedAt: Date | string | null;
  mcpRunBindingId?: string | null;
  ordinal: number;
  providerCallId: string;
  result: unknown;
  roundIndex: number;
  startedAt: Date | string | null;
  state: string;
  toolName: string;
}>;

function inspectionMcpSnapshot(value: unknown): McpRunPlanSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.mcp) || value.mcp.version !== 1 ||
    !Array.isArray(value.mcp.servers) || !Array.isArray(value.mcp.tools) ||
    !value.mcp.servers.every(isRecord) || !value.mcp.tools.every(isRecord)) {
    return undefined;
  }
  return value.mcp as unknown as McpRunPlanSnapshot;
}

function iso(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

/**
 * Projects durable rows through the same bounded/redacted artifacts used by
 * the live stream. This also covers a crash after row persistence but before
 * the corresponding artifact event was appended.
 */
export function persistedToolCallActivity(input: Readonly<{
  call: PersistedToolActivityRecord;
  normalizedRequest: unknown;
  runStatus: string;
}>): ThreadToolActivity | null {
  if (!isRecord(input.call.arguments) || !isToolLoopJsonValue(input.call.arguments)) {
    return null;
  }
  const call: ModelToolCall = {
    arguments: input.call.arguments,
    id: input.call.providerCallId,
    name: input.call.toolName
  };
  const mcp = inspectionMcpSnapshot(input.normalizedRequest);
  if (input.call.mcpRunBindingId && !resolveMcpRunTool(mcp, call.name)) {
    return null;
  }

  const events: unknown[] = [
    toolCallInspectionArtifact({
      call,
      mcp,
      ordinal: input.call.ordinal,
      round: input.call.roundIndex
    }).data
  ];
  const resultValue = input.call.result !== null && isToolLoopJsonValue(input.call.result)
    ? input.call.result
    : null;
  const storedResult = resultValue === null
    ? null
    : parsePersistedToolExecutionResult(call, resultValue);
  if (storedResult) {
    const persistedCall: PersistedToolLoopCall = {
      arguments: input.call.arguments as PersistedToolLoopCall["arguments"],
      completedAt: iso(input.call.completedAt),
      id: input.call.providerCallId,
      mcpBinding: null,
      ordinal: input.call.ordinal,
      providerCallId: input.call.providerCallId,
      result: resultValue,
      roundIndex: input.call.roundIndex,
      startedAt: iso(input.call.startedAt),
      state: input.call.state === "pending" || input.call.state === "running" ||
        input.call.state === "complete" || input.call.state === "error" ||
        input.call.state === "cancelled"
        ? input.call.state
        : "error",
      toolName: input.call.toolName
    };
    events.push(toolResultInspectionArtifact({
      call,
      durationMs: persistedToolDurationMs(persistedCall),
      mcp,
      ordinal: input.call.ordinal,
      result: storedResult,
      round: input.call.roundIndex
    }).data);
  }

  const fallbackStatus = input.call.state === "cancelled"
    ? "cancelled"
    : input.call.state === "error"
      ? "error"
      : input.runStatus;
  const activity = projectThreadToolActivity(events, fallbackStatus)[0] ?? null;
  if (!activity) return null;
  if (input.call.state === "cancelled" || input.call.state === "error") {
    return { ...activity, status: input.call.state };
  }
  return activity;
}

export function toolCallInspectionArtifact(input: Readonly<{
  call: ModelToolCall;
  mcp?: McpRunPlanSnapshot;
  ordinal: number;
  round: number;
}>): ModelRunSseEvent {
  return {
    data: {
      artifactType: "tool_call",
      payload: {
        argumentsPreview: boundedRedactedToolPreview(input.call.arguments),
        callId: input.call.id,
        name: input.call.name,
        ordinal: input.ordinal,
        round: input.round,
        snapshot: toolSnapshot(input.mcp, input.call.name),
        status: "requested"
      }
    },
    type: "artifact"
  };
}

export function toolResultInspectionArtifact(input: Readonly<{
  call: ModelToolCall;
  durationMs?: number;
  mcp?: McpRunPlanSnapshot;
  ordinal: number;
  result: ToolExecutionResult;
  round: number;
}>): ModelRunSseEvent {
  const searchExecutions = threadSearchExecutionsFromToolPreview(input.result.rawPreview);
  const rawError = input.result.status === "error" &&
    typeof input.result.rawPreview?.finalProviderResponsePreview === "object" &&
    input.result.rawPreview.finalProviderResponsePreview !== null &&
    typeof (input.result.rawPreview.finalProviderResponsePreview as Record<string, unknown>).error === "string"
    ? (input.result.rawPreview.finalProviderResponsePreview as Record<string, string>).error
    : null;
  return {
    data: {
      artifactType: "tool_result",
      payload: {
        callId: input.call.id,
        ...(input.durationMs !== undefined
          ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
          : {}),
        ...(rawError ? { message: compactRedactedText(rawError, 512) } : {}),
        name: input.call.name,
        ordinal: input.ordinal,
        resultPreview: resultPreview(input.result),
        round: input.round,
        ...(searchExecutions !== null ? { searchExecutions } : {}),
        snapshot: toolSnapshot(input.mcp, input.call.name),
        status: input.result.status
      }
    },
    type: "artifact"
  };
}

export function persistedToolDurationMs(call: PersistedToolLoopCall | undefined): number | undefined {
  if (!call?.startedAt || !call.completedAt) return undefined;
  const startedAt = Date.parse(call.startedAt);
  const completedAt = Date.parse(call.completedAt);
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt
    : undefined;
}

export function toolLoopPhaseArtifact(input: Readonly<{
  count?: number;
  phase: "model" | "tools";
  round: number;
}>): ModelRunSseEvent {
  const count = Math.max(0, Math.floor(input.count ?? 0));
  return {
    data: {
      artifactType: "summary",
      payload: input.phase === "model"
        ? { message: "Waiting for model", round: input.round, stage: "model", status: "waiting" }
        : {
            count,
            message: `Running ${count} tool${count === 1 ? "" : "s"}`,
            round: input.round,
            stage: "tools",
            status: "running"
          }
    },
    type: "artifact"
  };
}
