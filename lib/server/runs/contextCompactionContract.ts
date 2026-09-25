import { createHash } from "node:crypto";
import { decodeToolObservationDescriptor, TOOL_OBSERVATION_LIMITS, type ToolObservationDescriptor } from "../toolObservations/contract";
import type { ProviderConversationMessage, NormalizedRunRequest } from "../providers/types";
import type {
  ContextCompactionCheckpoint,
  ContextPlanMeasurement,
  ContextPlanOutcome,
  ContextSummary,
  ContextSummaryAttempt,
  ConversationContextPolicy
} from "../../contracts/contextCompaction";
export type { ContextCompactionCheckpoint, ContextPlanMeasurement, ContextPlanOutcome, ConversationContextPolicy } from "../../contracts/contextCompaction";

export const CONTEXT_COMPACTION_LIMITS = Object.freeze({
  triggerRatio: 0.75,
  targetRatio: 0.5,
  recentBatches: 1,
  references: TOOL_OBSERVATION_LIMITS.runCount,
  metadataBytes: 512 * 1024,
  historyPageMessages: 32,
  historyProjectionBytes: 8 * 1024 * 1024,
  summaryAttempts: 2,
  summaryInputBytes: 512 * 1024,
  summaryNotesBytes: 64 * 1024,
  summarySourceRefs: 512
});

export type ContextObservation = Readonly<{
  callId: string;
  name: string;
  status: "complete" | "error";
  observation: ToolObservationDescriptor;
}>;

/** Indices address complete result envelopes, never text inside provider data.
 * Metadata is minted from canonical settled results, not parsed model output. */
export type ContextObservationBatch = Readonly<{
  outputStart: number;
  results: readonly ContextObservation[];
  masked: boolean;
}>;

export type ContextTranscript = Readonly<{
  version: 1;
  batches: readonly ContextObservationBatch[];
  pending: Readonly<{ callIds: readonly string[] }> | null;
}>;


const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(",") === keys.sort().join(",");
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const index = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function contextDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function conversationContextPolicy(input: {
  leafMessageId: string | null;
  messages: readonly ProviderConversationMessage[];
  mode?: ConversationContextPolicy["mode"];
}): ConversationContextPolicy {
  return { version: 1, mode: input.mode ?? "legacy_compatible", source: {
    leafMessageId: input.leafMessageId,
    messageCount: input.messages.length,
    digest: contextDigest(input.messages)
  } };
}

export function decodeConversationContextPolicy(value: unknown): ConversationContextPolicy | null {
  if (!record(value) || !exactKeys(value, ["version", "mode", "source"]) || value.version !== 1 ||
    value.mode !== "legacy_compatible" && value.mode !== "hybrid" || !record(value.source) ||
    !exactKeys(value.source, ["leafMessageId", "digest", "messageCount"]) ||
    value.source.leafMessageId !== null && !id(value.source.leafMessageId) ||
    !index(value.source.messageCount) || typeof value.source.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.source.digest)) return null;
  return value as ConversationContextPolicy;
}

const summaryAttemptStates = new Set([
  "claim", "dispatched", "settled", "committed", "invalid", "unknown", "failed"
]);

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function summaryUsage(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["inputTokens", "outputTokens", "totalTokens"])) return false;
  return ["inputTokens", "outputTokens", "totalTokens"].every((key) =>
    value[key] === null || Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

export function decodeContextSummary(value: unknown): ContextSummary | null {
  if (!record(value) || !exactKeys(value, ["formatVersion", "id", "notes", "sourceDigest", "sourceRefs"]) ||
    value.formatVersion !== 1 || !id(value.id) || !value.id.startsWith("cs1_") ||
    typeof value.notes !== "string" || value.notes.length === 0 ||
    Buffer.byteLength(value.notes, "utf8") > CONTEXT_COMPACTION_LIMITS.summaryNotesBytes ||
    !digest(value.sourceDigest) || !Array.isArray(value.sourceRefs) ||
    value.sourceRefs.length > CONTEXT_COMPACTION_LIMITS.summarySourceRefs ||
    value.sourceRefs.some((entry) => !id(entry))) return null;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CONTEXT_COMPACTION_LIMITS.metadataBytes) return null;
  return value as ContextSummary;
}

export function decodeContextSummaryAttempt(value: unknown): ContextSummaryAttempt | null {
  if (!record(value) ||
    !["attempt", "bindingDigest", "errorCode", "id", "state", "sourceDigest", "usage"].every((key) =>
      key === "errorCode" || key === "usage" || Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !["attempt", "bindingDigest", "errorCode", "id", "state", "sourceDigest", "usage"].includes(key)) ||
    !index(value.attempt) || value.attempt < 1 || value.attempt > CONTEXT_COMPACTION_LIMITS.summaryAttempts ||
    !id(value.id) || !digest(value.bindingDigest) || !digest(value.sourceDigest) ||
    !summaryAttemptStates.has(String(value.state)) ||
    value.errorCode !== undefined && !id(value.errorCode) ||
    value.usage !== undefined && !summaryUsage(value.usage)) return null;
  return value as ContextSummaryAttempt;
}

export function summaryBindingDigest(request: NormalizedRunRequest): string {
  return contextDigest({ provider: request.provider, modelId: request.modelId,
    params: request.params, reasoningEffort: request.reasoningEffort ?? null });
}

export function decodeContextTranscript(value: unknown, messageCount: number): ContextTranscript | null {
  if (!record(value) || !exactKeys(value, ["version", "batches", "pending"]) || value.version !== 1 ||
    !Array.isArray(value.batches) || value.batches.length > CONTEXT_COMPACTION_LIMITS.references) return null;
  let end = 0;
  let count = 0;
  const calls = new Set<string>();
  for (const batch of value.batches) {
    if (!record(batch) || !exactKeys(batch, ["outputStart", "results", "masked"]) || !index(batch.outputStart) ||
      batch.outputStart < end || typeof batch.masked !== "boolean" || !Array.isArray(batch.results) || !batch.results.length) return null;
    end = batch.outputStart + batch.results.length;
    count += batch.results.length;
    if (end > messageCount || count > CONTEXT_COMPACTION_LIMITS.references) return null;
    for (const result of batch.results) {
      if (!record(result) || !exactKeys(result, ["callId", "name", "status", "observation"]) ||
        !id(result.callId) || calls.has(result.callId) || !id(result.name) ||
        result.status !== "complete" && result.status !== "error" || !decodeToolObservationDescriptor(result.observation)) return null;
      calls.add(result.callId);
    }
  }
  if (value.pending !== null && (!record(value.pending) || !exactKeys(value.pending, ["callIds"]) ||
    !Array.isArray(value.pending.callIds) || !value.pending.callIds.length || value.pending.callIds.length > 64 ||
    value.pending.callIds.some(callId => !id(callId) || calls.has(callId)) || new Set(value.pending.callIds).size !== value.pending.callIds.length)) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > CONTEXT_COMPACTION_LIMITS.metadataBytes) return null;
  return value as ContextTranscript;
}

/** Exact instruction bytes and current request stay outside lossy projections. */
export function contextPinsDigest(request: NormalizedRunRequest): string {
  return contextDigest({ prompt: request.prompt, personalContext: request.personalContext ?? null,
    internal: request.context?.messages.filter(message => message.purpose !== undefined) ?? [], content: request.content });
}

export function contextCompactionCheckpoint(input: Readonly<{
  ownerId: string;
  runId: string;
  request: NormalizedRunRequest;
  followupRevision?: number;
  followupTexts?: readonly string[];
  observationRefs?: readonly string[];
  recentTailCallIds?: readonly string[];
  measurement?: ContextPlanMeasurement;
  summary?: ContextSummary;
  summaryAttempts?: readonly ContextSummaryAttempt[];
}>): ContextCompactionCheckpoint {
  const source = input.request.context?.messages ?? [];
  return {
    branchId: input.request.contextCompactionPolicy?.source.leafMessageId ?? source.at(-1)?.id ?? input.request.chatId,
    followupDigest: contextDigest(input.followupTexts ?? []),
    followupRevision: input.followupRevision ?? 0,
    measurement: input.measurement ?? { afterTokens: 0, beforeTokens: 0, budgetTokens: null, legacyFallback: false,
      maskedBatches: 0, maskedObservations: 0, outcome: "already_fits", version: 1 },
    observationRefs: [...new Set(input.observationRefs ?? [])].slice(0, CONTEXT_COMPACTION_LIMITS.references),
    ownerId: input.ownerId,
    pinDigest: contextPinsDigest(input.request),
    policyRevision: input.request.contextCompactionPolicy?.mode === "hybrid" ? "hybrid-v1" : "legacy-compatible-v1",
    providerProjectionRevision: 1,
    recentTailCallIds: [...new Set(input.recentTailCallIds ?? [])].slice(-64),
    runId: input.runId,
    sourceDigest: input.request.contextCompactionPolicy?.source.digest ?? contextDigest(source),
    version: 1,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.summaryAttempts?.length ? {
      summaryAttempts: input.summaryAttempts.slice(-CONTEXT_COMPACTION_LIMITS.summaryAttempts)
    } : {})
  };
}
