import type { MemoryJobDescriptor } from "../../coordinator/types";
import type { MemoryExecutionVersions } from "../../execution";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTextLanguage } from "../language";

export const MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION =
  "memory-episode-extraction-v1";
export const MEMORY_EPISODE_EXTRACTION_POLICY_VERSION =
  "memory-episode-extractive-policy-v2";
export const MEMORY_EPISODE_EXTRACTION_PROMPT_VERSION =
  "memory-episode-extractive-prompt-v1";
export const MEMORY_EPISODE_EXTRACTION_SCHEMA_VERSION =
  "memory-episode-extractive-schema-v1";
export const MEMORY_EPISODE_EXTRACTION_RETRIEVAL_CONFIG_FINGERPRINT =
  memorySha256({
    maxChunksPerCall: 6,
    maxChunksPerEpisode: 2,
    maxEpisodesPerCall: 8,
    maxInputCharacters: 16_000,
    summaryMode: "verbatim-source-span",
    version: 1
  });
export const MEMORY_EPISODE_EXTRACTION_JOB_PREFIX = "extract-episode:";
export const MEMORY_EPISODE_REDREAM_JOB_PREFIX =
  "memory-episode-redream-v1:";

export const MEMORY_EPISODE_EXTRACTION_VERSIONS: MemoryExecutionVersions =
  Object.freeze({
    pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
    policyVersion: MEMORY_EPISODE_EXTRACTION_POLICY_VERSION,
    promptVersion: MEMORY_EPISODE_EXTRACTION_PROMPT_VERSION,
    retrievalConfigFingerprint:
      MEMORY_EPISODE_EXTRACTION_RETRIEVAL_CONFIG_FINGERPRINT,
    schemaVersion: MEMORY_EPISODE_EXTRACTION_SCHEMA_VERSION
  });

export const MEMORY_EPISODE_MAX_INPUT_CHUNKS = 6;
export const MEMORY_EPISODE_MAX_INPUT_CHARACTERS = 16_000;
export const MEMORY_EPISODE_MAX_OUTPUT_EPISODES = 8;
export const MEMORY_EPISODE_MAX_CHUNKS_PER_EPISODE = 2;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function validIdentity(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 && value.length <= 256 && !/\s/u.test(value);
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
    Number(value) <= 2_147_483_647;
}

export type MemoryEpisodeSourceIdentity = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  sourceHash: string;
  sourceRevision: number;
  userId: string;
}>;

export type MemoryEpisodeInputChunk = Readonly<{
  contentHash: string;
  id: string;
  languageCode: MemoryTextLanguage;
  messageIds: readonly string[];
  occurredFrom: string;
  occurredTo: string;
  ordinal: number;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safeProjectedText: string;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceFolderId: string | null;
  sourceProjectionVersion: string;
}>;

export type MemoryEpisodeExtractionInput = Readonly<{
  chunks: readonly MemoryEpisodeInputChunk[];
  inputHash: string;
  source: MemoryEpisodeSourceIdentity;
  sourceWindowHash: string;
  suppressionIdentitySnapshot: string;
}>;

export type MemoryEpisodeCandidate = Readonly<{
  chunkIds: readonly string[];
  entities: readonly string[];
  keywords: readonly string[];
  languageCode: MemoryTextLanguage;
  messageIds: readonly string[];
  occurredFrom: string;
  occurredTo: string;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safeSummary: string;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceFolderId: string | null;
  sourceProjectionVersion: string;
}>;

export type MemoryEpisodeExtractionPlan = Readonly<{
  episodes: readonly MemoryEpisodeCandidate[];
  input: MemoryEpisodeExtractionInput;
  outputHash: string;
}>;

export function memoryEpisodeExtractionJobFingerprint(
  source: MemoryEpisodeSourceIdentity
): string {
  if (
    !validIdentity(source.activeLeafMessageId) ||
    !validIdentity(source.chatId) ||
    !validIdentity(source.userId) ||
    !validCounter(source.branchGeneration) ||
    !validCounter(source.sourceRevision) ||
    !sha256Pattern.test(source.sourceHash)
  ) {
    throw new Error("memory_episode_source_invalid");
  }
  return `${MEMORY_EPISODE_EXTRACTION_JOB_PREFIX}${memorySha256({
    pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
    source
  })}`;
}

export function memoryEpisodeRedreamJobFingerprint(
  batchId: string,
  source: MemoryEpisodeSourceIdentity
): string {
  if (!uuidPattern.test(batchId)) {
    throw new Error("memory_episode_redream_batch_invalid");
  }
  // Reuse the ordinary source validator before deriving the salted identity.
  memoryEpisodeExtractionJobFingerprint(source);
  const candidate = `${MEMORY_EPISODE_REDREAM_JOB_PREFIX}${batchId}:${memorySha256({
    batchId,
    pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
    source,
    version: "v1"
  })}`;
  if (candidate.length > 128) {
    throw new Error("memory_episode_redream_identity_invalid");
  }
  return candidate;
}

export function memoryEpisodeRedreamBatchId(
  fingerprint: string
): string | null {
  const match = /^memory-episode-redream-v1:([a-f0-9-]{36}):([a-f0-9]{64})$/u
    .exec(fingerprint);
  return match && uuidPattern.test(match[1]!) ? match[1]! : null;
}

export function memoryEpisodeExtractionClaimIsValid(
  job: MemoryJobDescriptor
): job is MemoryJobDescriptor & MemoryEpisodeSourceIdentity {
  if (
    job.kind !== "EXTRACT_EPISODE" ||
    job.pipelineVersion !== MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION ||
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
  ) return false;
  const source = {
    activeLeafMessageId: job.activeLeafMessageId,
    branchGeneration: job.branchGeneration,
    chatId: job.chatId,
    sourceHash: job.sourceHash,
    sourceRevision: job.sourceRevision,
    userId: job.userId
  };
  if (job.idempotencyFingerprint === memoryEpisodeExtractionJobFingerprint(source)) {
    return true;
  }
  const batchId = memoryEpisodeRedreamBatchId(job.idempotencyFingerprint);
  return batchId !== null &&
    job.idempotencyFingerprint === memoryEpisodeRedreamJobFingerprint(batchId, source);
}

export function memoryEpisodeSourceWindowHash(
  source: MemoryEpisodeSourceIdentity,
  chunks: readonly MemoryEpisodeInputChunk[],
  suppressionIdentitySnapshot: string
): string {
  return memorySha256({
    chunks: chunks.map((chunk) => ({
      contentHash: chunk.contentHash,
      id: chunk.id,
      messageIds: chunk.messageIds,
      ordinal: chunk.ordinal,
      redactionReasonCodes: chunk.redactionReasonCodes,
      redactionState: chunk.redactionState,
      safetyClass: chunk.safetyClass,
      sourceProjectionVersion: chunk.sourceProjectionVersion
    })),
    pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION,
    source,
    suppressionIdentitySnapshot
  });
}

export function memoryEpisodeExtractionInputHash(input: Omit<
  MemoryEpisodeExtractionInput,
  "inputHash"
>): string {
  return memorySha256({
    chunks: input.chunks,
    policyVersion: MEMORY_EPISODE_EXTRACTION_POLICY_VERSION,
    promptVersion: MEMORY_EPISODE_EXTRACTION_PROMPT_VERSION,
    schemaVersion: MEMORY_EPISODE_EXTRACTION_SCHEMA_VERSION,
    source: input.source,
    sourceWindowHash: input.sourceWindowHash,
    suppressionIdentitySnapshot: input.suppressionIdentitySnapshot
  });
}

export function memoryEpisodeExtractionOutputHash(
  input: MemoryEpisodeExtractionInput,
  episodes: readonly MemoryEpisodeCandidate[]
): string {
  return memorySha256({
    episodes,
    inputHash: input.inputHash,
    pipelineVersion: MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION
  });
}

export function memoryEpisodeId(
  input: MemoryEpisodeExtractionInput,
  episode: MemoryEpisodeCandidate,
  ordinal: number
): string {
  return memorySha256({
    chunkIds: episode.chunkIds,
    domain: "aiqsa.memory.episode",
    inputHash: input.inputHash,
    messageIds: episode.messageIds,
    ordinal,
    safeSummary: episode.safeSummary,
    source: input.source,
    version: 1
  });
}
