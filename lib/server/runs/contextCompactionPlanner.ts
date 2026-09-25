import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ContextPlanMeasurement } from "../../contracts/contextCompaction";
import { decodeToolObservationDescriptor, type ToolObservationDescriptor } from "../toolObservations/contract";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge, ToolExecutionResult } from "../tools/types";
import { READ_TOOL_RESULT_NAME } from "../tools/readToolResult";
import {
  CONTEXT_COMPACTION_LIMITS,
  contextSummaryCoverage,
  contextSummaryMessageId,
  contextSummaryTail,
  type ContextObservation
} from "./contextCompactionContract";

type LocatedObservation = Readonly<{
  callId: string;
  name: string;
  descriptor: ToolObservationDescriptor;
  status: "complete" | "error";
}>;

type LocatedResult = Readonly<{
  index: number;
  /** A server-minted observation this result may be replaced by, or null for
   * an opaque result that must stay inline. */
  observation: LocatedObservation | null;
  /** The result is already the exact reference emitted by `maskResult`. */
  masked: boolean;
}>;

/** Authoritative settled observations, keyed by provider call id. */
type ObservationIndex = ReadonlyMap<string, ContextObservation>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
const PROJECTION_BYTES = 128 * 1024;

/** Canonical settled results are the only authority for an observation handle.
 * Provider result bodies are untrusted: an external tool can return a copy of
 * the descriptor/reader projection with a foreign handle. */
export function contextObservationsFromResults(results: readonly ToolExecutionResult[]): readonly ContextObservation[] {
  return results.flatMap((result) => {
    const observation = result.observation ? decodeToolObservationDescriptor(result.observation) : null;
    return observation && textId(result.callId) && textId(result.name)
      ? [{ callId: result.callId, name: result.name, observation, status: result.status }]
      : [];
  });
}

function observationIndex(observations: readonly ContextObservation[] | undefined): ObservationIndex {
  const index = new Map<string, ContextObservation>();
  const ambiguous = new Set<string>();
  for (const entry of observations ?? []) {
    if (!textId(entry.callId) || !decodeToolObservationDescriptor(entry.observation)) continue;
    const existing = index.get(entry.callId);
    // A call id naming two observations cannot identify either one.
    if (existing && existing.observation.handle !== entry.observation.handle) ambiguous.add(entry.callId);
    if (!existing) index.set(entry.callId, entry);
  }
  for (const callId of ambiguous) index.delete(callId);
  return index;
}

/** A single JSON object carried by one bridge result part. Multi-part bodies
 * (for example a preview followed by a projection) are never a reference. */
function singleJsonRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    if (value.length > PROJECTION_BYTES) return null;
    try { return singleJsonRecord(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return value.length === 1 ? singleJsonRecord(value[0], depth + 1) : null;
  if (!record(value)) return null;
  if (value.type === "json" && "value" in value) return singleJsonRecord(value.value, depth + 1);
  if ((value.type === "text" || value.type === "input_text") && typeof value.text === "string") {
    return singleJsonRecord(value.text, depth + 1);
  }
  if (value.type === "tool_result") return singleJsonRecord(value.content, depth + 1);
  return value;
}

/** The exact reader reference emitted by `maskResult`. */
function referenceDescriptor(carrier: unknown): ToolObservationDescriptor | null {
  const value = singleJsonRecord(carrier);
  if (!value) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "observation,reader" && keys !== "is_error,observation,reader") return null;
  if (value.reader !== READ_TOOL_RESULT_NAME || "is_error" in value && value.is_error !== true) return null;
  return decodeToolObservationDescriptor(value.observation);
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

/** Envelope-level identity only; a result body can never supply its call id. */
function envelopeCallId(value: Record<string, unknown>): string | null {
  for (const field of ["call_id", "tool_call_id", "callId", "tool_use_id"] as const) {
    if (textId(value[field])) return value[field] as string;
  }
  const block = Array.isArray(value.content) && value.content.length === 1 && record(value.content[0])
    ? value.content[0] : null;
  return block?.type === "tool_result" && textId(block.tool_use_id) ? block.tool_use_id : null;
}

function envelopeIsError(value: Record<string, unknown>): boolean {
  if (value.is_error === true || value.status === "error") return true;
  const block = Array.isArray(value.content) && value.content.length === 1 && record(value.content[0])
    ? value.content[0] : null;
  return block?.type === "tool_result" && block.is_error === true;
}

/** Tool names declared by one provider call item. Bridges without a name on
 * the result envelope (Responses, Messages) are resolved from these items,
 * never from text inside a result body. */
function recordCallNames(value: unknown, names: Map<string, string>): void {
  if (!record(value)) return;
  const add = (id: unknown, name: unknown) => {
    if (textId(id) && textId(name)) names.set(id, name);
  };
  if (value.type === "function_call") add(textId(value.call_id) ? value.call_id : value.id, value.name);
  if (value.type === "fake_assistant_tool_calls" && Array.isArray(value.calls)) {
    for (const call of value.calls) if (record(call)) add(call.id, call.name);
  }
  if (value.role === "assistant" && Array.isArray(value.tool_calls)) {
    for (const call of value.tool_calls) if (record(call) && record(call.function)) add(call.id, call.function.name);
  }
  if (value.role === "assistant" && Array.isArray(value.content)) {
    for (const block of value.content) if (record(block) && block.type === "tool_use") add(block.id, block.name);
  }
}

function locatedResult(
  value: unknown,
  index: number,
  names: ReadonlyMap<string, string>,
  observations: ObservationIndex
): LocatedResult | null {
  if (!isResultEnvelope(value)) return null;
  const callId = envelopeCallId(value);
  if (!callId) return { index, masked: false, observation: null };
  const carrier = resultCarrier(value);
  const reference = referenceDescriptor(carrier);
  const authoritative = observations.get(callId);
  if (authoritative) {
    // The descriptor comes from the canonical settled result, not the body.
    return { index, masked: reference?.handle === authoritative.observation.handle, observation: {
      callId,
      descriptor: authoritative.observation,
      name: authoritative.name,
      status: authoritative.status
    } };
  }
  const name = textId(value.name) ? value.name : names.get(callId) ?? null;
  if (name !== READ_TOOL_RESULT_NAME) return { index, masked: false, observation: null };
  // A reader response is recognized by its call name. Its top-level descriptor
  // is minted by the server-owned reader after reauthorizing the handle.
  const body = singleJsonRecord(carrier);
  const descriptor = reference ?? decodeToolObservationDescriptor(body?.observation);
  return descriptor
    ? { index, masked: reference !== null, observation: {
        callId, descriptor, name, status: envelopeIsError(value) || body?.is_error === true ? "error" : "complete"
      } }
    : { index, masked: false, observation: null };
}

function locatedResults(messages: readonly unknown[], observations: ObservationIndex): LocatedResult[] {
  // Only the nearest preceding call item names a result.
  const names = new Map<string, string>();
  return messages.flatMap((value, index) => {
    recordCallNames(value, names);
    const located = locatedResult(value, index, names, observations);
    return located ? [located] : [];
  });
}

function maskResult(bridge: ProviderToolBridge, located: LocatedObservation): unknown {
  const result: ToolExecutionResult = {
    callId: located.callId,
    content: [{ type: "json", value: {
      observation: located.descriptor,
      reader: READ_TOOL_RESULT_NAME,
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

export type ContextHistory = Readonly<{
  /** Prior conversation (not pins, not the current message), including an applied summary. */
  prior: readonly ProviderConversationMessage[];
  priorTokens: number;
  summaryMessage: ProviderConversationMessage | null;
  /** Prior messages already represented by the applied summary's source. */
  covered: readonly ProviderConversationMessage[];
  /** Prior messages no summary represents yet. */
  uncovered: readonly ProviderConversationMessage[];
  /** Uncovered messages older than the exact tail a summary retains. */
  older: readonly ProviderConversationMessage[];
}>;

/** The summary rebuild keeps pins, its note, a token-bounded exact tail (the
 * summarizer's `contextSummaryTail` rule) and the current message. Everything
 * else in the prior branch is reducible. Notes carried from an earlier turn
 * cover only their frozen branch prefix (`contextSummaryCoverage`). */
export function contextHistory(request: ProviderRunRequest, budgetTokens: number | null = null): ContextHistory {
  const messages = request.context?.messages ?? [];
  const current = messages.at(-1);
  const prior = messages.filter((message) => message.purpose === undefined && message !== current);
  const summary = request.contextCompactionSummary;
  const summaryId = summary ? contextSummaryMessageId(summary) : null;
  const summaryMessage = summaryId ? prior.find((message) => message.id === summaryId) ?? null : null;
  const rest = prior.filter((message) => message !== summaryMessage);
  const { covered, uncovered } = summary && summaryMessage
    ? contextSummaryCoverage(request, summary, rest) : { covered: [], uncovered: rest };
  return {
    covered,
    older: uncovered.slice(0, uncovered.length - contextSummaryTail(uncovered, budgetTokens).length),
    prior,
    priorTokens: prior.reduce((total, message) => total + estimateApproxTokens(message.content), 0),
    summaryMessage,
    uncovered
  };
}

/** Whole prior turns, oldest first: a user message starts a turn unless it is
 * a clarification of the same turn. */
export function contextTurns(messages: readonly ProviderConversationMessage[]): ProviderConversationMessage[][] {
  const groups: ProviderConversationMessage[][] = [];
  let current: ProviderConversationMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0 &&
      (!message.contextTurnId || message.contextTurnId !== (current[0]?.contextTurnId ?? current[0]?.id))) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Whole covered turns leave oldest first. The summary source already
 * contained every covered message, so this bounds its exact tail instead of
 * discarding unsummarized history. The paid summary note itself always stays. */
function trimCoveredHistory(request: ProviderRunRequest, history: ContextHistory, excessTokens: number): Readonly<{
  droppedMessages: number;
  droppedTokens: number;
  request: ProviderRunRequest;
}> {
  const dropped = new Set<ProviderConversationMessage>();
  let droppedTokens = 0;
  for (const turn of contextTurns(history.covered)) {
    if (droppedTokens >= excessTokens) break;
    for (const message of turn) {
      dropped.add(message);
      droppedTokens += estimateApproxTokens(message.content);
    }
  }
  return {
    droppedMessages: dropped.size,
    droppedTokens,
    request: {
      ...request,
      context: { ...request.context!, messages: request.context!.messages.filter((message) => !dropped.has(message)) }
    }
  };
}

export type ContextCompactionPlan = Readonly<{
  measurement: ContextPlanMeasurement;
  request: ProviderRunRequest;
  /** Present only when covered hybrid history left the projection. */
  historyTrim?: Readonly<{ droppedMessages: number; droppedTokens: number }>;
}>;

/**
 * Masks only complete, persisted observation result envelopes. It deliberately
 * does not parse or rewrite arbitrary provider messages: an unknown shape stays
 * inline, preserving the old request guard and its exact failure semantics.
 *
 * `observations` are the server-minted descriptors of this run's settled calls.
 * Without them only `read_tool_result` responses are recognized, so a result
 * body can never introduce a handle into masking, checkpoints or summaries.
 * Hybrid requests additionally receive a truthful outcome: a summary is
 * requested only when it can remove uncovered history, and a fitting request
 * is never reported as overflow.
 */
export function planContextCompaction(input: Readonly<{
  assembledTokens?: number | null;
  budgetTokens?: number | null;
  bridge?: ProviderToolBridge;
  observations?: readonly ContextObservation[];
  request: ProviderRunRequest;
}>): ContextCompactionPlan {
  const request = input.request;
  const budgetTokens = typeof input.budgetTokens === "number" && Number.isFinite(input.budgetTokens)
    ? input.budgetTokens : null;
  const original = request.providerToolMessages ?? [];
  const providerMessageTokens = estimateApproxTokens(original);
  const beforeTokens = input.assembledTokens === undefined || input.assembledTokens === null
    ? providerMessageTokens
    : Math.max(providerMessageTokens, Math.ceil(input.assembledTokens));

  let planned = request;
  let afterTokens = beforeTokens;
  let maskedBatches = 0;
  let maskedObservations = 0;
  // Agent compaction is owned by Codex. Legacy/off/historical requests and
  // bridges without client tools keep the existing whole-turn budget guard.
  // A mask is a promise of recall: the reader must be callable in this round,
  // and an unknown window has no budget that could justify the loss.
  const maskingAvailable = !request.agent && request.toolObservationVersion === 1 && input.bridge !== undefined &&
    request.modelCapabilities.toolCalling === true && request.toolChoice !== "none" &&
    request.tools?.some(tool => tool.name === READ_TOOL_RESULT_NAME && tool.capability === "session") === true &&
    input.bridge.supportsToolCalling({ modelId: request.modelId, provider: request.provider }) &&
    !request.previousProviderResponseId && original.length > 0 && budgetTokens !== null;
  if (maskingAvailable && beforeTokens > budgetTokens * CONTEXT_COMPACTION_LIMITS.triggerRatio) {
    const results = locatedResults(original, observationIndex(input.observations));
    const groups = resultGroups(results);
    const retained = new Set((groups.at(-CONTEXT_COMPACTION_LIMITS.recentBatches) ?? []).map(candidate => candidate.index));
    // An existing reference is already the smallest projection; masking it
    // again cannot make progress.
    const toMask = results.filter(candidate => candidate.observation?.descriptor.maskable &&
      !candidate.masked && !retained.has(candidate.index));
    if (toMask.length > 0) {
      const byIndex = new Map(toMask.map(candidate => [candidate.index, candidate.observation!]));
      const masked = original.map((value, index) => {
        const candidate = byIndex.get(index);
        return candidate ? maskResult(input.bridge!, candidate) : value;
      });
      const maskedTokens = Math.max(0, beforeTokens - providerMessageTokens) + estimateApproxTokens(masked);
      if (maskedTokens < beforeTokens) {
        planned = { ...request, providerToolMessages: masked };
        afterTokens = maskedTokens;
        maskedBatches = groups.filter(group => group.some(candidate => byIndex.has(candidate.index))).length;
        maskedObservations = toMask.length;
      }
    }
  }
  const result = (outcome: ContextPlanMeasurement["outcome"], extra: Partial<Pick<ContextCompactionPlan, "historyTrim">> & {
    afterTokens?: number; legacyFallback?: boolean; request?: ProviderRunRequest;
  } = {}): ContextCompactionPlan => ({
    measurement: measurement({
      afterTokens: extra.afterTokens ?? afterTokens,
      beforeTokens,
      budgetTokens,
      legacyFallback: extra.legacyFallback ?? false,
      maskedBatches,
      maskedObservations,
      outcome
    }),
    request: extra.request ?? planned,
    ...(extra.historyTrim ? { historyTrim: extra.historyTrim } : {})
  });
  const settled = (): ContextPlanMeasurement["outcome"] => maskedObservations > 0 ? "masking_applied" : "already_fits";
  const aboveTarget = budgetTokens !== null && maskedObservations > 0 &&
    afterTokens > budgetTokens * CONTEXT_COMPACTION_LIMITS.targetRatio;

  if (request.agent || request.contextCompactionPolicy?.mode !== "hybrid" || budgetTokens === null) {
    // Legacy-compatible measurement. An over-budget request is never reported
    // as fitting; the whole-turn guard owns the remaining reduction.
    if (budgetTokens !== null && afterTokens > budgetTokens) return result("needs_summary");
    return result(aboveTarget ? "needs_summary" : settled());
  }

  const history = contextHistory(planned, budgetTokens);
  // The exact minimum keeps an applied summary note: it is never traded away.
  const summaryTokens = history.summaryMessage ? estimateApproxTokens(history.summaryMessage.content) : 0;
  if (afterTokens - history.priorTokens + summaryTokens > budgetTokens) return result("irreducible_overflow");
  if (afterTokens > budgetTokens) {
    // Covered turns leave first: the note already stands for them. Only
    // uncovered history that must still leave requires a (new) summary.
    const trimmed = trimCoveredHistory(planned, history, afterTokens - budgetTokens);
    if (history.uncovered.length > 0 && afterTokens - trimmed.droppedTokens > budgetTokens) return result("needs_summary");
    return result(settled(), {
      afterTokens: afterTokens - trimmed.droppedTokens,
      historyTrim: { droppedMessages: trimmed.droppedMessages, droppedTokens: trimmed.droppedTokens },
      legacyFallback: true,
      request: trimmed.request
    });
  }
  // Above the 75% trigger, a summary buys headroom for later rounds whenever
  // the history older than the exact tail it keeps is large enough to release
  // room once replaced by notes, whether or not masking ran; it never turns
  // this fitting request into overflow.
  const olderTokens = history.older.reduce((total, message) => total + estimateApproxTokens(message.content), 0);
  const headroom = beforeTokens > budgetTokens * CONTEXT_COMPACTION_LIMITS.triggerRatio &&
    afterTokens > budgetTokens * CONTEXT_COMPACTION_LIMITS.targetRatio &&
    olderTokens > budgetTokens * CONTEXT_COMPACTION_LIMITS.summaryMinimumReleaseRatio;
  return result(headroom ? "needs_summary" : settled());
}

function recognizedObservations(
  messages: readonly unknown[],
  observations: readonly ContextObservation[] | undefined
): LocatedObservation[] {
  return locatedResults(messages, observationIndex(observations)).flatMap((located) =>
    located.observation ? [located.observation] : []);
}

export function observationHandlesInProviderMessages(
  messages: readonly unknown[],
  observations?: readonly ContextObservation[]
): readonly string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const candidate of recognizedObservations(messages, observations)) {
    if (!seen.has(candidate.descriptor.handle)) {
      seen.add(candidate.descriptor.handle);
      handles.push(candidate.descriptor.handle);
    }
  }
  return handles.slice(0, CONTEXT_COMPACTION_LIMITS.references);
}

/** Handles of results currently replaced by their reader reference: the
 * provider-facing transcript no longer carries their content. */
export function maskedObservationHandlesInProviderMessages(
  messages: readonly unknown[],
  observations?: readonly ContextObservation[]
): readonly string[] {
  return [...new Set(locatedResults(messages, observationIndex(observations)).flatMap((located) =>
    located.masked && located.observation ? [located.observation.descriptor.handle] : []))]
    .slice(0, CONTEXT_COMPACTION_LIMITS.references);
}

export function observationCallIdsInProviderMessages(
  messages: readonly unknown[],
  observations?: readonly ContextObservation[]
): readonly string[] {
  const callIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of recognizedObservations(messages, observations)) {
    if (!seen.has(candidate.callId)) {
      seen.add(candidate.callId);
      callIds.push(candidate.callId);
    }
  }
  return callIds.slice(-64);
}

/** Legacy-compatible budget outcome. The planner already reports overflow as
 * `needs_summary`; this only records whether whole-turn trimming delivered it. */
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
