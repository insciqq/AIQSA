import { createHash } from "node:crypto";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { TOOL_OBSERVATION_LIMITS, type ToolObservationDescriptor } from "../toolObservations/contract";
import type { ProviderConversationMessage, NormalizedRunRequest } from "../providers/types";
import type {
  ContextCompactionCheckpoint,
  ContextPlanMeasurement,
  ContextPlanOutcome,
  ContextSummary,
  ContextSummaryAttempt,
  ContextSummaryReuse,
  ConversationContextPolicy
} from "../../contracts/contextCompaction";
export type {
  ContextCompactionCheckpoint,
  ContextPlanMeasurement,
  ContextPlanOutcome,
  ContextSummaryReuse,
  ConversationContextPolicy
} from "../../contracts/contextCompaction";

export const CONTEXT_COMPACTION_LIMITS = Object.freeze({
  triggerRatio: 0.75,
  targetRatio: 0.5,
  recentBatches: 1,
  /** Ceiling on exact prior messages a committed summary keeps verbatim. */
  summaryRecentMessages: 4,
  /** Share of the answer budget that exact tail may occupy; larger recent
   * messages are summarized instead of kept. */
  summaryTailRatio: 0.2,
  /** A headroom summary (for a request that already fits) is bought only when
   * the history older than that tail exceeds this share of the budget: less
   * cannot release meaningful room once replaced by notes. */
  summaryMinimumReleaseRatio: 0.1,
  references: TOOL_OBSERVATION_LIMITS.runCount,
  metadataBytes: 512 * 1024,
  /** Paid summary calls (chunks, reductions and repairs) for one source
   * digest, counted from durable receipts so a restart cannot reset it. */
  summaryCalls: 16,
  /** Estimated calls one summary plan may use; the rest of `summaryCalls`
   * covers repairs. A longer source is summarized from its newest span. */
  summaryPlannedCalls: 12,
  /** Receipts retained in the checkpoint; never fewer than `summaryCalls`. */
  summaryReceipts: 24,
  summaryNotesBytes: 64 * 1024,
  summarySourceRefs: 512,
  /** Newest answers of a branch whose checkpoints preparation may consider
   * for carried notes. */
  reuseCandidateAnswers: 64
});

const CONTEXT_SUMMARY_MESSAGE_PREFIX = "__context-summary-";

/** Marks a summary whose retained-source handles did not all fit
 * `summarySourceRefs`. Its notes may rest on an original its refs no longer
 * name, so a later availability recheck could miss one: the summary serves
 * only the run that bought it (whose recheck covered every referenced handle)
 * and is never carried to a later turn, which takes a fresh bounded summary. */
export const CONTEXT_SUMMARY_REFS_INCOMPLETE = "ctxrefs1_incomplete";

/** Settlement code of a summary claim that never reached its provider
 * request: recovery found it unsettled without a `dispatched` mark. */
export const CONTEXT_SUMMARY_NOT_DISPATCHED = "context_compaction_not_dispatched";

export function contextSummaryRefsComplete(summary: Pick<ContextSummary, "sourceRefs">): boolean {
  return !summary.sourceRefs.includes(CONTEXT_SUMMARY_REFS_INCOMPLETE);
}

export function contextSummaryMessageId(summary: Pick<ContextSummary, "id">): string {
  return `${CONTEXT_SUMMARY_MESSAGE_PREFIX}${summary.id}`;
}

export function isContextSummaryMessage(message: Pick<ProviderConversationMessage, "id">): boolean {
  return message.id.startsWith(CONTEXT_SUMMARY_MESSAGE_PREFIX);
}

/** The exact prior messages a summary keeps: the newest contiguous suffix
 * within both the message ceiling and the tail's token share. The planner and
 * the summarizer use this one rule, so "older than the tail" means the same
 * history in both. An unknown budget keeps only the message ceiling. */
export function contextSummaryTail(
  prior: readonly ProviderConversationMessage[],
  budgetTokens: number | null
): readonly ProviderConversationMessage[] {
  const limit = budgetTokens === null ? Infinity : Math.floor(budgetTokens * CONTEXT_COMPACTION_LIMITS.summaryTailRatio);
  let used = 0;
  let start = prior.length;
  while (start > 0 && prior.length - start < CONTEXT_COMPACTION_LIMITS.summaryRecentMessages) {
    const candidate = prior[start - 1]!;
    if (isContextSummaryMessage(candidate)) break;
    const tokens = estimateApproxTokens(candidate.content);
    if (used + tokens > limit) break;
    used += tokens;
    start -= 1;
  }
  return prior.slice(start);
}

export type ContextObservation = Readonly<{
  callId: string;
  name: string;
  status: "complete" | "error";
  observation: ToolObservationDescriptor;
}>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(",") === keys.sort().join(",");
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const index = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** The JSON value with object keys in sorted order at every depth. `jsonb`
 * reorders keys on storage, so every digest, id or comparison of a value that
 * may have round-tripped through PostgreSQL uses this form. `toJSON` values
 * (dates) and dropped members (undefined, functions) serialize as in JSON. */
export function canonicalJson(value: unknown): unknown {
  const plain = value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function"
    ? (value as { toJSON(): unknown }).toJSON() : value;
  if (Array.isArray(plain)) return plain.map(canonicalJson);
  if (plain !== null && typeof plain === "object") {
    return Object.fromEntries(Object.keys(plain).sort()
      .map((key) => [key, canonicalJson((plain as Record<string, unknown>)[key])]));
  }
  return plain;
}

/** Canonical (sorted-key) serialization, stable across a jsonb round trip. */
export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalJson(value)) ?? "null";
}

export function contextDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonText(value)).digest("hex");
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

function decodeContextSummaryReuse(value: unknown): ContextSummaryReuse | null {
  return record(value) && exactKeys(value, ["coveredMessageId", "runId", "summary"]) &&
    id(value.runId) && id(value.coveredMessageId) && decodeContextSummary(value.summary)
    ? value as ContextSummaryReuse : null;
}

export function decodeConversationContextPolicy(value: unknown): ConversationContextPolicy | null {
  if (!record(value) || !exactKeys(value, Object.hasOwn(value, "reuse") ? ["version", "mode", "source", "reuse"] : ["version", "mode", "source"]) ||
    value.version !== 1 ||
    value.mode !== "legacy_compatible" && value.mode !== "hybrid" || !record(value.source) ||
    !exactKeys(value.source, ["leafMessageId", "digest", "messageCount"]) ||
    value.source.leafMessageId !== null && !id(value.source.leafMessageId) ||
    !index(value.source.messageCount) || typeof value.source.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.source.digest) ||
    value.reuse !== undefined && (value.mode !== "hybrid" || !decodeContextSummaryReuse(value.reuse))) return null;
  return value as ConversationContextPolicy;
}

/**
 * The prior messages an applied summary stands for. Notes bought in this run
 * cover every prior message of their request. Notes carried from an earlier
 * turn's checkpoint cover the branch only through their frozen boundary; later
 * messages stay uncovered until a new summary includes them.
 */
export function contextSummaryCoverage(
  request: Pick<NormalizedRunRequest, "contextCompactionPolicy">,
  summary: Pick<ContextSummary, "id">,
  prior: readonly ProviderConversationMessage[]
): Readonly<{ covered: readonly ProviderConversationMessage[]; uncovered: readonly ProviderConversationMessage[] }> {
  const reuse = request.contextCompactionPolicy?.reuse;
  if (reuse?.summary.id !== summary.id) return { covered: prior, uncovered: [] };
  const boundary = prior.findIndex((message) => message.id === reuse.coveredMessageId);
  return { covered: prior.slice(0, boundary + 1), uncovered: prior.slice(boundary + 1) };
}

/** A settled run's compaction checkpoint whose answer lies on the branch. */
export type BranchContextCheckpoint = Readonly<{
  assistantMessageId: string;
  compaction: ContextCompactionCheckpoint;
  /** The accepted policy of that run: it names notes the run itself carried. */
  policy: ConversationContextPolicy | null;
  runId: string;
  userId: string;
  userMessageId: string;
}>;

/**
 * Carried-notes candidates, newest answer first. A checkpoint qualifies only
 * when it belongs to the current user, holds hybrid notes of the current
 * format, and its answer and coverage boundary are prior messages of this
 * branch in that order, so edits, forks and regeneration never see sibling
 * notes. A run accepted without the hybrid policy (Off, legacy or Knowledge)
 * never supplies notes. Notes a run bought cover its branch through its own
 * user message; notes it carried keep their frozen boundary. Only the notes
 * travel: provider continuations, response ids and receipts of that run
 * never do.
 */
export function contextSummaryReuseCandidates(input: Readonly<{
  checkpoints: readonly BranchContextCheckpoint[];
  priorMessageIds: readonly string[];
  userId: string;
}>): ContextSummaryReuse[] {
  const position = new Map(input.priorMessageIds.map((messageId, order) => [messageId, order]));
  return [...input.checkpoints]
    .filter((candidate) => position.has(candidate.assistantMessageId))
    .sort((left, right) => position.get(right.assistantMessageId)! - position.get(left.assistantMessageId)!)
    .flatMap((candidate): ContextSummaryReuse[] => {
      const { compaction, policy } = candidate;
      const summary = compaction.summary;
      if (!summary || policy?.mode !== "hybrid" || candidate.userId !== input.userId || compaction.version !== 1 ||
        compaction.policyRevision !== "hybrid-v1" || compaction.runId !== candidate.runId ||
        compaction.ownerId !== candidate.userId || !decodeContextSummary(summary) ||
        !contextSummaryRefsComplete(summary)) return [];
      const carried = policy?.reuse?.summary.id === summary.id ? policy.reuse : null;
      const bought = compaction.summaryAttempts?.some((attempt) =>
        attempt.state === "committed" && attempt.sourceDigest === summary.sourceDigest) === true;
      const coveredMessageId = carried?.coveredMessageId ?? (bought ? candidate.userMessageId : null);
      const boundary = coveredMessageId === null ? undefined : position.get(coveredMessageId);
      if (boundary === undefined || boundary >= position.get(candidate.assistantMessageId)!) return [];
      return [{ coveredMessageId: coveredMessageId!, runId: candidate.runId, summary }];
    });
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
    !index(value.attempt) || value.attempt < 1 || value.attempt > CONTEXT_COMPACTION_LIMITS.summaryCalls ||
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
      summaryAttempts: input.summaryAttempts.slice(-CONTEXT_COMPACTION_LIMITS.summaryReceipts)
    } : {})
  };
}
