import type { MemoryJobDescriptor } from "../../coordinator/types";
import type { MemoryExecutionVersions } from "../../execution";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTextLanguage } from "../../history/language";

export const MEMORY_FACT_EXTRACTION_PIPELINE_VERSION = "memory-fact-extraction-v1";
export const MEMORY_FACT_EXTRACTION_POLICY_VERSION =
  "memory-fact-personal-v2-policy";
export const MEMORY_FACT_EXTRACTION_PROMPT_VERSION =
  "memory-fact-personal-v2-prompt";
export const MEMORY_FACT_EXTRACTION_SCHEMA_VERSION =
  "memory-fact-personal-v1-schema";
export const MEMORY_FACT_TEMPORAL_RESOLVER_VERSION =
  "memory-fact-temporal-conservative-v1";
export const MEMORY_FACT_SOURCE_PROJECTION_VERSION =
  "memory-fact-source-projection-v1";
export const MEMORY_FACT_EXTRACTION_JOB_PREFIX = "extract-facts:";

// Automatic learning is intentionally scoped to the one direct-user message
// that caused the settled turn.  Keeping this bound in the contract prevents
// a worker from silently widening the evidence window later.
export const MEMORY_FACT_MAX_INPUT_MESSAGES = 1;
export const MEMORY_FACT_MAX_INPUT_CHARACTERS = 16_000;
/** Public output cap: no more than four candidates can be accepted per turn. */
export const MEMORY_FACT_MAX_OUTPUT_CANDIDATES = 4;
/** The model packet is bounded separately so invalid siblings do not consume
 * an accepted slot. */
export const MEMORY_FACT_MAX_PACKET_CANDIDATES = 8;
export const MEMORY_FACT_MAX_ACCEPTED_CANDIDATES = MEMORY_FACT_MAX_OUTPUT_CANDIDATES;
export const MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE = 1;

/** The one v1 category vocabulary shared by UI, explicit actions, and
 * automatic learning. Values are storage slugs; labels belong to the UI. */
export const MEMORY_V1_CATEGORY_ALLOWLIST = Object.freeze([
  "about_you",
  "preferences",
  "work",
  "goals",
  "constraints_routines",
  "other",
  "sensitive"
] as const);
export type MemoryV1Category = (typeof MEMORY_V1_CATEGORY_ALLOWLIST)[number];

/** New facts use ordinary semantic categories; `sensitive` is legacy-only. */
export const MEMORY_FACT_DURABLE_CATEGORIES = Object.freeze(
  MEMORY_V1_CATEGORY_ALLOWLIST.filter((category) => category !== "sensitive")
);
export type MemoryFactDurableCategory =
  (typeof MEMORY_FACT_DURABLE_CATEGORIES)[number];
export type MemoryFactConfidenceBand = "HIGH" | "MEDIUM" | "LOW";
export type MemoryFactCandidateSensitivity =
  "NORMAL" | "SENSITIVE" | "SECRET" | "UNCERTAIN";

export type MemoryFactCandidateRejection = Readonly<{
  candidateOrdinal: number;
  reasonCode:
    | "REJECT_AMBIGUOUS"
    | "REJECT_DUPLICATE"
    | "REJECT_LOW_CONFIDENCE"
    | "REJECT_SECRET"
    | "REJECT_STALE_SOURCE"
    | "REJECT_TEMPORARY"
    | "REJECT_UNSUPPORTED";
}>;

export const MEMORY_FACT_EXTRACTION_RETRIEVAL_CONFIG_FINGERPRINT =
  memorySha256({
    evidenceMode: "exact-direct-user-spans",
    maxAcceptedCandidates: MEMORY_FACT_MAX_ACCEPTED_CANDIDATES,
    maxCandidates: MEMORY_FACT_MAX_PACKET_CANDIDATES,
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
  /** The quote is server-derived from the submitted offsets. */
  quote?: string;
  sourceTextHash: string;
  startOffset: number;
}>;

export type MemoryExtractedCandidate = Readonly<{
  /** v1 semantic fields returned by the strict System Model. */
  category: string;
  confidenceBand?: MemoryFactConfidenceBand;
  correction?: boolean;
  futureUseful?: boolean;
  quote?: string;
  responsePreference?: string | null;
  statement?: string;
  temporary?: boolean;

  /** Existing persistence projection (server-owned, never model supplied). */
  canonicalKey: string;
  coreEligible: boolean;
  coreSalience: "HIGH" | "LOW" | "MEDIUM" | "NONE";
  confidence: number;
  directness: "DIRECT" | "PARAPHRASED";
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
  negated: false;
  proposedValue: unknown;
  rawTemporalExpression: string | null;
  reasonCode: null;
  scope: MemoryFactCandidateScope;
  sensitivity: "NORMAL";
  state: "PENDING";
  temporalResolutionEvidence: Readonly<Record<string, unknown>> | null;
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryFactExtractionPlan = Readonly<{
  candidates: readonly MemoryExtractedCandidate[];
  input: MemoryFactExtractionInput;
  outputHash: string;
  rejections?: readonly MemoryFactCandidateRejection[];
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
  // Semantic v1 annotations are intentionally excluded from the storage
  // identity.  They are model metadata and may be reclassified without
  // changing the source-grounded candidate's id; evidence/content remain in
  // the identity below.
  const {
    canonicalKey: _serverOwnedOpaqueKey,
    confidenceBand: _confidenceBand,
    correction: _correction,
    futureUseful: _futureUseful,
    quote: _quote,
    responsePreference: _responsePreference,
    statement: _statement,
    temporary: _temporary,
    ...identity
  } = candidate;
  return memorySha256({
    candidate: {
      ...identity,
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
