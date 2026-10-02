import { createHash } from "node:crypto";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ToolObservationDescriptor } from "../toolObservations/contract";
import { toolHistoryTurnMessageId } from "./toolHistoryContract";
import type { ProviderConversationMessage, NormalizedRunRequest } from "../providers/types";
import type {
  ContextCompactionCheckpoint,
  ContextPlanMeasurement,
  ContextPlanOutcome,
  ContextRejectionRebuild,
  ContextSummary,
  ContextSummaryAttempt,
  ContextSummaryReuse,
  ConversationContextPolicy
} from "../../contracts/contextCompaction";
export type {
  ContextCompactionCheckpoint,
  ContextPlanMeasurement,
  ContextPlanOutcome,
  ContextRejectionRebuild,
  ContextSummaryReuse,
  ConversationContextPolicy
} from "../../contracts/contextCompaction";

export const CONTEXT_COMPACTION_LIMITS = Object.freeze({
  /** Share of the budget above which a fitting request buys headroom; the
   * planner spec allows 70–80 %, and 80 % keeps unnecessary summaries rarer. */
  triggerRatio: 0.8,
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
  /** Handles one committed summary may keep; never a store admission bound. */
  references: 512,
  metadataBytes: 512 * 1024,
  /** Paid summary calls (chunks, reductions and repairs) for one source
   * digest, counted from durable receipts so a restart cannot reset it. */
  summaryCalls: 16,
  /** Estimated calls one summary pass may use; the rest of `summaryCalls`
   * covers repairs. A longer source is covered by further oldest-first passes. */
  summaryPlannedCalls: 12,
  /** Summary passes one request may buy before it is dispatched with the
   * coverage reached (when it fits) or refused (when it does not). */
  summaryPasses: 4,
  /** Receipts retained in the checkpoint; never fewer than `summaryCalls`. */
  summaryReceipts: 24,
  summaryNotesBytes: 64 * 1024,
  /** Floor of the final notes allowance, however little history a summary
   * replaces: room for the conversation's rules, corrections and open work. */
  summaryMinimumNotesBytes: 4 * 1024,
  summarySourceRefs: 512,
  /** Newest answers of a branch whose checkpoints preparation may consider
   * for carried notes. */
  reuseCandidateAnswers: 64,
  /** Share of a rejected request's estimate a context-rejection rebuild keeps
   * when the provider stated no usable prompt and maximum token counts. */
  rejectionRebuildRatio: 0.75
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
 * within both the message ceiling and the tail's token share, measured with the
 * budget's own estimate. The planner and the summarizer use this one rule, so
 * "older than the tail" means the same history in both. An unknown budget
 * keeps only the message ceiling. */
export function contextSummaryTail(
  prior: readonly ProviderConversationMessage[],
  budgetTokens: number | null,
  estimate: (value: unknown) => number = estimateApproxTokens
): readonly ProviderConversationMessage[] {
  const limit = budgetTokens === null ? Infinity : Math.floor(budgetTokens * CONTEXT_COMPACTION_LIMITS.summaryTailRatio);
  let used = 0;
  let start = prior.length;
  while (start > 0 && prior.length - start < CONTEXT_COMPACTION_LIMITS.summaryRecentMessages) {
    const candidate = prior[start - 1]!;
    if (isContextSummaryMessage(candidate)) break;
    const tokens = estimate(candidate.content);
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

/** The one conversation policy current admission freezes for a non-Agent
 * run. `legacy_compatible` is only ever decoded, never created. */
export function conversationContextPolicy(input: {
  leafMessageId: string | null;
  messages: readonly ProviderConversationMessage[];
}): ConversationContextPolicy {
  return { version: 1, mode: "hybrid", source: {
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

/** The retired-policy outcome: a non-Agent run accepted before its policy was
 * frozen (absent) or under the retired `legacy_compatible` mode or checkpoint
 * revision. It ends before any budget, provider or tool step. */
export const CONTEXT_COMPACTION_POLICY_RETIRED = Object.freeze({
  code: "context_compaction_policy_retired",
  message: "This answer was interrupted by an application update. Regenerate to try again."
} as const);

/** The one retired-policy rule. Agent runs never carry a policy: Codex owns
 * their context. */
export function contextCompactionPolicyRetired(
  request: Readonly<{ agent?: unknown; contextCompactionPolicy?: Readonly<{ mode: string }> }>,
  checkpoint?: Pick<ContextCompactionCheckpoint, "policyRevision"> | null
): boolean {
  if (request.agent !== undefined) return false;
  return request.contextCompactionPolicy?.mode !== "hybrid" || checkpoint?.policyRevision === "legacy-compatible-v1";
}

const MESSAGE_COVERAGE_PREFIX = "ctxm1_";
const UNIT_COVERAGE_PREFIX = "ctxu1_";

/** A summary ref naming one covered tool-transcript unit (see the planner's
 * `unitCoverageRef`). */
export function isUnitCoverageRef(ref: string): boolean {
  return ref.startsWith(UNIT_COVERAGE_PREFIX);
}

/** Summary ref naming the newest prior message its source contained: the
 * notes stand for the branch prefix through that message. */
export function messageCoverageRef(messageId: string): string {
  return `${MESSAGE_COVERAGE_PREFIX}${messageId}`;
}

export function isMessageCoverageRef(ref: string): boolean {
  return ref.startsWith(MESSAGE_COVERAGE_PREFIX);
}

/**
 * The history boundary of notes: the newest prior message they read; null
 * when notes with coverage refs read no prior message (a pass over tool units
 * only, for example on a chat's first turn); undefined for notes bought before
 * coverage refs existed, which stand for every prior message of their request.
 */
export function summaryMessageBoundary(summary: Pick<ContextSummary, "sourceRefs">): string | null | undefined {
  const ref = summary.sourceRefs.find(isMessageCoverageRef);
  if (ref !== undefined) return ref.slice(MESSAGE_COVERAGE_PREFIX.length);
  return summary.sourceRefs.some(isUnitCoverageRef) ? null : undefined;
}

/**
 * The prior messages an applied summary stands for: the branch prefix through
 * its boundary. Notes carried from an earlier turn's checkpoint keep their
 * frozen boundary; notes bought in this run name theirs (`ctxm1_`), and notes
 * bought before that ref existed cover every prior message of their request.
 * Messages after the boundary stay uncovered until a new pass includes them.
 * A boundary no longer in `prior` (it left as covered history) leaves every
 * remaining message uncovered: only covered messages ever leave first.
 */
export function contextSummaryCoverage(
  request: Pick<NormalizedRunRequest, "contextCompactionPolicy">,
  summary: Pick<ContextSummary, "id" | "sourceRefs">,
  prior: readonly ProviderConversationMessage[]
): Readonly<{ covered: readonly ProviderConversationMessage[]; uncovered: readonly ProviderConversationMessage[] }> {
  const reuse = request.contextCompactionPolicy?.reuse;
  const boundaryId = reuse?.summary.id === summary.id ? reuse.coveredMessageId : summaryMessageBoundary(summary);
  if (boundaryId === undefined) return { covered: prior, uncovered: [] };
  if (boundaryId === null) return { covered: [], uncovered: prior };
  const boundary = prior.findIndex((message) => message.id === boundaryId);
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
 * The branch as preparation sees it for carried notes: the message parent
 * chain of the accepted leaf, oldest first and whatever each message's status,
 * with the checkpoints of the newest answers on it. A failed answer is not part
 * of the provider context, yet it stays an ancestor of the next turn.
 */
export type BranchContextCheckpoints = Readonly<{
  ancestorMessageIds: readonly string[];
  checkpoints: readonly BranchContextCheckpoint[];
}>;

/**
 * Carried-notes candidates, newest answer first. A checkpoint qualifies only
 * when it belongs to the current user, holds hybrid notes of the current
 * format, and its answer and coverage boundary are prior messages of this
 * branch in that order, so edits, forks and regeneration never see sibling
 * notes. `priorMessageIds` is the branch ancestry, not the provider context:
 * an answer that failed after committing its notes stays a candidate. Runs
 * accepted under the retired legacy policy never supply notes. Notes a run
 * bought cover its branch through their `ctxm1_` boundary (notes with coverage
 * refs but no boundary cover nothing and are never carried; notes bought before
 * coverage refs existed: through the run's own user message); notes it carried
 * keep their frozen boundary. Only the notes travel: provider continuations,
 * response ids and receipts of that run never do.
 */
export function contextSummaryReuseCandidates(input: Readonly<{
  checkpoints: readonly BranchContextCheckpoint[];
  priorMessageIds: readonly string[];
  userId: string;
}>): ContextSummaryReuse[] {
  const ancestry = new Map(input.priorMessageIds.map((messageId, order) => [messageId, order]));
  // A tool-history record (provider-only) sits just before the answer of its
  // turn, so notes bounded by one cover up to that answer's position.
  const position = { has: (messageId: string) => at(messageId) !== undefined, get: (messageId: string) => at(messageId) };
  function at(messageId: string): number | undefined {
    const direct = ancestry.get(messageId);
    if (direct !== undefined) return direct;
    const turn = toolHistoryTurnMessageId(messageId);
    const answer = turn === null ? undefined : ancestry.get(turn);
    return answer === undefined ? undefined : answer - 0.5;
  }
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
      // Notes that read no prior message cover none and are never carried;
      // notes bought before coverage refs existed covered the run's own
      // user message.
      const own = bought ? summaryMessageBoundary(summary) : null;
      const coveredMessageId = carried?.coveredMessageId ?? (own === undefined ? candidate.userMessageId : own);
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

/** Old checkpoints omit the record; a present one must be exact. */
export function decodeContextRejectionRebuild(value: unknown): ContextRejectionRebuild | null {
  return record(value) && exactKeys(value, ["budgetTokens", "round", "version"]) && value.version === 1 &&
    Number.isSafeInteger(value.round) && Number(value.round) >= 1 && Number(value.round) <= 2_147_483_647 &&
    index(value.budgetTokens) ? value as ContextRejectionRebuild : null;
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
  /** A round request carries the run's rebuild record into every checkpoint. */
  request: NormalizedRunRequest & Readonly<{ contextCompactionRebuild?: ContextRejectionRebuild }>;
  followupRevision?: number;
  followupTexts?: readonly string[];
  observationRefs?: readonly string[];
  recentTailCallIds?: readonly string[];
  measurement?: ContextPlanMeasurement;
  rebuild?: ContextRejectionRebuild;
  summary?: ContextSummary;
  summaryAttempts?: readonly ContextSummaryAttempt[];
}>): ContextCompactionCheckpoint {
  const source = input.request.context?.messages ?? [];
  const rebuild = input.rebuild ?? input.request.contextCompactionRebuild;
  return {
    branchId: input.request.contextCompactionPolicy?.source.leafMessageId ?? source.at(-1)?.id ?? input.request.chatId,
    followupDigest: contextDigest(input.followupTexts ?? []),
    followupRevision: input.followupRevision ?? 0,
    measurement: input.measurement ?? { afterTokens: 0, beforeTokens: 0, budgetTokens: null, legacyFallback: false,
      maskedBatches: 0, maskedObservations: 0, outcome: "already_fits", version: 1 },
    observationRefs: [...new Set(input.observationRefs ?? [])].slice(0, CONTEXT_COMPACTION_LIMITS.references),
    ownerId: input.ownerId,
    pinDigest: contextPinsDigest(input.request),
    // `legacy-compatible-v1` is only ever decoded from historical checkpoints.
    policyRevision: "hybrid-v1",
    providerProjectionRevision: 1,
    recentTailCallIds: [...new Set(input.recentTailCallIds ?? [])].slice(-64),
    runId: input.runId,
    sourceDigest: input.request.contextCompactionPolicy?.source.digest ?? contextDigest(source),
    version: 1,
    ...(rebuild ? { rebuild } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.summaryAttempts?.length ? {
      summaryAttempts: input.summaryAttempts.slice(-CONTEXT_COMPACTION_LIMITS.summaryReceipts)
    } : {})
  };
}
