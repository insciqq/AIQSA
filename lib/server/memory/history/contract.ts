import type { MemoryJobDescriptor } from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import type { MemorySourceSnapshot } from "../sourceState";
import type { MemoryRecallChunkProjection } from "./chunking";

export const MEMORY_HISTORY_INDEX_PIPELINE_VERSION = "memory-history-index-v1";
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

export type MemoryHistoryPreparedChunk = MemoryRecallChunkProjection & Readonly<{
  id: string;
}>;

export type MemoryHistoryIndexPlan = Readonly<{
  chunks: readonly MemoryHistoryPreparedChunk[];
  resultHash: string;
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
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    chunkContentHash: chunk.contentHash,
    chunkingVersion: chunk.chunkingVersion,
    domain: "aiqsa.memory.recall-chunk",
    ordinal: chunk.ordinal,
    sourceHash: source.sourceHash,
    sourceProjectionVersion: chunk.sourceProjectionVersion,
    sourceRevision: source.sourceRevision,
    userId: source.userId
  });
}

export function memoryHistoryIndexResultHash(
  source: MemoryHistoryIndexSourceIdentity,
  chunks: readonly MemoryHistoryPreparedChunk[],
  suppressionIdentitySnapshot: string
): string {
  return memorySha256({
    chunks: chunks.map((chunk) => ({
      contentHash: chunk.contentHash,
      id: chunk.id,
      messageJoins: chunk.messageJoins,
      ordinal: chunk.ordinal,
      sourceAssistantId: chunk.sourceAssistantId
    })),
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    source,
    suppressionIdentitySnapshot
  });
}
