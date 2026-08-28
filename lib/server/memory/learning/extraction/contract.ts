import type { MemoryJobDescriptor } from "../../coordinator/types";
import type { MemoryExecutionVersions } from "../../execution";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTextLanguage } from "../../history/language";
import { MEMORY_TEMPORAL_RESOLVER_VERSION } from "../temporal/resolver";

export const MEMORY_FACT_EXTRACTION_PIPELINE_VERSION =
  "memory-fact-extraction-vnext-v7";
export const MEMORY_FACT_EXTRACTION_POLICY_VERSION =
  "memory-fact-extraction-policy-v10";
export const MEMORY_FACT_EXTRACTION_PROMPT_VERSION =
  "memory-fact-extraction-prompt-v28";
export const MEMORY_FACT_EXTRACTION_SCHEMA_VERSION =
  "memory-fact-extraction-schema-v5";
export const MEMORY_FACT_TEMPORAL_RESOLVER_VERSION =
  MEMORY_TEMPORAL_RESOLVER_VERSION;
export const MEMORY_FACT_SOURCE_PROJECTION_VERSION =
  "memory-fact-source-projection-v5";
export const MEMORY_FACT_EXTRACTION_JOB_PREFIX = "extract-facts:vnext:";

// Context is a bounded non-authoritative aid. The final direct-user target is
// the only evidence source; every admitted prior message is persisted as an
// immutable dependency when a candidate actually relies on it.
export const MEMORY_FACT_MAX_INPUT_MESSAGES = 6;
export const MEMORY_FACT_MAX_INPUT_CHARACTERS = 8_000;
export const MEMORY_FACT_MAX_PRIOR_TURN_GROUPS = 2;
export const MEMORY_FACT_MAX_CONTEXT_MESSAGES = 6;
export const MEMORY_FACT_MAX_CONTEXT_CHARACTERS = 8_000;
export const MEMORY_FACT_MAX_CONTEXT_REFS = 8;
/** Public output cap: no more than four candidates can be accepted per turn. */
export const MEMORY_FACT_MAX_OUTPUT_CANDIDATES = 4;
/** Strict public and wire bound: a target message yields zero to four rows. */
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

export type MemorySemanticSpeechAct =
  "ASSERTION" | "COMMAND" | "QUESTION" | "OTHER" | "UNKNOWN";
export type MemorySemanticAssertionStatus =
  "ASSERTED" | "CONDITIONAL" | "HYPOTHETICAL" | "QUOTED" | "UNKNOWN";
export type MemorySemanticSubjectScope =
  "CURRENT_USER" | "THIRD_PARTY" | "ASSISTANT" | "UNKNOWN";
export type MemorySemanticPolarity =
  "AFFIRMED" | "NEGATED" | "CORRECTION" | "RETRACTION" | "UNKNOWN";
export type MemorySemanticTemporalPerspective =
  "CURRENT" | "FORMER" | "FUTURE" | "EVENT" | "INTERVAL" | "UNKNOWN";
export type MemorySemanticChangeIntent =
  "NONE" | "STATE_CHANGE" | "CORRECTION" | "RETRACTION" | "REOPEN" |
  "UNKNOWN";

export type MemorySemanticFrame = Readonly<{
  assertionStatus: MemorySemanticAssertionStatus;
  changeIntent: MemorySemanticChangeIntent;
  memoryDirective: "NONE" | "EXPLICIT_REMEMBER" | "UNKNOWN";
  polarity: MemorySemanticPolarity;
  speechAct: MemorySemanticSpeechAct;
  subjectScope: MemorySemanticSubjectScope;
  temporalPerspective: MemorySemanticTemporalPerspective;
}>;

/** Exact model-authored source reference. Occurrences and all resulting
 * offsets use JavaScript string indexing and therefore the UTF-16 wire unit. */
export type MemoryExactTextRef = Readonly<{
  occurrenceIndex: number;
  text: string;
}>;

export type MemoryTemporalPointNormalization = Readonly<
  | { kind: "NONE" }
  | {
      kind: "ABSOLUTE";
      localDate: string;
      localTime: string | null;
      zone: string | null;
    }
  | {
      amount: number;
      kind: "CALENDAR_OFFSET";
      unit: "DAY" | "WEEK" | "MONTH" | "YEAR";
    }
  | {
      direction: "PREVIOUS" | "CURRENT" | "NEXT";
      kind: "RELATIVE_WEEKDAY";
      weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
    }
>;

export type MemoryTemporalNormalization = Readonly<
  | MemoryTemporalPointNormalization
  | {
      end: MemoryTemporalPointNormalization;
      kind: "INTERVAL";
      start: MemoryTemporalPointNormalization;
    }
>;

export type MemorySemanticAdjudication = Readonly<{
  assertionStatus: MemorySemanticAssertionStatus;
  candidateRef: string;
  confidenceBand: MemoryFactConfidenceBand;
  entailment: "ENTAILED" | "CONTRADICTED" | "UNKNOWN";
  entityRef: string | null;
  operation:
    | "NO_RELATION"
    | "REINFORCE"
    | "MERGE_NEW_INTO_TARGET"
    | "MERGE_TARGET_INTO_NEW"
    | "SUPERSEDE_TARGET"
    | "MOVE_TO_DISTINCT_FACT"
    | "RETRACT_TARGET"
    | "AMBIGUOUS";
  reasonCode: string;
  subjectScope: MemorySemanticSubjectScope;
  targetRef: string | null;
  temporalPerspective: MemorySemanticTemporalPerspective;
}>;

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
    maxContextCharacters: MEMORY_FACT_MAX_CONTEXT_CHARACTERS,
    maxContextMessages: MEMORY_FACT_MAX_CONTEXT_MESSAGES,
    maxContextRefs: MEMORY_FACT_MAX_CONTEXT_REFS,
    maxEvidencePerCandidate: MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE,
    maxInputCharacters: MEMORY_FACT_MAX_INPUT_CHARACTERS,
    maxInputMessages: MEMORY_FACT_MAX_INPUT_MESSAGES,
    maxPriorTurnGroups: MEMORY_FACT_MAX_PRIOR_TURN_GROUPS,
    version: 3
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
  memoryGenerationSnapshot: number;
  sourceHash: string;
  sourceMessageId: string;
  sourceRevision: number;
  userId: string;
}>;

export type MemoryFactInputMessage = Readonly<{
  contentHash: string;
  createdAt: string;
  evidenceEligible: boolean;
  id: string;
  languageCode: MemoryTextLanguage;
  redactionSpans: readonly Readonly<{
    endOffset: number;
    startOffset: number;
  }>[];
  role: "assistant" | "user";
  text: string;
  updatedAt: string;
}>;

export type MemoryFactContextRef = Readonly<{
  aliases: readonly string[];
  displayName: string | null;
  entityType: string | null;
  identitySubjectKey: string | null;
  /** Internal owner-scoped identity; never included in the provider payload. */
  entityId: string | null;
  kind: "FACT_VERSION" | "MESSAGE";
  ref: string;
  source: Readonly<
    | {
        contentHash: string;
        factVersionId: null;
        messageId: string;
        messageUpdatedAt: string;
        projectionVersion: string;
      }
    | {
        contentHash: null;
        factVersionId: string;
        messageId: null;
        messageUpdatedAt: null;
        projectionVersion: null;
      }
  >;
  text: string;
}>;

export type MemoryFactExtractionInput = Readonly<{
  contextRefs: readonly MemoryFactContextRef[];
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

export type MemoryFactCandidateDependency = Readonly<{
  dependencyKind:
    | "COREFERENCE_ANTECEDENT"
    | "CORRECTION_TARGET"
    | "TEMPORAL_CONTEXT"
    | "RELATION_CONTEXT";
  ref: string;
  source: MemoryFactContextRef["source"];
}>;

export type MemoryFactCandidateEntity = Readonly<{
  aliases: readonly string[];
  canonicalLabel: string;
  contextEntityId: string | null;
  contextRef: string | null;
  entityType: string;
  mention: string | null;
  mentionKind: "NAMED" | "NOMINAL" | "PRONOMINAL" | "ELLIPSIS" | "UNKNOWN";
  qualifiers: Readonly<Record<string, string | null>>;
  role: "SUBJECT" | "OBJECT" | "MENTION";
}>;

export type MemoryExtractedCandidate = Readonly<{
  /** v1 semantic fields returned by the strict System Model. */
  candidateRef: string;
  category: string;
  confidenceBand?: MemoryFactConfidenceBand;
  correction?: boolean;
  futureUseful?: boolean;
  quote?: string;
  responsePreference?: string | null;
  statement?: string;
  temporary?: boolean;

  /** Strict language-neutral authority emitted by the System Model. */
  expirationIntent: "EXPLICIT" | "NONE" | "UNKNOWN";
  semanticFrame: MemorySemanticFrame;
  temporalNormalization: MemoryTemporalNormalization;

  /** Existing persistence projection (server-owned, never model supplied). */
  canonicalKey: string;
  dimensionKey: string | null;
  coreEligible: boolean;
  coreSalience: "HIGH" | "LOW" | "MEDIUM" | "NONE";
  confidence: number;
  directness: "DIRECT" | "PARAPHRASED";
  displayText: string;
  dependencies: readonly MemoryFactCandidateDependency[];
  entities: readonly MemoryFactCandidateEntity[];
  evidence: readonly MemoryFactCandidateEvidence[];
  expectedAt: string | null;
  expiresAt: string | null;
  id: string;
  identityKind: "PROPOSITION" | "SLOT";
  identityVersion: "proposition-v1" | "slot-v2" | "slot-v3";
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
  occurredAt: string | null;
  predicateKey:
    | "constraint"
    | "employment_status"
    | "goal_status"
    | "preference"
    | "product_status"
    | "project_status"
    | "residence"
    | "routine"
    | null;
  proposedValue: unknown;
  rawTemporalExpression: string | null;
  reasonCode: null;
  scope: MemoryFactCandidateScope;
  sensitivity: "NORMAL";
  state: "PENDING";
  subjectKey: string | null;
  /** Set only by the transactional entity materializer before semantic apply. */
  subjectEntityId?: string | null;
  temporalResolutionEvidence: Readonly<Record<string, unknown>> | null;
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryFactExtractionPlan = Readonly<{
  candidateOrdinals: readonly number[];
  candidates: readonly MemoryExtractedCandidate[];
  input: MemoryFactExtractionInput;
  outputHash: string;
  rejections: readonly MemoryFactCandidateRejection[];
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
    !validIdentity(source.sourceMessageId) ||
    !validIdentity(source.userId) ||
    !validCounter(source.branchGeneration) ||
    !validCounter(source.memoryGenerationSnapshot) ||
    !validCounter(source.sourceRevision) ||
    !sha256Pattern.test(source.sourceHash)
  ) throw new Error("memory_fact_source_invalid");
  return `${MEMORY_FACT_EXTRACTION_JOB_PREFIX}${memorySha256({
    chatId: source.chatId,
    memoryGenerationSnapshot: source.memoryGenerationSnapshot,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    sourceMessageId: source.sourceMessageId,
    userId: source.userId
  })}`;
}

export function memoryFactExtractionClaimIsValid(
  job: MemoryJobDescriptor
): job is MemoryJobDescriptor & MemoryFactSourceIdentity {
  if (
    job.kind !== "EXTRACT_FACTS" ||
    job.pipelineVersion !== MEMORY_FACT_EXTRACTION_PIPELINE_VERSION ||
    job.activeLeafMessageId === null || job.branchGeneration === null ||
    job.chatId === null || job.sourceHash === null ||
    job.sourceMessageId === null || job.sourceRevision === null
  ) return false;
  const source: MemoryFactSourceIdentity = {
    activeLeafMessageId: job.activeLeafMessageId,
    branchGeneration: job.branchGeneration,
    chatId: job.chatId,
    memoryGenerationSnapshot: job.memoryGenerationSnapshot,
    sourceHash: job.sourceHash,
    sourceMessageId: job.sourceMessageId,
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
    candidateRef: _candidateRef,
    canonicalKey: _serverOwnedOpaqueKey,
    confidenceBand: _confidenceBand,
    correction: _correction,
    futureUseful: _futureUseful,
    quote: _quote,
    responsePreference: _responsePreference,
    statement: _statement,
    semanticFrame: _semanticFrame,
    temporalNormalization: _temporalNormalization,
    expirationIntent: _expirationIntent,
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

function memoryFactSemanticTarget(candidate: MemoryExtractedCandidate) {
  return {
    canonicalKey: candidate.canonicalKey,
    normalizedValue: memoryFactNormalizedValue(candidate)
  };
}

export function memoryFactNormalizedValue(candidate: MemoryExtractedCandidate) {
  return {
    expectedAt: candidate.expectedAt,
    expiresAt: candidate.expiresAt,
    occurredAt: candidate.occurredAt,
    structuredValue: candidate.proposedValue,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo
  };
}

/** Stable semantic-apply identity. Offsets are JavaScript string offsets and
 * therefore match the product's UTF-16 wire contract. */
export function memoryFactObservationFingerprint(
  input: MemoryFactExtractionInput,
  candidate: MemoryExtractedCandidate,
  evidence: MemoryFactCandidateEvidence
): string {
  return memorySha256({
    canonicalKey: candidate.canonicalKey,
    dependencies: candidate.dependencies.map((dependency) => ({
      dependencyKind: dependency.dependencyKind,
      source: dependency.source
    })),
    domain: "aiqsa.memory.observation",
    evidenceEnd: evidence.endOffset,
    evidenceStart: evidence.startOffset,
    normalizedValue: memoryFactNormalizedValue(candidate),
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    sourceMessageContentHash: evidence.sourceTextHash,
    sourceMessageId: evidence.messageId,
    userId: input.source.userId,
    version: 1
  });
}

/** Stable exact-support identity, deliberately distinct from semantic apply
 * identity so replay and reinforcement remain independently auditable. */
export function memoryFactEvidenceFingerprint(
  input: MemoryFactExtractionInput,
  candidate: MemoryExtractedCandidate,
  evidence: MemoryFactCandidateEvidence
): string {
  return memorySha256({
    domain: "aiqsa.memory.evidence",
    evidenceEnd: evidence.endOffset,
    evidenceStart: evidence.startOffset,
    sourceMessageContentHash: evidence.sourceTextHash,
    sourceMessageId: evidence.messageId,
    stance: "SUPPORTS",
    targetSemanticIdentity: memoryFactSemanticTarget(candidate),
    userId: input.source.userId,
    version: 1
  });
}

export function memoryFactExtractionOutputHash(
  input: MemoryFactExtractionInput,
  candidates: readonly MemoryExtractedCandidate[],
  candidateOrdinals: readonly number[],
  rejections: readonly MemoryFactCandidateRejection[]
): string {
  return memorySha256({
    candidateOrdinals,
    candidates,
    inputHash: input.inputHash,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    rejections
  });
}
