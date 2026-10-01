import type { MemoryJobDescriptor } from "../../coordinator/types";
import type { MemoryExecutionVersions } from "../../execution";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryTextLanguage } from "../../history/language";
import type { MemoryUsefulness } from "../../../../domain/memory/usefulness";
import { MEMORY_TEMPORAL_RESOLVER_VERSION } from "../temporal/resolver";
import {
  MEMORY_DEFAULT_IDENTITY_PROFILE,
  MEMORY_IDENTITY_PROFILES,
  type MemoryIdentityProfile
} from "../identity/normalization";

export const MEMORY_FACT_EXTRACTION_PIPELINE_VERSION =
  "memory-fact-extraction-vnext-v8";
export const MEMORY_FACT_EXTRACTION_POLICY_VERSION =
  "memory-fact-extraction-policy-v38";
export const MEMORY_FACT_EXTRACTION_PROMPT_VERSION =
  "memory-fact-extraction-prompt-v50";
export const MEMORY_FACT_EXTRACTION_SCHEMA_VERSION =
  "memory-fact-extraction-schema-v7";
export const MEMORY_FACT_TEMPORAL_RESOLVER_VERSION =
  MEMORY_TEMPORAL_RESOLVER_VERSION;
export const MEMORY_FACT_SOURCE_PROJECTION_VERSION =
  "memory-fact-source-projection-v5";
export const MEMORY_FACT_EXTRACTION_JOB_PREFIX = "extract-facts:vnext:";

/** Extraction and adjudication must agree on the scope of the same assertion. */
export const MEMORY_PERSONAL_SUBJECT_SCOPE_GUIDANCE =
  "The user's own action or experience has CURRENT_USER scope, including when another person or pet participates. A relationship to someone, or that person's or pet's own state or property, has USER_RELATIONSHIP_CONTEXT scope. Classify the asserted information, not merely the type or role of a mentioned entity. Reporting another subject's property does not turn it into the user's own state or action. Preserve the actor, recipient, and ownership roles without inferring possession.";

export const MEMORY_ASSERTED_PLAN_GUIDANCE =
  "A directly stated personal intention or commitment is an ASSERTED plan only when it describes the user's own future activity or durable goal beyond the present assistant task. Preserve its prerequisite and prospective wording in the proposition; the asserted fact is the user's plan, not that its condition is met or its future event has happened. Use PLAN with FUTURE perspective for that activity. A stated need or desired outcome that merely motivates a request for the assistant's immediate deliverable is task context, not an independent personal plan; preparing documents for a change does not establish a lasting plan to make that change. First-person necessity alone is insufficient. In a mixed message, retain an independently asserted scheduled activity or durable goal, including its date, but omit the assistant task and its motivating need. A possible future state never replaces an actual current residence, role, schedule, or ownership. An imagined example, question, or conditional possibility without a stated intention or commitment remains hypothetical; do not invent a plan from it.";

/** Extraction-only plan guidance. The shared asserted-plan wording above is
 * part of the semantic adjudication prompt and keeps its own version. */
export const MEMORY_FACT_EXTRACTION_PLAN_GUIDANCE =
  "A directly stated personal intention or commitment is retained only as a long-term goal or ongoing commitment of the user that lasts months or longer beyond the present assistant task, such as learning a language or completing a degree by a stated year; classify it ONGOING. A single scheduled activity, appointment, meeting, trip, purchase, errand, or deliverable due within days or weeks is SHORT_TERM, and a single dated occurrence is EPISODIC; neither is retained, including a dated vacation. Preserve a retained goal's prerequisite and prospective wording in the proposition; the asserted fact is the user's goal, not that its condition is met or its future event has happened. A stated need or desired outcome that merely motivates a request for the assistant's immediate deliverable is task context, not an independent personal plan; preparing documents for a change does not establish a lasting plan to make that change. First-person necessity alone is insufficient. In a mixed message, retain only the independently asserted long-term goal and omit the assistant task and its motivating need. A possible future state never replaces an actual current residence, role, schedule, or ownership. An imagined example, question, or conditional possibility without a stated intention or commitment remains hypothetical; do not invent a plan from it.";

/** Usefulness classes the extraction schema offers but never persists: they
 * give the model an honest exit instead of stretching a short matter into
 * ONGOING. Only DURABLE and ONGOING are stored on a new automatic version. */
export const MEMORY_FACT_EXTRACTION_REJECTED_USEFULNESS = Object.freeze([
  "EPISODIC", "SHORT_TERM", "COMMON", "TRANSIENT"
] as const);
export type MemoryFactExtractionRejectedUsefulness =
  (typeof MEMORY_FACT_EXTRACTION_REJECTED_USEFULNESS)[number];
export const MEMORY_FACT_EXTRACTION_RETAINED_USEFULNESS = Object.freeze([
  "DURABLE", "ONGOING"
] as const);
/** Product states that only describe a passing step toward ownership. */
export const MEMORY_FACT_TRANSITIONAL_PRODUCT_STATES = Object.freeze([
  "considering", "planned", "ordered"
] as const);
/** Product states that only end an existing ownership-like product fact. */
export const MEMORY_FACT_TERMINAL_PRODUCT_STATES = Object.freeze([
  "returned", "sold", "cancelled", "no_longer_owned"
] as const);
/** Why a candidate may only change an existing automatic fact: its rejected
 * usefulness class, or a terminal product status. Commit rejects it without a
 * live target (`change_target_missing`). Absent on retained v6 plans. */
export type MemoryFactChangeOnly =
  | MemoryFactExtractionRejectedUsefulness
  | "TERMINAL_PRODUCT_STATUS";

// Context is a bounded non-authoritative aid. The final direct-user target is
// the only evidence source; every admitted prior message is persisted as an
// immutable dependency when a candidate actually relies on it.
export const MEMORY_FACT_MAX_INPUT_MESSAGES = 6;
export const MEMORY_FACT_MAX_PRIOR_TURN_GROUPS = 2;
export const MEMORY_FACT_MAX_CONTEXT_MESSAGES = 6;
export const MEMORY_FACT_MAX_CONTEXT_CHARACTERS = 8_000;
export const MEMORY_FACT_MAX_TARGET_CHARACTERS = 24_000;
export const MEMORY_FACT_MAX_INPUT_CHARACTERS =
  MEMORY_FACT_MAX_TARGET_CHARACTERS + MEMORY_FACT_MAX_CONTEXT_CHARACTERS;
export const MEMORY_FACT_MAX_CONTEXT_REFS = 8;
/** One packet admits at most this many observations; a full packet is
 * continued from its coverage cursor instead of capping the source. */
export const MEMORY_FACT_MAX_PACKET_CANDIDATES = 8;
export const MEMORY_FACT_MAX_OUTPUT_CANDIDATES = MEMORY_FACT_MAX_PACKET_CANDIDATES;
export const MEMORY_FACT_MAX_ACCEPTED_CANDIDATES = MEMORY_FACT_MAX_OUTPUT_CANDIDATES;
export const MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE = 1;
/** Provider observations receive receipts up to this bound (a schema that
 * drops maxItems can exceed the packet); a longer packet is invalid output. */
export const MEMORY_FACT_MAX_RAW_OBSERVATIONS = 64;
/** One exact evidence reference, and the text shown after a page's core so
 * that every evidence span starting in the core is visible completely. */
export const MEMORY_FACT_MAX_EVIDENCE_CHARACTERS = 2_000;
/** A target longer than one input is read in pages. A page shows earlier text
 * of the same message for reading only, then its text; evidence belongs to the
 * page whose core contains its start, so pages never double-count a span. */
export const MEMORY_FACT_PAGE_PRECEDING_CHARACTERS = 2_000;
export const MEMORY_FACT_PAGE_TEXT_CHARACTERS =
  MEMORY_FACT_MAX_TARGET_CHARACTERS - MEMORY_FACT_PAGE_PRECEDING_CHARACTERS;
/** Provider pages of one source message. The page at this ordinal is never
 * dispatched: it records the uncovered remainder as a failed job. */
export const MEMORY_FACT_MAX_SOURCE_PAGES = 128;

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
  "CURRENT_USER" | "USER_RELATIONSHIP_CONTEXT" | "THIRD_PARTY" |
  "ASSISTANT" | "UNKNOWN";
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
    | "REPLACE_RELATIONSHIP_TARGET"
    | "MOVE_TO_DISTINCT_FACT"
    | "RETRACT_TARGET"
    | "AMBIGUOUS";
  reasonCode: string;
  /** Absent on retained decisions that did not adjudicate subject identity. */
  subjectIdentity?: "SAME_ENTITY" | "UNRESOLVED";
  subjectScope: MemorySemanticSubjectScope;
  targetRef: string | null;
  temporalPerspective: MemorySemanticTemporalPerspective;
}>;

export type MemoryFactCandidateRejection = Readonly<{
  candidateOrdinal: number;
  reasonCode:
    | "REJECT_AMBIGUOUS"
    | "REJECT_DUPLICATE"
    | "REJECT_EVIDENCE_INVALID"
    | "REJECT_EVIDENCE_NOT_IN_TARGET"
    | "REJECT_ENTITY_UNSUPPORTED"
    | "REJECT_DEPENDENCY_UNSUPPORTED"
    | "REJECT_FRAME_INELIGIBLE"
    | "REJECT_IDENTITY_INVALID"
    | "REJECT_LOW_CONFIDENCE"
    | "REJECT_NOT_USEFUL"
    /** Evidence starts outside this page's core; its own page covers it. */
    | "REJECT_OUTSIDE_PAGE"
    /** Beyond a full packet: the continuation page resumes at its evidence,
     * or, sharing one evidence start with a full packet, it is not retried. */
    | "REJECT_PACKET_OVERFLOW"
    | "REJECT_SECRET"
    | "REJECT_PRODUCT_IDENTITY_UNSUPPORTED"
    | "REJECT_RESIDENCE_IDENTITY_UNSUPPORTED"
    | "REJECT_STATE_UNSUPPORTED"
    | "REJECT_STALE_SOURCE"
    | "REJECT_TEMPORARY"
    | "REJECT_TEMPORAL_UNSUPPORTED"
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
    maxEvidenceCharacters: MEMORY_FACT_MAX_EVIDENCE_CHARACTERS,
    maxEvidencePerCandidate: MEMORY_FACT_MAX_EVIDENCE_PER_CANDIDATE,
    maxInputCharacters: MEMORY_FACT_MAX_INPUT_CHARACTERS,
    maxInputMessages: MEMORY_FACT_MAX_INPUT_MESSAGES,
    maxPriorTurnGroups: MEMORY_FACT_MAX_PRIOR_TURN_GROUPS,
    maxRawObservations: MEMORY_FACT_MAX_RAW_OBSERVATIONS,
    maxSourcePages: MEMORY_FACT_MAX_SOURCE_PAGES,
    maxTargetCharacters: MEMORY_FACT_MAX_TARGET_CHARACTERS,
    pagePrecedingCharacters: MEMORY_FACT_PAGE_PRECEDING_CHARACTERS,
    pageTextCharacters: MEMORY_FACT_PAGE_TEXT_CHARACTERS,
    version: 4
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

/** Only settled outputs and ambiguous calls may retain this exact contract.
 * New dispatches always use the current long-term schema; a retained staged
 * plan applies with its recorded semantics and no change-only marker. */
export const MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS: MemoryExecutionVersions =
  Object.freeze({
    ...MEMORY_FACT_EXTRACTION_VERSIONS,
    policyVersion: "memory-fact-extraction-policy-v37",
    promptVersion: "memory-fact-extraction-prompt-v49",
    schemaVersion: "memory-fact-extraction-schema-v6"
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

/** One page of a long target. The target message's text, redaction spans and
 * evidence offsets inside the input are page-local; evidence is persisted at
 * `coreStart + offset` of the full safe text and hashed as the full text
 * (`contentHash`), so exact-evidence proofs never depend on paging. */
export type MemoryFactTargetPage = Readonly<{
  /** Full-text offset where this page's evidence responsibility ends. */
  coreEnd: number;
  /** Full-text offset of the first character of the page text. */
  coreStart: number;
  ordinal: number;
  /** Earlier text of the same message, shown for reading only. */
  precedingText: string;
  /** Length of the full projected safe text. */
  sourceLength: number;
  /** The projection withheld some source text unscanned (PARTIAL). */
  sourceUnprocessed: boolean;
}>;

export type MemoryFactExtractionInput = Readonly<{
  contextRefs: readonly MemoryFactContextRef[];
  folderId: string | null;
  identityProfile: MemoryIdentityProfile;
  inputHash: string;
  messages: readonly MemoryFactInputMessage[];
  source: MemoryFactSourceIdentity;
  sourceProjectionHash: string;
  sourceProjectionVersion: typeof MEMORY_FACT_SOURCE_PROJECTION_VERSION;
  suppressionIdentitySnapshot: string;
  /** Absent when the whole target is one input. */
  targetPage?: MemoryFactTargetPage;
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
  /** Present only on retained outputs predating schema v7. */
  futureUseful?: boolean;
  /** Absent on outputs predating selective admission and when a v7 candidate
   * passes with a rejected class (change-only or explicit remember). */
  usefulness?: MemoryUsefulness;
  changeOnly?: MemoryFactChangeOnly;
  /** Server-derived routing metadata; fallback must retain SLOT adjudication. */
  proposedIdentityKind?: "PROPOSITION" | "SLOT";
  /** Unsupported optional entity metadata was discarded; require HIGH entailment. */
  entityAnnotationReviewRequired?: boolean;
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
  identityProfile: MemoryIdentityProfile;
  identityKind: "PROPOSITION" | "SLOT";
  identityVersion:
    | "proposition-v1"
    | "proposition-v2"
    | "slot-v2"
    | "slot-v3"
    | "slot-v4";
  importance: number;
  languageCode: MemoryTextLanguage;
  /** Opaque values present only in already accepted historical outputs. */
  legacyCanonicalKey?: string;
  legacyProposedValue?: unknown;
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
  unicodeCanonicalKey: string;
  unicodeProposedValue: unknown;
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryFactExtractionPlan = Readonly<{
  candidateOrdinals: readonly number[];
  candidates: readonly MemoryExtractedCandidate[];
  /** Full-text offset covered by a full packet; absent when the packet
   * covered the whole page core. The next page starts here. */
  coverageEnd?: number;
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

/** Coverage position of one extraction job over its source message. Page 0
 * starts at offset 0; each later page starts at the coverage cursor its
 * predecessor committed. */
export type MemoryFactJobPage = Readonly<{
  cursor: number;
  ordinal: number;
}>;

export const MEMORY_FACT_FIRST_PAGE: MemoryFactJobPage = Object.freeze({
  cursor: 0,
  ordinal: 0
});

const pageFingerprintPattern = new RegExp(
  `^${MEMORY_FACT_EXTRACTION_JOB_PREFIX}p([1-9][0-9]{0,2})\\.([1-9][0-9]{0,9}):[a-f0-9]{64}$`,
  "u"
);

function validPage(page: MemoryFactJobPage): boolean {
  return Number.isSafeInteger(page.ordinal) && page.ordinal >= 0 &&
    page.ordinal <= MEMORY_FACT_MAX_SOURCE_PAGES && validCounter(page.cursor) &&
    (page.ordinal === 0) === (page.cursor === 0);
}

export function memoryFactExtractionJobFingerprint(
  source: MemoryFactSourceIdentity,
  identityProfile: MemoryIdentityProfile = MEMORY_DEFAULT_IDENTITY_PROFILE,
  page: MemoryFactJobPage = MEMORY_FACT_FIRST_PAGE
): string {
  if (
    !validIdentity(source.activeLeafMessageId) ||
    !validIdentity(source.chatId) ||
    !validIdentity(source.sourceMessageId) ||
    !validIdentity(source.userId) ||
    !validCounter(source.branchGeneration) ||
    !validCounter(source.memoryGenerationSnapshot) ||
    !validCounter(source.sourceRevision) ||
    !sha256Pattern.test(source.sourceHash) ||
    !validPage(page)
  ) throw new Error("memory_fact_source_invalid");
  const identity = {
    chatId: source.chatId,
    memoryGenerationSnapshot: source.memoryGenerationSnapshot,
    identityProfile,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    sourceMessageId: source.sourceMessageId,
    userId: source.userId
  };
  // Page 0 keeps the established job identity, so admission and identity
  // cutover still create exactly one first page per source message.
  if (page.ordinal === 0) {
    return `${MEMORY_FACT_EXTRACTION_JOB_PREFIX}${memorySha256(identity)}`;
  }
  return `${MEMORY_FACT_EXTRACTION_JOB_PREFIX}p${page.ordinal}.${page.cursor}:` +
    memorySha256({ ...identity, page: { cursor: page.cursor, ordinal: page.ordinal } });
}

function claimedPage(job: MemoryJobDescriptor): MemoryFactJobPage | null {
  const match = pageFingerprintPattern.exec(job.idempotencyFingerprint);
  if (!match) return MEMORY_FACT_FIRST_PAGE;
  const page = { cursor: Number(match[2]), ordinal: Number(match[1]) };
  return validPage(page) ? page : null;
}

/** The identity profile and page proven by the job's own fingerprint. */
export function memoryFactExtractionJobIdentity(
  job: MemoryJobDescriptor
): Readonly<{ identityProfile: MemoryIdentityProfile; page: MemoryFactJobPage }> | null {
  const page = claimedPage(job);
  if (!page) return null;
  for (const profile of MEMORY_IDENTITY_PROFILES) {
    try {
      if (job.idempotencyFingerprint === memoryFactExtractionJobFingerprint(
        {
          activeLeafMessageId: job.activeLeafMessageId!,
          branchGeneration: job.branchGeneration!,
          chatId: job.chatId!,
          memoryGenerationSnapshot: job.memoryGenerationSnapshot,
          sourceHash: job.sourceHash!,
          sourceMessageId: job.sourceMessageId!,
          sourceRevision: job.sourceRevision!,
          userId: job.userId
        },
        profile,
        page
      )) return { identityProfile: profile, page };
    } catch {
      return null;
    }
  }
  return null;
}

export function memoryFactExtractionIdentityProfile(
  job: MemoryJobDescriptor
): MemoryIdentityProfile | null {
  return memoryFactExtractionJobIdentity(job)?.identityProfile ?? null;
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
  return memoryFactExtractionIdentityProfile({ ...job, ...source }) !== null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff && isHighSurrogate(text.charCodeAt(offset - 1));
}

/** A page boundary never splits a UTF-16 surrogate pair. */
export function memoryFactPageBoundaryAfter(text: string, offset: number): number {
  return splitsSurrogatePair(text, offset) ? offset + 1 : offset;
}

function pageBoundaryBefore(text: string, offset: number): number {
  return splitsSurrogatePair(text, offset) ? offset - 1 : offset;
}

export type MemoryFactTargetView =
  | Readonly<{ kind: "WHOLE" }>
  | Readonly<{ kind: "PAGE"; page: MemoryFactTargetPage; text: string }>
  /** The cursor reached the end: only an unprocessed remainder is left. */
  | Readonly<{ kind: "COVERED" }>
  | Readonly<{ kind: "INVALID" }>;

/** Deterministic page geometry of one job over the full projected safe text.
 * A target that fits one input stays whole on page 0. Otherwise the page
 * text runs from the cursor for MEMORY_FACT_PAGE_TEXT_CHARACTERS, and its core
 * ends one evidence length before the text does (or at the end of the
 * message), so every span starting in the core is shown completely. */
export function memoryFactTargetView(
  safeText: string,
  page: MemoryFactJobPage,
  sourceUnprocessed: boolean
): MemoryFactTargetView {
  const length = safeText.length;
  if (page.ordinal === 0 && length <= MEMORY_FACT_MAX_TARGET_CHARACTERS) {
    return { kind: "WHOLE" };
  }
  if (!validPage(page) || page.cursor > length ||
    splitsSurrogatePair(safeText, page.cursor)) return { kind: "INVALID" };
  if (page.cursor === length) {
    return page.ordinal > 0 ? { kind: "COVERED" } : { kind: "INVALID" };
  }
  const textEnd = Math.max(
    page.cursor + 1,
    pageBoundaryBefore(
      safeText,
      Math.min(length, page.cursor + MEMORY_FACT_PAGE_TEXT_CHARACTERS)
    )
  );
  const coreEnd = textEnd === length
    ? length
    : memoryFactPageBoundaryAfter(
        safeText,
        textEnd - MEMORY_FACT_MAX_EVIDENCE_CHARACTERS
      );
  const precedingStart = memoryFactPageBoundaryAfter(
    safeText,
    Math.max(0, page.cursor - MEMORY_FACT_PAGE_PRECEDING_CHARACTERS)
  );
  return {
    kind: "PAGE",
    page: {
      coreEnd,
      coreStart: page.cursor,
      ordinal: page.ordinal,
      precedingText: safeText.slice(precedingStart, page.cursor),
      sourceLength: length,
      sourceUnprocessed
    },
    text: safeText.slice(page.cursor, textEnd)
  };
}

/** The page that continues coverage after this input, or null once the source
 * is covered. An unprocessed remainder or the exhausted page budget still
 * yields a page, which is never dispatched and records the gap as failed. */
export function memoryFactNextPage(
  input: MemoryFactExtractionInput,
  coverageEnd?: number
): MemoryFactJobPage | null {
  const target = input.messages.find((message) =>
    message.evidenceEligible && message.id === input.source.sourceMessageId);
  if (!target) return null;
  const page = input.targetPage;
  const length = page?.sourceLength ?? target.text.length;
  const start = page?.coreStart ?? 0;
  const end = coverageEnd ?? page?.coreEnd ?? length;
  const ordinal = (page?.ordinal ?? 0) + 1;
  if (ordinal > MEMORY_FACT_MAX_SOURCE_PAGES || end <= start) return null;
  if (end < length) return { cursor: end, ordinal };
  return page?.sourceUnprocessed ? { cursor: length, ordinal } : null;
}

/** Full-text offset of the target text shown in this input. */
export function memoryFactTargetTextOffset(input: MemoryFactExtractionInput): number {
  return input.targetPage?.coreStart ?? 0;
}

/** The source hash exact evidence records: always the full projected text. */
export function memoryFactTargetSourceHash(
  input: MemoryFactExtractionInput,
  message: MemoryFactInputMessage
): string {
  return input.targetPage ? message.contentHash : memorySha256(message.text);
}

export function memoryFactExtractionInputHash(
  input: Omit<MemoryFactExtractionInput, "inputHash">,
  versions: Pick<MemoryExecutionVersions,
    "policyVersion" | "promptVersion" | "schemaVersion"> = MEMORY_FACT_EXTRACTION_VERSIONS
): string {
  return memorySha256({
    ...input,
    policyVersion: versions.policyVersion,
    promptVersion: versions.promptVersion,
    schemaVersion: versions.schemaVersion
  });
}

/** Revalidate every source field under the accepted contract without changing
 * its frozen hash or treating the current policy as authority to replay it. */
export function memoryFactExtractionRetainedInput(
  input: MemoryFactExtractionInput,
  acceptedInputHash: string
): MemoryFactExtractionInput | null {
  if (input.inputHash === acceptedInputHash) return input;
  const { inputHash: _inputHash, ...source } = input;
  return memoryFactExtractionInputHash(source, MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS) ===
    acceptedInputHash
    ? { ...input, inputHash: acceptedInputHash }
    : null;
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
    usefulness: _usefulness,
    changeOnly: _changeOnly,
    proposedIdentityKind: _proposedIdentityKind,
    entityAnnotationReviewRequired: _entityAnnotationReviewRequired,
    quote: _quote,
    responsePreference: _responsePreference,
    statement: _statement,
    semanticFrame: _semanticFrame,
    temporalNormalization: _temporalNormalization,
    expirationIntent: _expirationIntent,
    identityProfile: _identityProfile,
    legacyCanonicalKey: _legacyCanonicalKey,
    legacyProposedValue: _legacyProposedValue,
    temporary: _temporary,
    unicodeCanonicalKey: _unicodeCanonicalKey,
    unicodeProposedValue: _unicodeProposedValue,
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
  rejections: readonly MemoryFactCandidateRejection[],
  coverageEnd?: number
): string {
  return memorySha256({
    candidateOrdinals,
    candidates,
    ...(coverageEnd === undefined ? {} : { coverageEnd }),
    inputHash: input.inputHash,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    rejections
  });
}
