import { contextTokenEstimator } from "../../domain/tokenEstimate";
import type { ContextPlanMeasurement, ContextRejectionRebuild, ContextSummary } from "../../contracts/contextCompaction";
import { decodeToolObservationDescriptor, type ToolObservationDescriptor } from "../toolObservations/contract";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge, RunTool, RunToolCapability, ToolExecutionResult } from "../tools/types";
import { READ_TOOL_RESULT_NAME } from "../tools/readToolResult";
import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";
import type { ToolCallRefEntry } from "../../contracts/toolHistory";
import { isCurrentTurnToolHistory, toolCallRefIndex } from "./toolHistoryContract";
import {
  CONTEXT_COMPACTION_LIMITS,
  contextDigest,
  contextSummaryCoverage,
  contextSummaryMessageId,
  contextSummaryTail,
  isUnitCoverageRef,
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

/** The provider call id of one result envelope, or null for any other item.
 * Envelope-level identity only: a result body never supplies it. */
export function providerResultCallId(value: unknown): string | null {
  return isResultEnvelope(value) ? envelopeCallId(value) : null;
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

/** One provider protocol unit of the retained tool transcript: the items one
 * provider round emitted (reasoning, text, hosted items and its calls) followed
 * by the results of those calls. Units are only ever kept or removed whole, so
 * a request never carries a result without its call, a call without its
 * result, or reasoning/signature items without the calls they precede. */
export type ToolTranscriptUnit = Readonly<{
  /** Inclusive start and exclusive end index in `providerToolMessages`. */
  start: number;
  end: number;
  callIds: readonly string[];
  /** Every call has exactly one result in this unit and every result answers
   * one of its calls. Only a settled unit can ever leave. */
  settled: boolean;
}>;

function callIdsOf(value: unknown): string[] {
  const names = new Map<string, string>();
  recordCallNames(value, names);
  return [...names.keys()];
}

/** Splits a tool transcript at batch boundaries: a unit ends where call-side
 * items follow result items. A clarification tail or any other item after the
 * last results forms its own call-less unit, which is never reducible. */
export function toolTranscriptUnits(messages: readonly unknown[]): ToolTranscriptUnit[] {
  const units: ToolTranscriptUnit[] = [];
  let start = 0;
  let calls: string[] = [];
  let results: string[] = [];
  let unmatched = false;
  let inResults = false;
  const flush = (end: number) => {
    if (end > start) {
      const callSet = new Set(calls);
      const resultSet = new Set(results);
      units.push({
        callIds: calls,
        end,
        settled: calls.length > 0 && !unmatched && callSet.size === calls.length && resultSet.size === results.length &&
          calls.length === results.length && results.every((id) => callSet.has(id)),
        start
      });
    }
    start = end;
    calls = [];
    results = [];
    unmatched = false;
    inResults = false;
  };
  messages.forEach((value, index) => {
    if (isResultEnvelope(value)) {
      const callId = envelopeCallId(value);
      if (callId) results.push(callId);
      else unmatched = true;
      inResults = true;
      return;
    }
    if (inResults) flush(index);
    calls.push(...callIdsOf(value));
  });
  flush(messages.length);
  return units;
}

const TRANSCRIPT_COVERAGE_PREFIX = "ctxt1_";

/** Historical summary ref naming the newest provider call its source
 * contained. Only notes bought before unit refs existed carry it; it is read
 * as a prefix of the transcript and never written again. */
export function transcriptCoverageRef(callId: string): string {
  return `${TRANSCRIPT_COVERAGE_PREFIX}${contextDigest({ callId }).slice(0, 32)}`;
}

export function isTranscriptCoverageRef(ref: string): boolean {
  return ref.startsWith(TRANSCRIPT_COVERAGE_PREFIX);
}

/** Opaque summary ref naming one provider protocol unit its source contained,
 * by the unit's call ids. Coverage is the set of these refs, not a prefix. */
export function unitCoverageRef(unit: Pick<ToolTranscriptUnit, "callIds">): string {
  return `ctxu1_${contextDigest({ callIds: unit.callIds }).slice(0, 32)}`;
}

export { isUnitCoverageRef };

/** Server-owned capabilities whose results AIQSA owns or reauthorizes when
 * they are read again: their content may enter notes without an observation
 * handle. External content (MCP, Workspace, web Search) needs a server-minted
 * handle or call reference, so its later revocation remains checkable. */
const NOTE_CAPABILITIES: ReadonlySet<RunToolCapability> = new Set(["artifact", "image", "knowledge", "memory", "session", "skill"]);

/** Whether one settled result may enter a summary source. The decision uses
 * only server authority: the run's settled observation for the call id, the
 * accepted tool definition the call's name resolves to, and the persisted
 * call's reference (`call_ref`), which names external content without an
 * observation so its availability is rechecked before notes travel. A result
 * body can never supply its handle, capability, name or reference. */
function noteableResult(
  callId: string,
  name: string | null,
  observations: ObservationIndex,
  tools: readonly RunTool[] | undefined,
  callRefs: ReadonlyMap<string, ToolCallRefEntry>
): boolean {
  if (observations.has(callId)) return true;
  const tool = name === null ? undefined : tools?.find((candidate) => candidate.name === name);
  if (!tool) return false;
  if (NOTE_CAPABILITIES.has(tool.capability)) return true;
  // MCP discovery returns the frozen snapshot catalog, never external content.
  if (tool.capability === "mcp" && tool.name === MCP_FIND_TOOLS_NAME) return true;
  return callRefs.get(callId)?.name === tool.name;
}

/** Whether every result of a unit may enter notes. One excluded result
 * excludes the whole unit: units only ever leave or stay whole. */
function unitNoteable(
  messages: readonly unknown[],
  unit: ToolTranscriptUnit,
  names: ReadonlyMap<string, string>,
  observations: ObservationIndex,
  tools: readonly RunTool[] | undefined,
  callRefs: ReadonlyMap<string, ToolCallRefEntry>
): boolean {
  if (!unit.settled) return false;
  for (let index = unit.start; index < unit.end; index += 1) {
    const value = messages[index];
    if (!isResultEnvelope(value)) continue;
    const callId = envelopeCallId(value);
    if (!callId) return false;
    const name = names.get(callId) ?? (textId(value.name) ? value.name : null);
    if (!noteableResult(callId, name, observations, tools, callRefs)) return false;
  }
  return true;
}

function transcriptCallNames(messages: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const value of messages) recordCallNames(value, names);
  return names;
}

/** The applied notes this run bought (carried notes never cover this run's calls). */
function ownAppliedSummary(request: ProviderRunRequest): ContextSummary | null {
  const summary = request.contextCompactionSummary;
  return summary && summary.id !== request.contextCompactionPolicy?.reuse?.summary.id &&
    request.context?.messages.some((message) => message.id === contextSummaryMessageId(summary)) === true
    ? summary : null;
}

export type ToolTranscriptReduction = Readonly<{
  /** Every unit of the retained transcript, oldest first. */
  units: readonly ToolTranscriptUnit[];
  /** Settled units strictly older than the newest unit with calls: everything
   * that may ever leave. The newest batch, call-less tails and unsettled
   * units always stay exact. */
  older: readonly ToolTranscriptUnit[];
  /** Units whose items were in the source of notes this run bought and
   * applied, at any position. Only covered units of `older` may leave or be
   * masked; a covered newest batch is already represented once it ages. */
  covered: ReadonlySet<ToolTranscriptUnit>;
  /** Settled units whose every result may enter notes (see `noteableResult`).
   * An excluded unit is never summarized, covered, masked or removed. */
  noteable: ReadonlySet<ToolTranscriptUnit>;
}>;

const NO_TRANSCRIPT_REDUCTION: ToolTranscriptReduction = { covered: new Set(), noteable: new Set(), older: [], units: [] };

/**
 * Transcript units a request may reduce. Ordinary runs resend the full
 * transcript every round (masking and this reduction require the absence of a
 * provider continuation), so whole earlier units can leave once covered.
 * Coverage is the set of `ctxu1_` unit refs of the notes this run bought and
 * applied. Notes bought before those refs existed name only their newest call
 * (`ctxt1_`) and cover the transcript prefix through it.
 */
export function toolTranscriptReduction(
  request: ProviderRunRequest,
  observations?: readonly ContextObservation[]
): ToolTranscriptReduction {
  const messages = request.providerToolMessages ?? [];
  if (request.agent || request.previousProviderResponseId || messages.length === 0) return NO_TRANSCRIPT_REDUCTION;
  const units = toolTranscriptUnits(messages);
  let newest = -1;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index]!.callIds.length > 0) { newest = index; break; }
  }
  const own = ownAppliedSummary(request);
  const refs = new Set(own?.sourceRefs ?? []);
  const unitRefs = own?.sourceRefs.some(isUnitCoverageRef) === true;
  let boundary = -1;
  if (!unitRefs) {
    const markers = new Set(own?.sourceRefs.filter(isTranscriptCoverageRef) ?? []);
    for (let index = units.length - 1; index >= 0 && boundary < 0 && markers.size > 0; index -= 1) {
      if (units[index]!.callIds.some((callId) => markers.has(transcriptCoverageRef(callId)))) boundary = index;
    }
  }
  const names = transcriptCallNames(messages);
  const index = observationIndex(observations);
  const callRefs = toolCallRefIndex(request.toolCallRefs);
  const older: ToolTranscriptUnit[] = [];
  const covered = new Set<ToolTranscriptUnit>();
  const noteable = new Set<ToolTranscriptUnit>();
  units.forEach((unit, position) => {
    if (!unit.settled) return;
    if (unitRefs ? refs.has(unitCoverageRef(unit)) : position <= boundary) covered.add(unit);
    if (unitNoteable(messages, unit, names, index, request.tools, callRefs)) noteable.add(unit);
    if (position < newest) older.push(unit);
  });
  return { covered, noteable, older, units };
}

function withoutUnits(messages: readonly unknown[], units: Iterable<ToolTranscriptUnit>): unknown[] {
  const removed = new Set<number>();
  for (const unit of units) for (let index = unit.start; index < unit.end; index += 1) removed.add(index);
  return messages.filter((_value, index) => !removed.has(index));
}

/** Covered units leave oldest first, whole, until the excess is released.
 * The estimate is verified on the exact remaining transcript. */
function trimCoveredTranscript(request: ProviderRunRequest, covered: readonly ToolTranscriptUnit[], excessTokens: number): Readonly<{
  dropped: readonly ToolTranscriptUnit[];
  droppedTokens: number;
  request: ProviderRunRequest;
}> {
  const estimate = contextTokenEstimator(request);
  const messages = request.providerToolMessages ?? [];
  const total = estimate(messages);
  const dropped: ToolTranscriptUnit[] = [];
  let estimated = 0;
  let remaining = messages;
  for (const unit of covered) {
    if (estimated >= excessTokens) {
      remaining = withoutUnits(messages, dropped);
      estimated = total - estimate(remaining);
      if (estimated >= excessTokens) break;
    }
    dropped.push(unit);
    estimated += estimate(messages.slice(unit.start, unit.end));
  }
  remaining = withoutUnits(messages, dropped);
  return dropped.length > 0
    ? { dropped, droppedTokens: total - estimate(remaining), request: { ...request, providerToolMessages: remaining } }
    : { dropped, droppedTokens: 0, request };
}

function measurement(input: Readonly<{
  beforeTokens: number;
  afterTokens: number;
  budgetTokens?: number | null;
  maskedBatches: number;
  maskedObservations: number;
  outcome: ContextPlanMeasurement["outcome"];
}>): ContextPlanMeasurement {
  return {
    afterTokens: input.afterTokens,
    beforeTokens: input.beforeTokens,
    budgetTokens: input.budgetTokens ?? null,
    // Historical field: whole-turn truncation of unsummarized history no
    // longer exists, so every new measurement records false.
    legacyFallback: false,
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
 * else in the prior branch is reducible. Applied notes cover the branch prefix
 * through their boundary (`contextSummaryCoverage`). */
export function contextHistory(request: ProviderRunRequest, budgetTokens: number | null = null): ContextHistory {
  const messages = request.context?.messages ?? [];
  const current = messages.at(-1);
  // The record of earlier attempts of the current message belongs to the
  // current turn, which never leaves a request.
  const prior = messages.filter((message) => message.purpose === undefined && message !== current &&
    !isCurrentTurnToolHistory(message, current));
  const summary = request.contextCompactionSummary;
  const summaryId = summary ? contextSummaryMessageId(summary) : null;
  const summaryMessage = summaryId ? prior.find((message) => message.id === summaryId) ?? null : null;
  const rest = prior.filter((message) => message !== summaryMessage);
  const { covered, uncovered } = summary && summaryMessage
    ? contextSummaryCoverage(request, summary, rest) : { covered: [], uncovered: rest };
  const estimate = contextTokenEstimator(request);
  return {
    covered,
    older: uncovered.slice(0, uncovered.length - contextSummaryTail(uncovered, budgetTokens, estimate).length),
    prior,
    priorTokens: prior.reduce((total, message) => total + estimate(message.content), 0),
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
  const estimate = contextTokenEstimator(request);
  const dropped = new Set<ProviderConversationMessage>();
  let droppedTokens = 0;
  for (const turn of contextTurns(history.covered)) {
    if (droppedTokens >= excessTokens) break;
    for (const message of turn) {
      dropped.add(message);
      droppedTokens += estimate(message.content);
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

/** The part of a hybrid request no reduction can remove: prompt, pins,
 * current input, tools, an applied summary note, excluded and unsettled
 * transcript items and the newest batch. */
function reductionFloor(input: Readonly<{
  beforeTokens: number;
  budgetTokens: number;
  estimate: (value: unknown) => number;
  observations?: readonly ContextObservation[];
  providerMessageTokens: number;
  request: ProviderRunRequest;
}>) {
  const { estimate, request } = input;
  const original = request.providerToolMessages ?? [];
  const history = contextHistory(request, input.budgetTokens);
  // The exact minimum keeps an applied summary note: it is never traded away.
  const summaryTokens = history.summaryMessage ? estimate(history.summaryMessage.content) : 0;
  const transcript = toolTranscriptReduction(request, input.observations);
  // Older settled units leave once covered; noteable ones can become covered.
  // Excluded units, the newest batch and unsettled items always stay exact.
  const reducibleUnits = transcript.older.filter((unit) => transcript.covered.has(unit) || transcript.noteable.has(unit));
  const retainedTranscriptTokens = reducibleUnits.length > 0
    ? estimate(withoutUnits(original, reducibleUnits)) : input.providerMessageTokens;
  const minimumTokens = input.beforeTokens - history.priorTokens + summaryTokens -
    (input.providerMessageTokens - retainedTranscriptTokens);
  return { history, minimumTokens, retainedTranscriptTokens, summaryTokens, transcript };
}

/**
 * A hybrid request's irreducible minimum (as `planContextCompaction` measures
 * it) and the reducible material no committed notes cover yet, which the next
 * notes would have to stand for.
 */
export function contextReductionFloor(input: Readonly<{
  assembledTokens: number;
  budgetTokens: number;
  observations?: readonly ContextObservation[];
  request: ProviderRunRequest;
}>): Readonly<{ minimumTokens: number; uncoveredBytes: number; uncoveredTokens: number }> {
  const estimate = contextTokenEstimator(input.request);
  const original = input.request.providerToolMessages ?? [];
  const providerMessageTokens = estimate(original);
  const floor = reductionFloor({ beforeTokens: Math.max(providerMessageTokens, Math.ceil(input.assembledTokens)),
    budgetTokens: input.budgetTokens, estimate, observations: input.observations, providerMessageTokens, request: input.request });
  const { history, transcript } = floor;
  const uncoveredUnits = transcript.older.filter((unit) => transcript.noteable.has(unit) && !transcript.covered.has(unit));
  const uncovered = [...history.uncovered.map((message) => message.content),
    ...uncoveredUnits.flatMap((unit) => original.slice(unit.start, unit.end))];
  return {
    minimumTokens: floor.minimumTokens,
    uncoveredBytes: uncovered.reduce<number>((total, value) => total + Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"), 0),
    uncoveredTokens: uncovered.reduce<number>((total, value) => total + estimate(value), 0)
  };
}

/**
 * The newest batch with the fewest of its unseen, maskable results replaced
 * by their references (largest release first) that brings `excessTokens`
 * down; every one when even that is not enough, so the refusal names the
 * references-only floor. Null when no result can be replaced.
 */
function newestBatchAsReferences(request: ProviderRunRequest, bridge: ProviderToolBridge,
  observations: readonly ContextObservation[] | undefined, transcript: ToolTranscriptReduction, excessTokens: number
): Readonly<{ references: number; releasedTokens: number; request: ProviderRunRequest }> | null {
  const estimate = contextTokenEstimator(request);
  const original = request.providerToolMessages ?? [];
  const newest = new Set<number>();
  for (const unit of transcript.units) {
    if (!unit.settled || unit.callIds.length === 0 || transcript.older.includes(unit)) continue;
    for (let index = unit.start; index < unit.end; index += 1) newest.add(index);
  }
  const candidates = locatedResults(original, observationIndex(observations)).flatMap((located) =>
    newest.has(located.index) && !located.masked && located.observation?.descriptor.maskable &&
      located.observation.descriptor.source !== "knowledge"
      ? [{ index: located.index, replacement: maskResult(bridge, located.observation) }] : [])
    .map((candidate) => ({ ...candidate, saved: estimate(original[candidate.index]) - estimate(candidate.replacement) }))
    .filter((candidate) => candidate.saved > 0)
    .sort((left, right) => right.saved - left.saved || left.index - right.index);
  if (candidates.length === 0) return null;
  const replacements = new Map<number, unknown>();
  let saved = 0;
  for (const candidate of candidates) {
    if (saved >= excessTokens) break;
    replacements.set(candidate.index, candidate.replacement);
    saved += candidate.saved;
  }
  const messages = original.map((value, index) => replacements.has(index) ? replacements.get(index) : value);
  return { references: replacements.size, releasedTokens: Math.max(0, estimate(original) - estimate(messages)),
    request: { ...request, providerToolMessages: messages } };
}

/** What the irreducible minimum consists of, for a truthful refusal. */
export type ContextOverflow = Readonly<{
  /** Prompt, pins, current input, tools, attachment minimum and any applied notes. */
  fixedTokens: number;
  /** The newest tool batch plus transcript items that must stay exact. */
  transcriptTokens: number;
  /** An applied summary note is part of `fixedTokens`. */
  notes: boolean;
}>;

export type ContextCompactionPlan = Readonly<{
  measurement: ContextPlanMeasurement;
  request: ProviderRunRequest;
  /** Present only when covered history left the projection. */
  historyTrim?: Readonly<{ droppedMessages: number; droppedTokens: number }>;
  /** Present with `irreducible_overflow` from the minimum. */
  overflow?: ContextOverflow;
}>;

/**
 * Plans one request under its conversation policy. Nothing leaves the
 * request and no result is masked until notes this run committed cover it:
 *
 * 1. At or below the trigger share the request is returned unchanged.
 * 2. Above it, covered material is released oldest first until the estimate
 *    reaches the target share: maskable results of covered older units are
 *    replaced by their reader reference, then covered older units leave whole.
 * 3. Above the target, uncovered reducible material (prior messages older
 *    than the exact tail plus noteable older units) larger than the minimum
 *    release share asks for a headroom summary; over the budget any uncovered
 *    history or noteable older unit asks for one. Uncovered material is never
 *    masked or removed here: the consumer commits notes and plans again.
 * 4. Over the budget with nothing uncovered, covered prior turns leave whole;
 *    otherwise the request is irreducible overflow.
 *
 * Only complete, persisted observation result envelopes are ever masked; an
 * unknown shape stays inline. `observations` are the server-minted
 * descriptors of this run's settled calls; without them only
 * `read_tool_result` responses are recognized, so a result body can never
 * introduce a handle into masking, checkpoints or summaries. Requests without
 * the policy (Agent, standalone document guards) and unknown windows are
 * measured only: nothing is masked, summarized or trimmed.
 */
export function planContextCompaction(input: Readonly<{
  assembledTokens?: number | null;
  budgetTokens?: number | null;
  bridge?: ProviderToolBridge;
  observations?: readonly ContextObservation[];
  request: ProviderRunRequest;
}>): ContextCompactionPlan {
  const request = input.request;
  const estimate = contextTokenEstimator(request);
  const budgetTokens = typeof input.budgetTokens === "number" && Number.isFinite(input.budgetTokens)
    ? input.budgetTokens : null;
  const original = request.providerToolMessages ?? [];
  const providerMessageTokens = estimate(original);
  const beforeTokens = input.assembledTokens === undefined || input.assembledTokens === null
    ? providerMessageTokens
    : Math.max(providerMessageTokens, Math.ceil(input.assembledTokens));

  let planned = request;
  let afterTokens = beforeTokens;
  let maskedBatches = 0;
  let maskedObservations = 0;
  const result = (outcome: ContextPlanMeasurement["outcome"], extra: Partial<Pick<ContextCompactionPlan,
    "historyTrim" | "overflow">> & { afterTokens?: number; request?: ProviderRunRequest } = {}): ContextCompactionPlan => ({
    measurement: measurement({
      afterTokens: extra.afterTokens ?? afterTokens,
      beforeTokens,
      budgetTokens,
      maskedBatches,
      maskedObservations,
      outcome
    }),
    request: extra.request ?? planned,
    ...(extra.historyTrim ? { historyTrim: extra.historyTrim } : {}),
    ...(extra.overflow ? { overflow: extra.overflow } : {})
  });

  if (request.agent || request.contextCompactionPolicy?.mode !== "hybrid" || budgetTokens === null) {
    // Measurement only. The fit check owns any refusal; it never trims.
    return result(budgetTokens !== null && beforeTokens > budgetTokens ? "irreducible_overflow" : "already_fits");
  }

  const { history, minimumTokens, retainedTranscriptTokens, summaryTokens, transcript } = reductionFloor({
    beforeTokens, budgetTokens, estimate, observations: input.observations, providerMessageTokens, request });
  const overflow = (): ContextOverflow => ({
    fixedTokens: Math.max(0, minimumTokens - retainedTranscriptTokens),
    notes: summaryTokens > 0,
    transcriptTokens: retainedTranscriptTokens
  });
  // A mask is a promise of recall: the reader must be callable in this
  // round. Knowledge evidence is never masked, even under a historical
  // descriptor, and an existing reference cannot shrink further.
  const maskingAvailable = request.toolObservationVersion === 1 && input.bridge !== undefined &&
    request.modelCapabilities.toolCalling === true && request.toolChoice !== "none" &&
    request.tools?.some(tool => tool.name === READ_TOOL_RESULT_NAME && tool.capability === "session") === true &&
    input.bridge.supportsToolCalling({ modelId: request.modelId, provider: request.provider });
  if (minimumTokens > budgetTokens) {
    // The newest batch has never reached the model, so its whole results and
    // previews may still arrive as their references (nothing it has seen
    // leaves). Only a minimum those references cannot bring within the
    // budget is irreducible.
    const degraded = maskingAvailable
      ? newestBatchAsReferences(request, input.bridge!, input.observations, transcript, minimumTokens - budgetTokens) : null;
    if (!degraded) return result("irreducible_overflow", { overflow: overflow() });
    const plan = planContextCompaction({ ...input, assembledTokens: beforeTokens - degraded.releasedTokens, request: degraded.request });
    return { ...plan, measurement: plan.measurement.outcome === "irreducible_overflow" ? plan.measurement : {
      ...plan.measurement,
      beforeTokens,
      maskedBatches: plan.measurement.maskedBatches + 1,
      maskedObservations: plan.measurement.maskedObservations + degraded.references,
      outcome: plan.measurement.outcome === "already_fits" ? "masking_applied" : plan.measurement.outcome
    } };
  }
  if (beforeTokens <= budgetTokens * CONTEXT_COMPACTION_LIMITS.triggerRatio) return result("already_fits");

  const targetTokens = Math.floor(budgetTokens * CONTEXT_COMPACTION_LIMITS.targetRatio);
  const coveredOlder = transcript.older.filter((unit) => transcript.covered.has(unit));
  // (a) Covered older results are replaced by their reader reference.
  const maskedByIndex = new Map<number, LocatedObservation>();
  let maskedGroups: LocatedResult[][] = [];
  if (maskingAvailable && coveredOlder.length > 0) {
    const coveredIndexes = new Set<number>();
    for (const unit of coveredOlder) for (let index = unit.start; index < unit.end; index += 1) coveredIndexes.add(index);
    const results = locatedResults(original, observationIndex(input.observations));
    const groups = resultGroups(results);
    const retained = new Set((groups.at(-CONTEXT_COMPACTION_LIMITS.recentBatches) ?? []).map(candidate => candidate.index));
    const candidates = results.filter(candidate => coveredIndexes.has(candidate.index) &&
      candidate.observation?.descriptor.maskable && candidate.observation.descriptor.source !== "knowledge" &&
      !candidate.masked && !retained.has(candidate.index));
    const byIndex = maskedByIndex;
    const replacements = new Map<number, unknown>();
    let released = 0;
    for (const candidate of candidates) {
      if (afterTokens - released <= targetTokens) break;
      const replacement = maskResult(input.bridge!, candidate.observation!);
      const saved = estimate(original[candidate.index]) - estimate(replacement);
      if (saved <= 0) continue;
      byIndex.set(candidate.index, candidate.observation!);
      replacements.set(candidate.index, replacement);
      released += saved;
    }
    if (replacements.size > 0) {
      const masked = original.map((value, index) => replacements.has(index) ? replacements.get(index) : value);
      const maskedTokens = Math.max(0, beforeTokens - providerMessageTokens) + estimate(masked);
      if (maskedTokens < beforeTokens) {
        planned = { ...request, providerToolMessages: masked };
        afterTokens = maskedTokens;
        maskedGroups = groups;
      } else byIndex.clear();
    }
  }
  // (b) Covered older units leave whole, oldest first. Masking replaces items
  // one for one, so the unit boundaries still hold.
  if (afterTokens > targetTokens && coveredOlder.length > 0) {
    const dropped = trimCoveredTranscript(planned, coveredOlder, afterTokens - targetTokens);
    afterTokens -= dropped.droppedTokens;
    planned = dropped.request;
    for (const unit of dropped.dropped) for (let index = unit.start; index < unit.end; index += 1) maskedByIndex.delete(index);
  }
  // Only references still in the request count as masked.
  maskedObservations = maskedByIndex.size;
  maskedBatches = maskedGroups.filter(group => group.some(candidate => maskedByIndex.has(candidate.index))).length;
  const settled = (): ContextPlanMeasurement["outcome"] => maskedObservations > 0 ? "masking_applied" : "already_fits";
  const uncoveredUnits = transcript.older.filter((unit) => transcript.noteable.has(unit) && !transcript.covered.has(unit));
  if (afterTokens > budgetTokens) {
    if (history.uncovered.length > 0 || uncoveredUnits.length > 0) return result("needs_summary");
    // Nothing uncovered remains: covered turns leave; notes already stand for them.
    const trimmed = trimCoveredHistory(planned, history, afterTokens - budgetTokens);
    const tokens = afterTokens - trimmed.droppedTokens;
    if (tokens > budgetTokens) return result("irreducible_overflow", { overflow: overflow() });
    return result(settled(), {
      afterTokens: tokens,
      ...(trimmed.droppedMessages > 0
        ? { historyTrim: { droppedMessages: trimmed.droppedMessages, droppedTokens: trimmed.droppedTokens } } : {}),
      request: trimmed.request
    });
  }
  // A fitting request above the target buys headroom for later rounds only
  // when enough uncovered material could leave once covered; it never turns
  // into overflow.
  const olderTokens = history.older.reduce((total, message) => total + estimate(message.content), 0) +
    (uncoveredUnits.length > 0 ? estimate(uncoveredUnits.flatMap((unit) => original.slice(unit.start, unit.end))) : 0);
  const headroom = afterTokens > targetTokens &&
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

/** Distinct handles ordered by their newest occurrence, oldest first; a cap
 * keeps the newest `references`, so the latest results are never the ones
 * left out. */
function newestHandles(handles: Iterable<string>): readonly string[] {
  const ordered = new Set<string>();
  for (const handle of handles) {
    ordered.delete(handle);
    ordered.add(handle);
  }
  return [...ordered].slice(-CONTEXT_COMPACTION_LIMITS.references);
}

export function observationHandlesInProviderMessages(
  messages: readonly unknown[],
  observations?: readonly ContextObservation[]
): readonly string[] {
  return newestHandles(recognizedObservations(messages, observations).map((candidate) => candidate.descriptor.handle));
}

/** Handles of results currently replaced by their reader reference: the
 * provider-facing transcript no longer carries their content. */
export function maskedObservationHandlesInProviderMessages(
  messages: readonly unknown[],
  observations?: readonly ContextObservation[]
): readonly string[] {
  return newestHandles(locatedResults(messages, observationIndex(observations)).flatMap((located) =>
    located.masked && located.observation ? [located.observation.descriptor.handle] : []));
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

/**
 * The one bounded rebuild a provider context rejection allows. The provider
 * counted `promptTokens` real tokens for a request estimated at
 * `requestTokens`; scaling by that ratio lets the reported prompt fit under
 * `reportedBudgetTokens` (its stated maximum after the output reservation and
 * the existing safety margin). Without both counts, or when they would not
 * shrink the request, the recorded `rejectionRebuildRatio` applies instead.
 * The budget stays below the rejected estimate and the admitted budget, so
 * the re-planned request is smaller or refused locally, never resent as is.
 */
export function contextRejectionRebuild(input: Readonly<{
  /** The budget the rejected request was planned under. */
  budgetTokens: number;
  promptTokens?: number;
  reportedBudgetTokens?: number;
  /** The rejected request's estimate as dispatched. */
  requestTokens: number;
  round: number;
}>): ContextRejectionRebuild | null {
  const count = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0;
  if (!Number.isSafeInteger(input.round) || input.round < 1 || !count(input.budgetTokens) ||
    !count(input.requestTokens) || input.requestTokens === 0) return null;
  const scaled = count(input.promptTokens) && input.promptTokens! > 0 && count(input.reportedBudgetTokens)
    ? Math.floor(input.reportedBudgetTokens! * input.requestTokens / input.promptTokens!) : null;
  const tightened = scaled !== null && scaled < input.requestTokens ? scaled
    : Math.floor(input.requestTokens * CONTEXT_COMPACTION_LIMITS.rejectionRebuildRatio);
  return { version: 1, round: input.round, budgetTokens: Math.min(tightened, input.budgetTokens) };
}
