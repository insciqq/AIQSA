import type { MemoryJobDescriptor } from "../coordinator/types";
import { canonicalMemoryTimeZone } from "../../../domain/memory/temporal/calendar";
import { memorySha256 } from "../persistence/lexical";
import type { MemorySourceSnapshot } from "../sourceState";
import type { MemoryRecallChunkProjection } from "./chunking";
import type {
  MemoryContextualFallbackReason,
  MemoryRecallRoundProjection
} from "./rounds";
import type { MemoryQualificationLanguageBucket } from "./language";
import type { MemoryToolEventProjection } from "./toolEvents";

export const MEMORY_HISTORY_INDEX_PIPELINE_VERSION = "memory-history-incremental-v10";
export const MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION =
  "memory-history-rebuild-required-v5";
export const MEMORY_CHAT_DIGEST_PIPELINE_VERSION = "memory-chat-digest-v5";
export const MEMORY_HISTORY_INDEX_JOB_PREFIX = "index-history:";
const HISTORY_AUTO_HEAL_PREFIX = "heal-history:";
export const MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION = "v2";
export const MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);
export const MEMORY_CHAT_DIGEST_MAX_SOURCE_CHUNKS = 512;
export const MEMORY_CHAT_DIGEST_MAX_SOURCE_MESSAGES = 8_192;

const sha256Pattern = /^[a-f0-9]{64}$/u;

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/u.test(value);
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

export type MemoryHistoryIndexSourceIdentity = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  sourceHash: string;
  sourceRevision: number;
  userId: string;
}>;

export type MemoryHistoryPreparedChunk = Omit<
  MemoryRecallChunkProjection,
  "redactionState" | "safetyClass"
> & Readonly<{
  id: string;
  publicationState: "ACTIVE" | "SUPPRESSED";
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
}>;

export type MemoryHistoryPreparedRound = Omit<
  MemoryRecallRoundProjection,
  "redactionState" | "safetyClass"
> & Readonly<{
  publicationState: "ACTIVE" | "SUPPRESSED";
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
}>;

export type MemoryHistoryPreparedToolEvent = MemoryToolEventProjection & Readonly<{
  publicationState: "ACTIVE";
}>;

export type MemoryHistoryCheckpointMessage = Readonly<{
  createdAt: string;
  messageId: string;
  ordinal: number;
  sourceMessageUpdatedAt: string;
}>;

export type MemoryHistoryDigestPlan = Readonly<{
  anchorChunkId: string;
  contentHash: string;
  decisions: readonly string[];
  id: string;
  incrementalDepth: number;
  inputFingerprint: string;
  languageCode: string;
  occurredFrom: string;
  occurredTo: string;
  openLoops: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safeDigestText: string;
  rebuildPolicyVersion: string;
  sourceChunkIds: readonly string[];
  sourceFingerprint: string;
  sourceMessageIds: readonly string[];
  summary: string;
  topics: readonly string[];
  updateMode: "FULL_REBUILD" | "INCREMENTAL" | "REBOUND" | "UNCHANGED";
}>;

export type MemoryHistoryWorkCounters = Readonly<{
  chunksBuilt: number;
  chunksReplaced: number;
  chunksReused: number;
  contextualProviderRequests: number;
  contextualRoundsFallback: number;
  contextualRoundsGenerated: number;
  contextualFallbackReasonCounts?: Readonly<
    Partial<Record<MemoryContextualFallbackReason, number>>
  >;
  contextualLanguageCounts?: Readonly<{
    fallback?: Readonly<Partial<Record<MemoryQualificationLanguageBucket, number>>>;
    generated?: Readonly<Partial<Record<MemoryQualificationLanguageBucket, number>>>;
  }>;
  digestSegmentsProcessed: number;
  digestSourceChunksProcessed: number;
  messageContentRowsLoaded: number;
  messagesProjected: number;
  modelRunRowsLoaded: number;
  pathMetadataRowsRead: number;
  roundSegmentsBuilt: number;
  roundSegmentsReplaced: number;
  roundSegmentsReused: number;
  roundsBuilt: number;
  roundsReplaced: number;
  roundsReused: number;
  toolEventsBuilt: number;
}>;

export const EMPTY_MEMORY_HISTORY_WORK_COUNTERS: MemoryHistoryWorkCounters =
  Object.freeze({
    chunksBuilt: 0,
    chunksReplaced: 0,
    chunksReused: 0,
    contextualProviderRequests: 0,
    contextualRoundsFallback: 0,
    contextualRoundsGenerated: 0,
    digestSegmentsProcessed: 0,
    digestSourceChunksProcessed: 0,
    messageContentRowsLoaded: 0,
    messagesProjected: 0,
    modelRunRowsLoaded: 0,
    pathMetadataRowsRead: 0,
    roundSegmentsBuilt: 0,
    roundSegmentsReplaced: 0,
    roundSegmentsReused: 0,
    roundsBuilt: 0,
    roundsReplaced: 0,
    roundsReused: 0,
    toolEventsBuilt: 0
  });

export type MemoryHistoryIndexPlan = Readonly<{
  classificationPolicyVersion: string | null;
  checkpointMessages: readonly MemoryHistoryCheckpointMessage[];
  chunks: readonly MemoryHistoryPreparedChunk[];
  digest: MemoryHistoryDigestPlan | null;
  digestPolicyVersion: string | null;
  incremental: Readonly<{
    commonPathMessageCount: number;
    mode: "APPEND" | "DIVERGENCE" | "FULL_REBUILD" | "UNCHANGED";
    rebuildFromMessageOrdinal: number;
  }>;
  preparedResultHash: string;
  rebuiltChunkIds: readonly string[];
  rebuiltRoundIds: readonly string[];
  resultHash: string;
  reusedChunkIds: readonly string[];
  reusedRoundIds: readonly string[];
  rounds: readonly MemoryHistoryPreparedRound[];
  source: MemoryHistoryIndexSourceIdentity;
  suppressionIdentitySnapshot: string;
  timeZone: string;
  toolEvents: readonly MemoryHistoryPreparedToolEvent[];
  work: MemoryHistoryWorkCounters;
}>;

type FingerprintSource = Pick<
  MemorySourceSnapshot,
  | "activeLeafMessageId"
  | "id"
  | "memoryBranchGeneration"
  | "memorySourceRevision"
  | "sourceHash"
  | "userId"
>;

export function memoryHistoryIndexJobFingerprint(source: FingerprintSource): string {
  if (
    !source.activeLeafMessageId ||
    !validIdentity(source.activeLeafMessageId) ||
    !validIdentity(source.id) ||
    !validIdentity(source.userId) ||
    !validCounter(source.memoryBranchGeneration) ||
    !validCounter(source.memorySourceRevision) ||
    !sha256Pattern.test(source.sourceHash)
  ) {
    throw new Error("memory_history_index_source_invalid");
  }
  return `${MEMORY_HISTORY_INDEX_JOB_PREFIX}${memorySha256({
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    sourceHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    userId: source.userId
  })}`;
}

/** Each bounded repair owns new work; ordinary indexing keeps its stable key. */
export function memoryHistoryAutoHealJobFingerprint(
  source: FingerprintSource,
  attempt: number,
  utilityPolicyVersion?: number
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS.length) {
    throw new Error("memory_history_auto_heal_attempt_invalid");
  }
  if (utilityPolicyVersion !== undefined && (!validCounter(utilityPolicyVersion) || utilityPolicyVersion < 1)) {
    throw new Error("memory_history_auto_heal_policy_invalid");
  }
  // Accepted legacy attempts remain valid. A repaired generator or a deliberate
  // Memory role change admits a separate bounded cycle without rewriting them.
  const policy = utilityPolicyVersion === undefined ? ""
    : `${MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION}:${utilityPolicyVersion}:`;
  return `${HISTORY_AUTO_HEAL_PREFIX}${memoryHistoryIndexJobFingerprint(source).slice(MEMORY_HISTORY_INDEX_JOB_PREFIX.length)}:${policy}${attempt}`;
}

export function memoryHistoryIndexClaimIsValid(
  job: MemoryJobDescriptor
): job is MemoryJobDescriptor & MemoryHistoryIndexSourceIdentity {
  if (
    job.kind !== "INDEX_HISTORY" ||
    job.pipelineVersion !== MEMORY_HISTORY_INDEX_PIPELINE_VERSION ||
    job.activeLeafMessageId === null ||
    job.branchGeneration === null ||
    job.chatId === null ||
    job.sourceHash === null ||
    job.sourceRevision === null ||
    !validIdentity(job.activeLeafMessageId) ||
    !validIdentity(job.chatId) ||
    !validIdentity(job.userId) ||
    !validCounter(job.branchGeneration) ||
    !validCounter(job.sourceRevision) ||
    !sha256Pattern.test(job.sourceHash)
  ) {
    return false;
  }
  const source = {
    activeLeafMessageId: job.activeLeafMessageId,
    id: job.chatId,
    memoryBranchGeneration: job.branchGeneration,
    memorySourceRevision: job.sourceRevision,
    sourceHash: job.sourceHash,
    userId: job.userId
  };
  const expected = memoryHistoryIndexJobFingerprint(source);
  if (job.idempotencyFingerprint === expected) return true;
  const match = /^heal-history:[a-f0-9]{64}:([1-3])$/u.exec(job.idempotencyFingerprint);
  if (match) return job.idempotencyFingerprint === memoryHistoryAutoHealJobFingerprint(source, Number(match[1]));
  const versioned = /^heal-history:[a-f0-9]{64}:(v[1-9][0-9]*):([1-9][0-9]{0,9}):([1-3])$/u.exec(job.idempotencyFingerprint);
  return Boolean(versioned && versioned[1] === MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION &&
    validCounter(Number(versioned[2])) && job.idempotencyFingerprint ===
    memoryHistoryAutoHealJobFingerprint(source, Number(versioned[3]), Number(versioned[2])));
}

export function memoryHistoryChunkId(
  source: MemoryHistoryIndexSourceIdentity,
  chunk: MemoryRecallChunkProjection
): string {
  return memorySha256({
    chatId: source.chatId,
    chunkContentHash: chunk.contentHash,
    chunkingVersion: chunk.chunkingVersion,
    domain: "aiqsa.memory.recall-chunk",
    sourceProjectionVersion: chunk.sourceProjectionVersion,
    userId: source.userId
  });
}

export function memoryHistoryDigestId(
  source: MemoryHistoryIndexSourceIdentity,
  contentHash: string
): string {
  return memorySha256({
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    contentHash,
    domain: "aiqsa.memory.chat-digest",
    pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
    sourceHash: source.sourceHash,
    sourceRevision: source.sourceRevision,
    userId: source.userId
  });
}

export function memoryHistoryIndexResultHash(
  source: MemoryHistoryIndexSourceIdentity,
  chunks: readonly MemoryHistoryPreparedChunk[],
  suppressionIdentitySnapshot: string,
  classificationPolicyVersion: string | null,
  timeZone: string,
  options: Readonly<{
    checkpointMessages?: readonly MemoryHistoryCheckpointMessage[];
    digest?: MemoryHistoryDigestPlan | null;
    digestPolicyVersion?: string | null;
    incremental?: MemoryHistoryIndexPlan["incremental"];
    rebuiltChunkIds?: readonly string[];
    rebuiltRoundIds?: readonly string[];
    reusedChunkIds?: readonly string[];
    reusedRoundIds?: readonly string[];
    rounds?: readonly MemoryHistoryPreparedRound[];
    toolEvents?: readonly MemoryHistoryPreparedToolEvent[];
    work?: MemoryHistoryWorkCounters;
  }> = {}
): string {
  const canonicalTimeZone = canonicalMemoryTimeZone(timeZone);
  if (!canonicalTimeZone || canonicalTimeZone !== timeZone) {
    throw new Error("memory_history_time_zone_invalid");
  }
  return memorySha256({
    chunks: chunks.map((chunk) => ({
      contentHash: chunk.contentHash,
      id: chunk.id,
      messageJoins: chunk.messageJoins,
      ordinal: chunk.ordinal,
      redactionReasonCodes: chunk.redactionReasonCodes,
      redactionState: chunk.redactionState,
      safetyClass: chunk.safetyClass,
      sourceAssistantId: chunk.sourceAssistantId,
      publicationState: chunk.publicationState
    })),
    classificationPolicyVersion,
    checkpointMessages: options.checkpointMessages ?? [],
    digest: options.digest ?? null,
    digestPolicyVersion: options.digestPolicyVersion ?? null,
    incremental: options.incremental ?? null,
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    rebuiltChunkIds: options.rebuiltChunkIds ?? [],
    rebuiltRoundIds: options.rebuiltRoundIds ?? [],
    rounds: (options.rounds ?? []).map((round) => ({
      branchGeneration: round.branchGeneration,
      contextualKeyPolicyVersion: round.contextualKeyPolicyVersion,
      contextualKeyState: round.contextualKeyState,
      contextualNarrativeText: round.contextualNarrativeText,
      contextualSearchHash: round.contextualSearchHash,
      contextualSearchText: round.contextualSearchText,
      contentHash: round.contentHash,
      evidenceRootHash: round.evidenceRootHash,
      folderId: round.folderId,
      groupKind: round.groupKind,
      id: round.id,
      languageCode: round.languageCode,
      messageJoins: round.messageJoins,
      occurredFrom: round.occurredFrom,
      occurredTo: round.occurredTo,
      ordinal: round.ordinal,
      parentChunkId: round.parentChunkId,
      projectionVersion: round.projectionVersion,
      publicationState: round.publicationState,
      rawSafeText: round.rawSafeText,
      redactionReasonCodes: round.redactionReasonCodes,
      redactionState: round.redactionState,
      safetyClass: round.safetyClass,
      sourceAssistantId: round.sourceAssistantId,
      sourceContentHash: round.sourceContentHash,
      sourceProjectionVersion: round.sourceProjectionVersion,
      sourceRevision: round.sourceRevision,
      supportingRoundIds: round.supportingRoundIds
    })),
    toolEvents: (options.toolEvents ?? []).map((event) => ({
      assistantMessageId: event.assistantMessageId,
      branchGeneration: event.branchGeneration,
      chatId: event.chatId,
      contentHash: event.contentHash,
      evidenceRootHash: event.evidenceRootHash,
      id: event.id,
      modelRunId: event.modelRunId,
      modelRunToolCallId: event.modelRunToolCallId,
      occurredAt: event.occurredAt,
      operation: event.operation,
      outcome: event.outcome,
      projectionVersion: event.projectionVersion,
      publicationState: event.publicationState,
      redactionReasonCodes: event.redactionReasonCodes,
      redactionState: event.redactionState,
      safeProjectedText: event.safeProjectedText,
      safetyClass: event.safetyClass,
      sourcePayloadHash: event.sourcePayloadHash,
      sourceCallUpdatedAt: event.sourceCallUpdatedAt,
      sourceRevision: event.sourceRevision,
      structuredIdentifiers: event.structuredIdentifiers,
      toolName: event.toolName
    })),
    reusedChunkIds: options.reusedChunkIds ?? [],
    reusedRoundIds: options.reusedRoundIds ?? [],
    source,
    suppressionIdentitySnapshot,
    timeZone: canonicalTimeZone,
    work: options.work ?? EMPTY_MEMORY_HISTORY_WORK_COUNTERS
  });
}
