import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import { mcpToolExecutionResult } from "../mcp/toolExecutor";
import type { ObservationProducer } from "./repository";
import { mcpObservationMaximumBytes, TOOL_OBSERVATION_LIMITS, type ToolObservationSourceBinding } from "./contract";
import type { createToolObservationService, ToolObservationProjection } from "./service";
import { boundedRenderedSearchToolResultText, boundedSearchToolResultText, searchExecutionsFromToolResult,
  shortenedSearchToolResultText, type SearchExecutionEvidence } from "../search/toolResult";
import { SearchToolCancelledError } from "../search/toolExecutor";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { SEARCH_OBSERVATION_MAX_BYTES, searchObservationOriginal, type SearchObservationOriginal } from "./searchOriginal";
import { ObservationStoreError } from "./contract";
import { projectObservationForProvider } from "./projection";
import { estimateApproxTokens } from "../../domain/contextBudget";

export type ToolObservationService = ReturnType<typeof createToolObservationService>;
type CaptureContext = Readonly<{
  service: ToolObservationService;
  producer: ObservationProducer;
  signal?: AbortSignal;
  /** Estimated tokens of the admitted input budget one MCP/Workspace result
   * may occupy whole (Infinity for an unknown window). Absent, results above
   * the inline bound keep the bounded preview (the Agent gateway). */
  wholeResultTokens?: number;
}>;

/** A larger original is never delivered whole, so a restore reads at most
 * this much to repeat the live decision. Normalization removes only proven
 * duplicate representations; in practice the persisted result bound decides. */
const OBSERVATION_WHOLE_ORIGINAL_BYTES = 4 * toolLoopPersistenceLimits.resultBytes;

export function observationResult(call: Pick<ModelToolCall, "id" | "name">, status: ToolExecutionResult["status"],
  projection: ToolObservationProjection): ToolExecutionResult {
  return { callId: call.id, name: call.name, status, observation: projection.observation,
    content: [{ type: "json", value: projection }] };
}

export { projectObservationForProvider };

const wholeOriginalBytes = (context: CaptureContext) => context.wholeResultTokens === undefined
  ? TOOL_OBSERVATION_LIMITS.inlineBytes : OBSERVATION_WHOLE_ORIGINAL_BYTES;

/** Off parity: the model receives the normalized result whole when its
 * original is inline-sized, or when Off could settle it whole and it takes at
 * most the caller's share of the admitted budget. It keeps its descriptor, so
 * the planner can mask it later and the reader recalls it; otherwise the
 * bounded preview names the reader. */
function deliveredWhole(context: CaptureContext, byteSize: number, whole: () => ToolExecutionResult): ToolExecutionResult | null {
  if (byteSize <= TOOL_OBSERVATION_LIMITS.inlineBytes) return whole();
  if (context.wholeResultTokens === undefined || byteSize > OBSERVATION_WHOLE_ORIGINAL_BYTES) return null;
  const result = whole();
  return snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes) &&
    estimateApproxTokens(projectObservationForProvider(result).content) <= context.wholeResultTokens ? result : null;
}

export async function captureMcpObservation(context: CaptureContext,
  call: ModelToolCall, sourceBinding: Extract<ToolObservationSourceBinding, { source: "mcp" }>,
  execute: () => Promise<AiqsaMcpToolCallResult>): Promise<ToolExecutionResult> {
  return context.service.withReservation({ ...context, source: "mcp", sourceBinding,
    // The validated semantic result fits the wire cap plus its small envelope.
    maximumBytes: mcpObservationMaximumBytes() }, async receipt => {
    const original = await execute();
    const projection = await receipt.store({ original, outcome: original.isError ? "error" : "complete",
      sourceTruncated: false, maskable: original.unsupportedContentTypes.length === 0 });
    // Normalize only after the exact accepted original is durable.
    return mcpObservationProjection(context, call, original, projection);
  });
}

function mcpObservationProjection(context: CaptureContext, call: Pick<ModelToolCall, "id" | "name">,
  original: AiqsaMcpToolCallResult, projection: ToolObservationProjection): ToolExecutionResult {
  return deliveredWhole(context, projection.observation.byteSize, () =>
    ({ ...mcpToolExecutionResult({ ...call, arguments: {} }, original), observation: projection.observation })) ??
    observationResult(call, original.isError ? "error" : "complete", projection);
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
    return workspaceObservationProjection(context, call, result, projection);
  });
}

/** Artifacts and the runtime's exit/truncation metadata survive either way. */
function workspaceObservationProjection(context: CaptureContext, call: Pick<ModelToolCall, "id" | "name">,
  result: Omit<ToolExecutionResult, "callId" | "name">, projection: ToolObservationProjection): ToolExecutionResult {
  return deliveredWhole(context, projection.observation.byteSize, () =>
    ({ ...result, callId: call.id, name: call.name, observation: projection.observation })) ??
    { ...observationResult(call, result.status, projection), ...(result.rawPreview ? { rawPreview: result.rawPreview } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}) };
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
    // The receipt owns usage and thread sources; the original is model-facing.
    if (!noProviderCall) await receipt.recordSearch(result);
    const original = searchObservationOriginal(result);
    if (!original) throw new ObservationStoreError("tool_observation_unavailable");
    const projection = await receipt.store({ original, outcome: result.status, sourceTruncated: false, maskable: true });
    return searchObservationProjection(call, { original, providerCall: !noProviderCall,
      executions: searchExecutionsFromToolResult(result) }, projection);
  });
}

/** Findings budget for a Search result too large to deliver whole. */
export const SEARCH_PROJECTION_FINDINGS_BYTES = 64 * 1024;

/** The model receives the retained canonical Search text: whole whenever it
 * fits an ordinary tool result (always when Off would deliver it), otherwise
 * bounded with the descriptor naming the reader. Engine evidence, available
 * at capture, keeps every numbered source; a restore bounds the retained text
 * and keeps the numbered sources its receipt names. */
function searchObservationProjection(call: Pick<ModelToolCall, "id" | "name">, value: Readonly<{
  original: SearchObservationOriginal; providerCall: boolean; executions?: readonly SearchExecutionEvidence[];
  /** A restore's receipt: thread sources without findings. */
  receipt?: readonly SearchExecutionEvidence[];
}>, projection: ToolObservationProjection): ToolExecutionResult {
  const envelope = { callId: call.id, name: call.name, status: value.original.status, observation: projection.observation,
    ...(!value.providerCall ? { rawPreview: { providerCall: false } } : {}) };
  const whole: ToolExecutionResult = { ...envelope, content: [...value.original.content] };
  if (snapshotToolExecutionResult(whole, toolLoopPersistenceLimits.resultBytes)) return whole;
  const text = value.original.content[0].text;
  for (let budget = SEARCH_PROJECTION_FINDINGS_BYTES; budget >= 1024; budget = Math.floor(budget / 2)) {
    const bounded: ToolExecutionResult = { ...envelope, content: [{ type: "text", text: value.executions?.length
      ? boundedSearchToolResultText(value.executions, budget)
      : (value.receipt && boundedRenderedSearchToolResultText(text, value.receipt, budget)) ??
        shortenedSearchToolResultText(text, budget) }] };
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
    // Neither is maskable: instructions stay pinned, and citation evidence is
    // never replaced by a descriptor.
    const projection = await receipt.storeSource({ outcome: retained.status, sourceTruncated: false, maskable: false });
    return projection ? { ...retained, observation: projection.observation } : retained;
  });
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/** The fields of the validated MCP result `captureMcpObservation` retained;
 * JSON drops an absent structured value. */
function decodeMcpOriginal(value: unknown): AiqsaMcpToolCallResult | null {
  if (!record(value)) return null;
  const { isError, structuredContent = null, text, unsupportedContentTypes } = value;
  if (typeof isError !== "boolean" || !strings(text) || !strings(unsupportedContentTypes) ||
    structuredContent !== null && !record(structuredContent)) return null;
  return { isError, structuredContent, text, unsupportedContentTypes };
}

/** The Workspace original is the result's status, content and runtime metadata. */
function decodeWorkspaceOriginal(value: unknown): Omit<ToolExecutionResult, "callId" | "name"> | null {
  if (!record(value)) return null;
  const { status, content, rawPreview } = value;
  if (status !== "complete" && status !== "error" || !Array.isArray(content) ||
    rawPreview !== undefined && !record(rawPreview)) return null;
  return { status, content: content as ToolExecutionResult["content"], ...(rawPreview ? { rawPreview } : {}) };
}

/** An ambiguous recovery repeats the live projection rule from the retained
 * original. Artifacts were never retained; Workspace restores without them. */
export async function restoreObservedResult(context: CaptureContext, call: Pick<ModelToolCall, "id" | "name">) {
  const restored = await context.service.restore(context.producer, context.signal,
    { wholeOriginalBytes: wholeOriginalBytes(context) });
  if (restored.search) return searchObservationProjection(call, restored.search, restored.projection);
  const source = restored.projection.observation.source;
  const mcp = source === "mcp" ? decodeMcpOriginal(restored.original) : null;
  if (mcp) return mcpObservationProjection(context, call, mcp, restored.projection);
  const workspace = source === "workspace" ? decodeWorkspaceOriginal(restored.original) : null;
  if (workspace) return workspaceObservationProjection(context, call, workspace, restored.projection);
  return observationResult(call, restored.status, restored.projection);
}
