import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import {
  isToolLoopJsonValue,
  snapshotToolLoopJson,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";

const artifactTypes = new Set([
  "citation",
  "context_truncated",
  "reasoning",
  "search",
  "summary",
  "tool_call",
  "tool_result"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): ModelRunUsage | null {
  if (!isRecord(value) ||
    !nonNegativeNumber(value.inputTokens) ||
    !nonNegativeNumber(value.outputTokens) ||
    !nonNegativeNumber(value.reasoningTokens) ||
    (value.cachedInputTokens !== undefined && !nonNegativeNumber(value.cachedInputTokens)) ||
    (value.cacheWriteInputTokens !== undefined && !nonNegativeNumber(value.cacheWriteInputTokens)) ||
    (value.totalTokens !== undefined && !nonNegativeNumber(value.totalTokens)) ||
    (value.estimatedCostMicros !== undefined && value.estimatedCostMicros !== null &&
      !nonNegativeNumber(value.estimatedCostMicros))) {
    return null;
  }
  return {
    ...(value.cachedInputTokens !== undefined ? { cachedInputTokens: value.cachedInputTokens } : {}),
    ...(value.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: value.cacheWriteInputTokens }
      : {}),
    ...(value.estimatedCostMicros !== undefined
      ? { estimatedCostMicros: value.estimatedCostMicros as number | null }
      : {}),
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    reasoningTokens: value.reasoningTokens,
    ...(value.totalTokens !== undefined ? { totalTokens: value.totalTokens } : {})
  };
}

function parseStoredEvent(value: unknown): ModelRunSseEvent | null {
  if (!isRecord(value) || !isRecord(value.data) || !isToolLoopJsonValue(value.data)) return null;
  const data = value.data;
  switch (value.type) {
    case "artifact":
      return typeof data.artifactType === "string" && artifactTypes.has(data.artifactType) &&
        Object.hasOwn(data, "payload")
        ? value as unknown as ModelRunSseEvent
        : null;
    case "token":
      return typeof data.delta === "string" ? value as unknown as ModelRunSseEvent : null;
    case "message_reset":
      return Number.isSafeInteger(data.round) && (data.round as number) >= 0
        ? value as unknown as ModelRunSseEvent
        : null;
    case "usage":
      return parseUsage(data) ? value as unknown as ModelRunSseEvent : null;
    case "run_start":
      return typeof data.modelId === "string" && typeof data.provider === "string" &&
        typeof data.runId === "string" && data.status === "streaming"
        ? value as unknown as ModelRunSseEvent
        : null;
    case "message_start":
      return typeof data.assistantMessageId === "string" &&
        (data.userMessageId === undefined || typeof data.userMessageId === "string")
        ? value as unknown as ModelRunSseEvent
        : null;
    case "done":
      return typeof data.runId === "string" && data.status === "complete"
        ? value as unknown as ModelRunSseEvent
        : null;
    case "error":
      return typeof data.code === "string" && typeof data.message === "string"
        ? value as unknown as ModelRunSseEvent
        : null;
    case "chat_update":
      return isRecord(data.chat) && Array.isArray(data.messages)
        ? value as unknown as ModelRunSseEvent
        : null;
    default:
      return null;
  }
}

export function parsePersistedToolExecutionResult(
  call: Pick<ModelToolCall, "id" | "name">,
  value: ToolLoopJsonValue | null
): ToolExecutionResult | null {
  if (!isRecord(value) || value.callId !== call.id || value.name !== call.name ||
    (value.status !== "complete" && value.status !== "error") || !Array.isArray(value.content)) {
    return null;
  }
  const allowedKeys = new Set([
    "artifacts",
    "callId",
    "content",
    "name",
    "rawPreview",
    "status",
    "usage"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;

  const content: ToolExecutionResult["content"] = [];
  for (const entry of value.content) {
    if (!isRecord(entry)) return null;
    if (entry.type === "text" && typeof entry.text === "string" &&
      Object.keys(entry).every((key) => key === "text" || key === "type")) {
      content.push({ text: entry.text, type: "text" });
      continue;
    }
    if (entry.type === "json" && Object.hasOwn(entry, "value") &&
      isToolLoopJsonValue(entry.value) &&
      Object.keys(entry).every((key) => key === "type" || key === "value")) {
      content.push({ type: "json", value: entry.value });
      continue;
    }
    return null;
  }
  if (content.length === 0) return null;

  let artifacts: ModelRunSseEvent[] | undefined;
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) return null;
    artifacts = [];
    for (const event of value.artifacts) {
      const parsed = parseStoredEvent(event);
      if (!parsed) return null;
      artifacts.push(parsed);
    }
  }
  const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
  if (value.usage !== undefined && !usage) return null;
  if (value.rawPreview !== undefined && !isRecord(value.rawPreview)) return null;

  return {
    ...(artifacts ? { artifacts } : {}),
    callId: call.id,
    content,
    name: call.name,
    ...(value.rawPreview !== undefined
      ? { rawPreview: value.rawPreview as Record<string, unknown> }
      : {}),
    status: value.status,
    ...(usage ? { usage } : {})
  };
}

export function snapshotToolExecutionResult(
  result: ToolExecutionResult,
  maxBytes: number
): ToolLoopJsonValue | null {
  const snapshot = snapshotToolLoopJson(result, maxBytes);
  return snapshot && parsePersistedToolExecutionResult(
    { id: result.callId, name: result.name },
    snapshot
  ) ? snapshot : null;
}
