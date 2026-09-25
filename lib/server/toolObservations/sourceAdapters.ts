import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import { mcpToolExecutionResult } from "../mcp/toolExecutor";
import { getMcpResponseWireLimits } from "../mcp/responseLimits";
import type { ObservationProducer } from "./repository";
import { TOOL_OBSERVATION_LIMITS, type ToolObservationSourceBinding } from "./contract";
import type { createToolObservationService, ToolObservationProjection } from "./service";
import { boundedSearchToolResultText, compactSearchToolExecutionResult, searchExecutionsFromToolResult } from "../search/toolResult";
import { SearchToolCancelledError } from "../search/toolExecutor";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { SEARCH_OBSERVATION_MAX_BYTES } from "./searchAccounting";
import { ObservationStoreError } from "./contract";

export type ToolObservationService = ReturnType<typeof createToolObservationService>;
type CaptureContext = Readonly<{ service: ToolObservationService; producer: ObservationProducer; signal?: AbortSignal }>;

export function observationResult(call: Pick<ModelToolCall, "id" | "name">, status: ToolExecutionResult["status"],
  projection: ToolObservationProjection): ToolExecutionResult {
  return { callId: call.id, name: call.name, status, observation: projection.observation,
    content: [{ type: "json", value: projection }] };
}

export { projectObservationForProvider } from "./projection";

export async function captureMcpObservation(context: CaptureContext,
  call: ModelToolCall, sourceBinding: Extract<ToolObservationSourceBinding, { source: "mcp" }>,
  execute: () => Promise<AiqsaMcpToolCallResult>): Promise<ToolExecutionResult> {
  return context.service.withReservation({ ...context, source: "mcp", sourceBinding,
    // The validated semantic result fits the wire cap plus its small envelope.
    maximumBytes: getMcpResponseWireLimits().callToolResponseMaxBytes + 64 * 1024 }, async receipt => {
    const original = await execute();
    const projection = await receipt.store({ original, outcome: original.isError ? "error" : "complete",
      sourceTruncated: false, maskable: original.unsupportedContentTypes.length === 0 });
    // Normalize only after the exact accepted original is durable.
    return projection.observation.byteSize <= TOOL_OBSERVATION_LIMITS.inlineBytes
      ? { ...mcpToolExecutionResult(call, original), observation: projection.observation }
      : observationResult(call, original.isError ? "error" : "complete", projection);
  });
}

export async function captureWorkspaceObservation(context: CaptureContext, call: ModelToolCall,
  execute: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  return context.service.withReservation({ ...context, source: "workspace",
    // Workspace's runtime cap is at most 1 MiB. JSON escaping can use six
    // bytes per accepted byte; this ceiling is independent of the MCP cap.
    maximumBytes: 6 * 1024 * 1024 + 64 * 1024 }, async receipt => {
    const result = await execute();
    const original = { status: result.status, content: result.content, ...(result.rawPreview ? { rawPreview: result.rawPreview } : {}) };
    const projection = await receipt.store({ original, outcome: result.status,
      sourceTruncated: result.rawPreview?.truncated === true, maskable: true });
    return projection.observation.byteSize <= TOOL_OBSERVATION_LIMITS.inlineBytes
      ? { ...result, observation: projection.observation }
      : { ...observationResult(call, result.status, projection), ...(result.artifacts ? { artifacts: result.artifacts } : {}) };
  });
}

export async function captureSearchObservation(context: CaptureContext, call: ModelToolCall,
  sources: Extract<ToolObservationSourceBinding, { source: "search" }>["sources"],
  execute: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  return context.service.withReservation({ ...context, source: "search", maximumBytes: SEARCH_OBSERVATION_MAX_BYTES,
    sourceBinding: { version: 1, source: "search", sources } }, async receipt => {
    let result: ToolExecutionResult;
    try { result = await execute(); }
    catch (error) {
      if (error instanceof SearchToolCancelledError) await receipt.recordSearch(error.result);
      throw error;
    }
    const noProviderCall = result.rawPreview?.providerCall === false;
    if (!noProviderCall) await receipt.recordSearch(result);
    const original = compactSearchToolExecutionResult(result);
    if (!original) throw new ObservationStoreError("tool_observation_unavailable");
    const projection = await receipt.store({ original, outcome: result.status, sourceTruncated: false, maskable: true });
    return searchObservationProjection(call, result, projection);
  });
}

/** Findings budget for a Search result that Off could not deliver whole. */
export const SEARCH_PROJECTION_FINDINGS_BYTES = 64 * 1024;

/** The model receives the Search owner's canonical text, never the retained
 * compact original with its invocation, revision, usage or cost fields. When
 * Off would deliver the canonical result unchanged, the text is identical.
 * Otherwise the same text is bounded and the descriptor names the reader. */
function searchObservationProjection(call: Pick<ModelToolCall, "id" | "name">, result: ToolExecutionResult,
  projection: ToolObservationProjection): ToolExecutionResult {
  const envelope = { callId: call.id, name: call.name, status: result.status, observation: projection.observation,
    ...(result.rawPreview?.providerCall === false ? { rawPreview: { providerCall: false } } : {}) };
  const executions = searchExecutionsFromToolResult(result);
  // A non-canonical Search result, such as an exhausted invocation budget, is
  // already its own bounded model text and carries no engine evidence.
  if (!executions.length || snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes)) {
    return { ...envelope, content: result.content };
  }
  for (let budget = SEARCH_PROJECTION_FINDINGS_BYTES; budget >= 1024; budget = Math.floor(budget / 2)) {
    const bounded: ToolExecutionResult = { ...envelope,
      content: [{ type: "text", text: boundedSearchToolResultText(executions, budget) }] };
    if (snapshotToolExecutionResult(bounded, toolLoopPersistenceLimits.resultBytes)) return bounded;
  }
  throw new ObservationStoreError("tool_observation_unavailable");
}

/** Skills settle their existing admitted result before this callback returns;
 * Knowledge already owns its immutable retrieval receipt. Neither copies its
 * bundle/corpus into generic object storage. */
export async function captureOwnedObservation(context: CaptureContext, source: "skill" | "knowledge",
  sourceBinding: Extract<ToolObservationSourceBinding, { source: "skill" }> | undefined,
  executeAndRetain: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  return context.service.withReservation({ ...context, source, sourceBinding,
    maximumBytes: 256 * 1024, sourceOwned: true }, async receipt => {
    const retained = await executeAndRetain();
    // The owner already holds (a Skill has even settled) the admitted result.
    // Its descriptor is optional recall metadata: an unpublishable receipt,
    // such as a Knowledge error without a retrieval run, keeps that result.
    const projection = await receipt.storeSource({ outcome: retained.status, sourceTruncated: false, maskable: source !== "skill" });
    return projection ? { ...retained, observation: projection.observation } : retained;
  });
}

export async function restoreObservedResult(context: CaptureContext, call: Pick<ModelToolCall, "id" | "name">) {
  const restored = await context.service.restore(context.producer, context.signal);
  return restored.search ? searchObservationProjection(call, restored.search, restored.projection)
    : observationResult(call, restored.status, restored.projection);
}
