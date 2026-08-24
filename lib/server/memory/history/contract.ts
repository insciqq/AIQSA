import type { MemoryJobDescriptor } from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import type { MemorySourceSnapshot } from "../sourceState";
import type { MemoryRecallChunkProjection } from "./chunking";

export const MEMORY_HISTORY_INDEX_PIPELINE_VERSION = "memory-history-incremental-v1";
export const MEMORY_CHAT_DIGEST_PIPELINE_VERSION = "memory-chat-digest-v1";
export const MEMORY_HISTORY_INDEX_JOB_PREFIX = "index-history:";

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
  languageCode: string;
  occurredFrom: string;
  occurredTo: string;
  openLoops: readonly string[];
  safeDigestText: string;
  sourceChunkIds: readonly string[];
  sourceMessageIds: readonly string[];
  summary: string;
  topics: readonly string[];
}>;

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
  resultHash: string;
  reusedChunkIds: readonly string[];
  source: MemoryHistoryIndexSourceIdentity;
  suppressionIdentitySnapshot: string;
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
  return job.idempotencyFingerprint === memoryHistoryIndexJobFingerprint({
    activeLeafMessageId: job.activeLeafMessageId,
    id: job.chatId,
    memoryBranchGeneration: job.branchGeneration,
    memorySourceRevision: job.sourceRevision,
    sourceHash: job.sourceHash,
    userId: job.userId
  });
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
  classificationPolicyVersion: string | null = null,
  options: Readonly<{
    checkpointMessages?: readonly MemoryHistoryCheckpointMessage[];
    digest?: MemoryHistoryDigestPlan | null;
    digestPolicyVersion?: string | null;
    incremental?: MemoryHistoryIndexPlan["incremental"];
    rebuiltChunkIds?: readonly string[];
    reusedChunkIds?: readonly string[];
  }> = {}
): string {
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
    reusedChunkIds: options.reusedChunkIds ?? [],
    source,
    suppressionIdentitySnapshot
  });
}
