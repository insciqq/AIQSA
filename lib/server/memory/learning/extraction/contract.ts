import type { MemoryJobDescriptor } from "../../coordinator/types";
import type { MemoryExecutionVersions } from "../../execution";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTextLanguage } from "../../history/language";

export const MEMORY_FACT_EXTRACTION_PIPELINE_VERSION = "memory-fact-extraction-v1";
export const MEMORY_FACT_EXTRACTION_POLICY_VERSION =
  "memory-fact-source-grounding-policy-v1";
export const MEMORY_FACT_EXTRACTION_PROMPT_VERSION =
  "memory-fact-source-grounding-prompt-v1";
export const MEMORY_FACT_EXTRACTION_SCHEMA_VERSION =
  "memory-fact-source-grounding-schema-v1";
export const MEMORY_FACT_TEMPORAL_RESOLVER_VERSION =
  "memory-fact-temporal-conservative-v1";
export const MEMORY_FACT_SOURCE_PROJECTION_VERSION =
  "memory-fact-source-projection-v1";
export const MEMORY_FACT_EXTRACTION_JOB_PREFIX = "extract-facts:";

export const MEMORY_FACT_MAX_INPUT_MESSAGES = 24;
export const MEMORY_FACT_MAX_INPUT_CHARACTERS = 16_000;
export const MEMORY_FACT_MAX_OUTPUT_CANDIDATES = 12;
export const MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE = 6;

export const MEMORY_FACT_EXTRACTION_RETRIEVAL_CONFIG_FINGERPRINT =
  memorySha256({
    evidenceMode: "exact-direct-user-spans",
    maxCandidates: MEMORY_FACT_MAX_OUTPUT_CANDIDATES,
    maxEvidencePerCandidate: MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE,
    maxInputCharacters: MEMORY_FACT_MAX_INPUT_CHARACTERS,
    maxInputMessages: MEMORY_FACT_MAX_INPUT_MESSAGES,
    version: 1
  });

export const MEMORY_FACT_EXTRACTION_VERSIONS: MemoryExecutionVersions =
  Object.freeze({
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
    retrievalConfigFingerprint:
      MEMORY_FACT_EXTRACTION_RETRIEVAL_CONFIG_FINGERPRINT,
    schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
  });

export type MemoryFactSourceIdentity = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  sourceHash: string;
  sourceRevision: number;
  userId: string;
}>;

export type MemoryFactInputMessage = Readonly<{
  contentHash: string;
  createdAt: string;
  id: string;
  languageCode: MemoryTextLanguage;
  text: string;
  updatedAt: string;
}>;

export type MemoryFactExtractionInput = Readonly<{
  folderId: string | null;
  inputHash: string;
  messages: readonly MemoryFactInputMessage[];
  source: MemoryFactSourceIdentity;
  sourceProjectionHash: string;
  sourceProjectionVersion: typeof MEMORY_FACT_SOURCE_PROJECTION_VERSION;
  suppressionIdentitySnapshot: string;
  timeZone: string;
}>;

export type MemoryFactCandidateScope = Readonly<
  | { targetId: null; type: "GLOBAL_USER" }
  | { targetId: string; type: "ASSISTANT" | "CHAT" | "FOLDER" }
>;

export type MemoryFactCandidateEvidence = Readonly<{
  endOffset: number;
  messageId: string;
  sourceTextHash: string;
  startOffset: number;
}>;

export type MemoryExtractedCandidate = Readonly<{
  canonicalKey: string;
  confidence: number;
  directness: "DIRECT";
  displayText: string;
  evidence: readonly MemoryFactCandidateEvidence[];
  id: string;
  importance: number;
  languageCode: MemoryTextLanguage;
  modality:
    | "CONSIDERATION"
    | "CONSTRAINT"
    | "EVENT"
    | "HABIT"
    | "INTENTION"
    | "PLAN"
    | "PREFERENCE"
    | "STATE"
    | "WORKFLOW";
  negated: boolean;
  proposedValue: unknown;
  rawTemporalExpression: string | null;
  reasonCode: string | null;
  scope: MemoryFactCandidateScope;
  sensitivity: "NORMAL";
  state: "DEFERRED" | "PENDING";
  temporalResolutionEvidence: Readonly<Record<string, unknown>> | null;
  validFrom: string | null;
  validTo: string | null;
  category: string;
}>;

export type MemoryFactExtractionPlan = Readonly<{
  candidates: readonly MemoryExtractedCandidate[];
  input: MemoryFactExtractionInput;
  outputHash: string;
}>;

const sha256Pattern = /^[a-f0-9]{64}$/u;

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 256 && !/\s/u.test(value);
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
    Number(value) <= 2_147_483_647;
}

export function memoryFactExtractionJobFingerprint(
  source: MemoryFactSourceIdentity
): string {
  if (
    !validIdentity(source.activeLeafMessageId) ||
    !validIdentity(source.chatId) ||
    !validIdentity(source.userId) ||
    !validCounter(source.branchGeneration) ||
    !validCounter(source.sourceRevision) ||
    !sha256Pattern.test(source.sourceHash)
  ) throw new Error("memory_fact_source_invalid");
  return `${MEMORY_FACT_EXTRACTION_JOB_PREFIX}${memorySha256({
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    source
  })}`;
}

export function memoryFactExtractionClaimIsValid(
  job: MemoryJobDescriptor
): job is MemoryJobDescriptor & MemoryFactSourceIdentity {
  if (
    job.kind !== "EXTRACT_FACTS" ||
    job.pipelineVersion !== MEMORY_FACT_EXTRACTION_PIPELINE_VERSION ||
    job.activeLeafMessageId === null || job.branchGeneration === null ||
    job.chatId === null || job.sourceHash === null || job.sourceRevision === null
  ) return false;
  const source: MemoryFactSourceIdentity = {
    activeLeafMessageId: job.activeLeafMessageId,
    branchGeneration: job.branchGeneration,
    chatId: job.chatId,
    sourceHash: job.sourceHash,
    sourceRevision: job.sourceRevision,
    userId: job.userId
  };
  try {
    return job.idempotencyFingerprint === memoryFactExtractionJobFingerprint(source);
  } catch {
    return false;
  }
}

export function memoryFactExtractionInputHash(
  input: Omit<MemoryFactExtractionInput, "inputHash">
): string {
  return memorySha256({
    ...input,
    policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
    schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
  });
}

export function memoryFactCandidateId(
  input: MemoryFactExtractionInput,
  candidate: Omit<MemoryExtractedCandidate, "id">
): string {
  return memorySha256({
    candidate: {
      ...candidate,
      evidence: candidate.evidence.map((evidence) => ({
        endOffset: evidence.endOffset,
        messageId: evidence.messageId,
        sourceTextHash: evidence.sourceTextHash,
        startOffset: evidence.startOffset
      }))
    },
    domain: "aiqsa.memory.fact-candidate",
    source: {
      chatId: input.source.chatId,
      userId: input.source.userId
    },
    version: 1
  });
}

export function memoryFactExtractionOutputHash(
  input: MemoryFactExtractionInput,
  candidates: readonly MemoryExtractedCandidate[]
): string {
  return memorySha256({
    candidates,
    inputHash: input.inputHash,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION
  });
}
