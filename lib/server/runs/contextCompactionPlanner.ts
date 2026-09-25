import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ContextPlanMeasurement } from "../../contracts/contextCompaction";
import { decodeToolObservationDescriptor, type ToolObservationDescriptor } from "../toolObservations/contract";
import type { ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge, ToolExecutionResult } from "../tools/types";
import { READ_TOOL_RESULT_NAME } from "../tools/readToolResult";
import {
  CONTEXT_COMPACTION_LIMITS,
} from "./contextCompactionContract";

type LocatedObservation = Readonly<{
  callId: string;
  name: string;
  descriptor: ToolObservationDescriptor;
  status: "complete" | "error";
}>;

type LocatedResult = Readonly<{
  index: number;
  observation: LocatedObservation | null;
}>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;

function projectionIn(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string" && value.length <= 128 * 1024) {
    try { return projectionIn(JSON.parse(value)); } catch {
      // Text bridges may carry the canonical JSON projection after a bounded
      // human-readable preview. Recover only a complete descriptor object;
      // arbitrary text remains opaque.
      const start = value.lastIndexOf('\n\n{"observation":');
      if (start >= 0) return projectionIn(value.slice(start + 2));
      return null;
    }
  }
  // Only our final projection part is authoritative. Never search arbitrary
  // result bodies recursively for a descriptor supplied by an external tool.
  if (Array.isArray(value)) return value.length ? projectionIn(value.at(-1)) : null;
  if (!record(value)) return null;
  if (value.reader === READ_TOOL_RESULT_NAME && decodeToolObservationDescriptor(value.observation)) return value;
  // `read_tool_result` returns the descriptor inside its JSON result rather
  // than adding the projection marker used by a masked provider result. The
  // descriptor is still server-minted and therefore safe to use when a later
  // compaction cycle needs to replace the returned fragment with its handle.
  if (decodeToolObservationDescriptor(value.observation)) return value;
  if (value.type === "json") return projectionIn(value.value);
  if (value.type === "text") return projectionIn(value.text);
  if (value.type === "tool_result") return projectionIn(value.content);
  return null;
}

function isReaderFragment(value: Record<string, unknown> | null): boolean {
  return value?.fragmentKind === "serialized_json_text" &&
    typeof value.fragment === "string" &&
    Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 &&
    Number.isSafeInteger(value.endOffset) && Number(value.endOffset) >= Number(value.offset) &&
    typeof value.incomplete === "boolean" &&
    decodeToolObservationDescriptor(value.observation) !== null;
}

function fieldIn(value: unknown, fields: readonly string[], seen = new Set<object>()): string | null {
  if (typeof value === "string" && value.length <= 128 * 1024) {
    try { return fieldIn(JSON.parse(value), fields, seen); } catch { return null; }
  }
  if (!record(value) && !Array.isArray(value)) return null;
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return null;
    seen.add(value);
  }
  if (record(value)) {
    for (const field of fields) if (textId(value[field])) return value[field] as string;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = fieldIn(item, fields, seen);
    if (found) return found;
  }
  return null;
}

function hasErrorMarker(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return projectionIn(value)?.is_error === true;
  if (!record(value) && !Array.isArray(value)) return false;
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return false;
    seen.add(value);
  }
  if (record(value) && (value.is_error === true || value.isError === true || value.status === "error")) return true;
  return (Array.isArray(value) ? value : Object.values(value)).some(item => hasErrorMarker(item, seen));
}

function isResultEnvelope(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (typeof value.callId === "string" && "content" in value &&
    (value.status === "complete" || value.status === "error" || "observation" in value)) return true;
  if (value.role === "tool") return true;
  if (value.type === "function_call_output" || value.type === "function_result" || value.type === "fake_tool_result") return true;
  // An adapter can supply opaque or mixed user content. Only the single
  // result envelope emitted by appendToolResult is safe to rebuild.
  if (value.role === "user" && Array.isArray(value.content) && value.content.length === 1 &&
    record(value.content[0]) && value.content[0].type === "tool_result") return true;
  return false;
}

function resultCarrier(value: Record<string, unknown>): unknown {
  if ("output" in value) return value.output;
  if ("result" in value) return value.result;
  return value.content;
}

function locatedResult(value: unknown, index: number): LocatedResult | null {
  if (!isResultEnvelope(value)) return null;
  const projection = projectionIn(resultCarrier(value));
  const resultName = fieldIn(value, ["name"]);
  // A nested descriptor is authoritative only for the server-owned reader
  // response. Other tool bodies may contain a lookalike object supplied by an
  // external service and must remain opaque. Masked projections are safe via
  // their explicit reader marker; canonical tool projections carry the
  // descriptor at the envelope root.
  const nestedDescriptor = projection?.reader === READ_TOOL_RESULT_NAME || resultName === READ_TOOL_RESULT_NAME || isReaderFragment(projection)
    ? projection?.observation
    : undefined;
  const descriptor = decodeToolObservationDescriptor(value.observation ?? nestedDescriptor);
  const callId = fieldIn(value, ["call_id", "tool_call_id", "callId", "tool_use_id", "id"]);
  if (!descriptor || !callId) return { index, observation: null };
  const name = resultName ?? "tool_result";
  return { index, observation: {
    callId,
    descriptor,
    name,
    status: hasErrorMarker(value) ? "error" : "complete"
  } };
}

function maskResult(bridge: ProviderToolBridge, located: LocatedObservation): unknown {
  const result: ToolExecutionResult = {
    callId: located.callId,
    content: [{ type: "json", value: {
      observation: located.descriptor,
      reader: "read_tool_result",
      ...(located.status === "error" ? { is_error: true } : {})
    } }],
    name: located.name,
    status: located.status
  };
  return bridge.appendToolResult(undefined, result);
}

function resultGroups(results: readonly LocatedResult[]): LocatedResult[][] {
  const groups: LocatedResult[][] = [];
  for (const candidate of results) {
    const current = groups.at(-1);
    if (current && candidate.index === current.at(-1)!.index + 1) current.push(candidate);
    else groups.push([candidate]);
  }
  return groups;
}

function measurement(input: Readonly<{
  beforeTokens: number;
  afterTokens: number;
  budgetTokens?: number | null;
  maskedBatches: number;
  maskedObservations: number;
  outcome: ContextPlanMeasurement["outcome"];
  legacyFallback?: boolean;
}>): ContextPlanMeasurement {
  return {
    afterTokens: input.afterTokens,
    beforeTokens: input.beforeTokens,
    budgetTokens: input.budgetTokens ?? null,
    legacyFallback: input.legacyFallback ?? false,
    maskedBatches: input.maskedBatches,
    maskedObservations: input.maskedObservations,
    outcome: input.outcome,
    version: 1
  };
}

/**
 * Masks only complete, persisted observation result envelopes. It deliberately
 * does not parse or rewrite arbitrary provider messages: an unknown shape stays
 * inline, preserving the old request guard and its exact failure semantics.
 */
export function planContextCompaction(input: Readonly<{
  assembledTokens?: number | null;
  budgetTokens?: number | null;
  bridge?: ProviderToolBridge;
  request: ProviderRunRequest;
}>): Readonly<{ measurement: ContextPlanMeasurement; request: ProviderRunRequest }> {
  const request = input.request;
  const original = request.providerToolMessages ?? [];
  const providerMessageTokens = estimateApproxTokens(original);
  const beforeTokens = input.assembledTokens === undefined || input.assembledTokens === null
    ? providerMessageTokens
    : Math.max(providerMessageTokens, Math.ceil(input.assembledTokens));
  const noOp = (outcome: ContextPlanMeasurement["outcome"] = "already_fits") => ({
    measurement: measurement({ afterTokens: beforeTokens, beforeTokens, budgetTokens: input.budgetTokens,
      maskedBatches: 0, maskedObservations: 0, outcome }),
    request
  });

  // Agent compaction is owned by Codex. Legacy/off/historical requests and
  // bridges without client tools keep the existing whole-turn budget guard.
  if (request.agent || request.toolObservationVersion !== 1 || !input.bridge ||
    request.modelCapabilities.toolCalling !== true ||
    !request.tools?.some(tool => tool.name === READ_TOOL_RESULT_NAME && tool.capability === "session") ||
    !input.bridge.supportsToolCalling({ modelId: request.modelId, provider: request.provider }) ||
    request.previousProviderResponseId || original.length === 0) return noOp();
  if (input.budgetTokens !== undefined && input.budgetTokens !== null &&
    beforeTokens <= input.budgetTokens * CONTEXT_COMPACTION_LIMITS.triggerRatio) return noOp();

  const candidates = original.flatMap((value, index) => {
    const result = locatedResult(value, index);
    return result ? [result] : [];
  });
  if (candidates.length === 0) return noOp();
  const groups = resultGroups(candidates);
  const retained = new Set((groups.at(-CONTEXT_COMPACTION_LIMITS.recentBatches) ?? []).map(candidate => candidate.index));
  const toMask = candidates.filter(candidate => candidate.observation?.descriptor.maskable && !retained.has(candidate.index));
  if (toMask.length === 0) return noOp();
  const byIndex = new Map(toMask.map(candidate => [candidate.index, candidate.observation!]));
  const masked = original.map((value, index) => {
    const candidate = byIndex.get(index);
    return candidate ? maskResult(input.bridge!, candidate) : value;
  });
  const afterProviderMessageTokens = estimateApproxTokens(masked);
  const fixedTokens = Math.max(0, beforeTokens - providerMessageTokens);
  const afterTokens = fixedTokens + afterProviderMessageTokens;
  if (afterTokens >= beforeTokens) return noOp("needs_summary");
  const result = {
    measurement: measurement({
      afterTokens,
      beforeTokens,
      budgetTokens: input.budgetTokens,
      maskedBatches: groups.filter(group => group.some(candidate => byIndex.has(candidate.index))).length,
      maskedObservations: toMask.length,
      outcome: input.budgetTokens !== undefined && input.budgetTokens !== null &&
        afterTokens > input.budgetTokens * CONTEXT_COMPACTION_LIMITS.targetRatio
        ? "needs_summary"
        : "masking_applied"
    }),
    request: { ...request, providerToolMessages: masked }
  } satisfies Readonly<{ measurement: ContextPlanMeasurement; request: ProviderRunRequest }>;
  return result;
}

export function observationHandlesInProviderMessages(messages: readonly unknown[]): readonly string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const candidate of messages.flatMap((value, index) => {
    const located = locatedResult(value, index);
    return located?.observation ? [located.observation.descriptor.handle] : [];
  })) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      handles.push(candidate);
    }
  }
  return handles.slice(0, CONTEXT_COMPACTION_LIMITS.references);
}

export function observationCallIdsInProviderMessages(messages: readonly unknown[]): readonly string[] {
  const callIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of messages.entries()) {
    const located = locatedResult(value, index);
    const callId = located?.observation?.callId;
    if (callId && !seen.has(callId)) {
      seen.add(callId);
      callIds.push(callId);
    }
  }
  return callIds.slice(-64);
}

export function contextCompactionMeasurementWithBudget(
  plan: ContextPlanMeasurement,
  budgetTokens: number | null,
  accepted: boolean
): ContextPlanMeasurement {
  const overBudget = budgetTokens !== null && plan.afterTokens > budgetTokens;
  return { ...plan,
    budgetTokens,
    outcome: overBudget ? accepted ? "needs_summary" : "irreducible_overflow" : plan.outcome,
    legacyFallback: overBudget && accepted
  };
}
