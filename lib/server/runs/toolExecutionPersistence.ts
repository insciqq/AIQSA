import { parseWorkspaceImageEvidence } from "../workspace/directImageEvidence";
import { decodeToolObservationDescriptor } from "../toolObservations/contract";
import { decodeTokenUsage } from "../../domain/usage";
import { logEvent, type ToolKind } from "../observability";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import {
  isToolLoopJsonValue,
  snapshotToolLoopJson,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import {
  compactSearchToolExecutionResult,
  rehydratePersistedSearchToolExecutionResult
} from "../search/toolResult";
import {
  compactKnowledgeToolExecutionResult,
  rehydratePersistedKnowledgeToolExecutionResult
} from "../knowledge/toolResult";

const artifactTypes = new Set([
  "workspace_checkpoint",
  "generated_artifact",
  "image",
  "citation",
  "context_truncated",
  "reasoning",
  "search",
  "summary",
  "tool_call",
  "tool_result",
  "workspace_activity"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): ModelRunUsage | null {
  const usage = decodeTokenUsage(value);
  if (!usage || !isRecord(value) || (value.estimatedCostMicros != null &&
    !nonNegativeNumber(value.estimatedCostMicros))) return null;
  return { ...usage, ...(value.estimatedCostMicros !== undefined
    ? { estimatedCostMicros: value.estimatedCostMicros as number | null } : {}) };
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
    case "usage": {
      const usage = parseUsage(data);
      return usage ? { type: "usage", data: usage } : null;
    }
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
      return typeof data.runId === "string" && (data.status === "complete" || data.status === "cancelled")
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
    "observation",
    "rawPreview",
    "status",
    "usage"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  const observation = value.observation === undefined ? undefined : decodeToolObservationDescriptor(value.observation);
  if (value.observation !== undefined && !observation) return null;

  const content: ToolExecutionResult["content"] = [];
  for (const entry of value.content) {
    if (!isRecord(entry)) return null;
    if (entry.type === "text" && typeof entry.text === "string" &&
      Object.keys(entry).every((key) => key === "text" || key === "type")) {
      content.push({ text: entry.text, type: "text" });
      continue;
    }
    if (entry.type === "workspace_image" && Object.keys(entry).every(key => key === "type" || key === "value")) {
      const evidence = parseWorkspaceImageEvidence(entry.value);
      if (!evidence || call.name !== "view_workspace_image" || value.status !== "complete") return null;
      content.push({ type: "workspace_image", value: evidence });
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

  const searchResult = rehydratePersistedSearchToolExecutionResult({
    ...(artifacts ? { artifacts } : {}),
    callId: call.id,
    content,
    name: call.name,
    ...(observation ? { observation } : {}),
    ...(value.rawPreview !== undefined
      ? { rawPreview: value.rawPreview as Record<string, unknown> }
      : {}),
    status: value.status,
    ...(usage ? { usage } : {})
  });
  return searchResult ? rehydratePersistedKnowledgeToolExecutionResult(searchResult) : null;
}

export function snapshotToolExecutionResult(
  result: ToolExecutionResult,
  maxBytes: number
): ToolLoopJsonValue | null {
  const knowledgeResult = compactKnowledgeToolExecutionResult(result);
  const durableResult = knowledgeResult
    ? compactSearchToolExecutionResult(knowledgeResult)
    : null;
  if (!durableResult) return null;
  const snapshot = snapshotToolLoopJson(durableResult, maxBytes);
  return snapshot && parsePersistedToolExecutionResult(
    { id: result.callId, name: result.name },
    snapshot
  ) ? snapshot : null;
}

export type ToolResultPersistenceFailure = Readonly<{
  code: "tool_result_too_large" | "tool_result_unpersistable";
  /** The durable-snapshot step that refused the executed result. */
  stage: "projection" | "serialization" | "size" | "validation";
  observedBytes: number | null;
  limitBytes: number;
}>;

/** Sizes and the refusing step only; the result's content never leaves here. */
function toolResultPersistenceFailure(result: ToolExecutionResult, maxBytes: number): ToolResultPersistenceFailure {
  const refused = (stage: ToolResultPersistenceFailure["stage"], observedBytes: number | null = null) => ({
    code: stage === "size" ? "tool_result_too_large" as const : "tool_result_unpersistable" as const,
    limitBytes: maxBytes,
    observedBytes,
    stage
  });
  let durable: ToolExecutionResult | null;
  try {
    const knowledge = compactKnowledgeToolExecutionResult(result);
    durable = knowledge ? compactSearchToolExecutionResult(knowledge) : null;
  } catch {
    durable = null;
  }
  if (!durable) return refused("projection");
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(durable);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) return refused("serialization");
  const observedBytes = Buffer.byteLength(serialized, "utf8");
  return refused(observedBytes > maxBytes ? "size" : "validation", observedBytes);
}

/** The bounded, content-free outcome of a call whose executed result cannot be
 * kept. It says the call ran, so the model has no reason to replay it. */
export function unpersistableToolExecutionResult(
  result: Pick<ToolExecutionResult, "callId" | "name" | "usage">,
  failure: ToolResultPersistenceFailure
): ToolExecutionResult {
  const message = failure.code === "tool_result_too_large"
    ? `The tool call ran and returned a result of ${failure.observedBytes} bytes, above the ${failure.limitBytes}-byte limit for a kept tool result. The result was not kept and is unavailable; do not repeat the same call to recover it.`
    : "The tool call ran, but its result could not be kept in a durable form. The result is unavailable; do not repeat the same call to recover it.";
  const error = {
    code: failure.code,
    limitBytes: failure.limitBytes,
    observedBytes: failure.observedBytes,
    stage: failure.stage
  };
  return {
    callId: result.callId,
    content: [{ text: JSON.stringify({ ok: false, error: { ...error, message } }), type: "text" }],
    name: result.name,
    rawPreview: { finalProviderResponsePreview: { error } },
    status: "error",
    ...(result.usage ? { usage: result.usage } : {})
  };
}

/**
 * The result a tool call settles with. An executed result without a durable
 * snapshot (oversized, unserializable or failing its codec) settles as a
 * bounded error carrying only its code, refusing step, observed size and
 * limit, so the batch advances and nothing replays the call. Null only when
 * even that bounded outcome cannot be persisted.
 */
export function settleableToolExecutionResult(
  result: ToolExecutionResult,
  maxBytes: number,
  toolKind?: ToolKind
): Readonly<{
  failure: ToolResultPersistenceFailure | null;
  result: ToolExecutionResult;
  snapshot: ToolLoopJsonValue;
}> | null {
  const snapshot = snapshotToolExecutionResult(result, maxBytes);
  if (snapshot) return { failure: null, result, snapshot };
  const failure = toolResultPersistenceFailure(result, maxBytes);
  let refused = unpersistableToolExecutionResult(result, failure);
  let refusedSnapshot = snapshotToolExecutionResult(refused, maxBytes);
  if (!refusedSnapshot && refused.usage) {
    refused = unpersistableToolExecutionResult({ callId: result.callId, name: result.name }, failure);
    refusedSnapshot = snapshotToolExecutionResult(refused, maxBytes);
  }
  if (!refusedSnapshot) return null;
  if (toolKind) {
    logEvent("tool_execution", {
      action: "degrade",
      code: failure.code,
      outcome: "failed",
      reason: failure.code === "tool_result_too_large" ? "safety_limit" : "invalid_response",
      stage: "result",
      tool_kind: toolKind
    });
  }
  return { failure, result: refused, snapshot: refusedSnapshot };
}
