import type {
  MemoryModality,
  MemoryScopeType,
  MemorySensitivityClass,
  MemorySourceMode
} from "../../../contracts/memory";
import type {
  MemoryRetrievalMode,
  MemoryTemporalIntent
} from "../../../contracts/memoryRetrieval";
import type { MemoryRetrievalLane } from "./config";
import type { MemoryTemporalQueryParseResult } from "./temporal";

export {
  MEMORY_RETRIEVAL_MODES,
  MEMORY_TEMPORAL_INTENTS
} from "../../../contracts/memoryRetrieval";
export type {
  MemoryRetrievalMode,
  MemoryTemporalIntent
} from "../../../contracts/memoryRetrieval";

export type MemoryRetrievalItemType =
  | "FACT_VERSION"
  | "RECALL_CHUNK"
  | "RECALL_ROUND"
  | "TOOL_EVENT";
export type MemoryRecallRoundSegmentPosition =
  | "MIDDLE"
  | "PREFIX"
  | "SINGLE"
  | "SUFFIX";
export type MemoryRetrievalDirectness = "DIRECT" | "INFERRED" | "PARAPHRASED";
export type MemoryRetrievalTemperatureClass = "COLD" | "HOT" | "WARM";
export type MemoryRetrievalHistorySafetyClass =
  | "HIGHLY_SENSITIVE"
  | "NORMAL"
  | "SECRET_TAINTED"
  | "SENSITIVE";

export type MemoryRetrievalSourceKind = "EVENT" | "FACT" | "HISTORY";

export type MemorySemanticQueryVariantKind =
  | "DECOMPOSED"
  | "ENTITY_EXPANSION"
  | "ORIGINAL"
  | "PLANNER_REWRITE";

export type MemoryTemporalQueryVariantKind = "FILTERED" | "UNRESTRICTED";

export type MemorySemanticQueryVariant = Readonly<{
  kind: MemorySemanticQueryVariantKind;
  text: string;
}>;

export type MemoryTemporalQueryVariant = Readonly<{
  kind: MemoryTemporalQueryVariantKind;
  text: string;
}>;

export type MemoryRetrievalEntityMention = Readonly<{
  occurrenceIndex: number;
  resolvedRef: string | null;
  text: string;
}>;

export type MemoryDeterministicMatch =
  | "EXACT_ALIAS_SINGLE_ROOT"
  | "EXACT_TEXT"
  | "PROFILE";

export type MemoryRetrievalFilters = Readonly<{
  asOf: Date | null;
  from: Date | null;
  /** Exact owner-validated target for an optional typed scope filter. */
  scopeTargetId: string | null;
  scopeType: MemoryScopeType | null;
  sourceKinds: readonly MemoryRetrievalSourceKind[];
  to: Date | null;
}>;

export type MemoryRetrievalPlan = Readonly<{
  /** Requests bounded evidence breadth across multiple independent sources. */
  aggregationRequested: boolean;
  /** Sanitized planner restatement of the requested answer relation; never evidence. */
  answerFocus: string | null;
  /** Allows only the narrow query-independent response-preference projection. */
  applyResponsePreferences: boolean;
  /** Exact query occurrences; resolved refs remain non-authoritative owner-scoped hints. */
  entityMentions: readonly MemoryRetrievalEntityMention[];
  filters: MemoryRetrievalFilters;
  /** Admits lower-authority depth-one patterns under server-owned targeted-read policy. */
  includePatterns: boolean;
  lexicalQuery: string | null;
  mode: MemoryRetrievalMode;
  normalizedExactQuery: string;
  normalizedQuery: string;
  /** Locally redacted, bounded direct current-turn query; never a model rewrite. */
  originalSanitizedQuery: string;
  plannerVersion: string;
  /** Broad, System-Model-authorized inventory of current Personal Memory facts. */
  profileRequested: boolean;
  queryPresent: boolean;
  recencyRequested: boolean;
  /** Bounded, deterministic bundle. ORIGINAL is always first when a query exists. */
  semanticQueryVariants: readonly MemorySemanticQueryVariant[];
  temporalIntent: MemoryTemporalIntent;
  /** Local deterministic interpretation; it cannot be removed by model planning. */
  temporalQuery: MemoryTemporalQueryParseResult;
  temporalQueryVariants: readonly MemoryTemporalQueryVariant[];
}>;

export const MEMORY_SOURCE_FAMILY_HARD_EXCLUSION_REASONS = [
  "FACTS_SETTING_DISABLED",
  "HISTORY_SETTING_DISABLED",
  "EXPLICIT_SOURCE_FILTER_FACTS",
  "EXPLICIT_SOURCE_FILTER_HISTORY",
  "MUTATION_ONLY_READ_EXCLUDED",
  "PROFILE_OPERATION_HISTORY_EXCLUDED",
  "RESPONSE_PREFERENCE_ONLY_DYNAMIC_EXCLUDED",
  "SOURCE_FAMILY_AUTHORITY_UNAVAILABLE"
] as const;

export type MemorySourceFamilyHardExclusionReason =
  (typeof MEMORY_SOURCE_FAMILY_HARD_EXCLUSION_REASONS)[number];

/** Server-owned two-tier ordinary-read contract. Model planning may enrich
 * retrieval but cannot remove a family admitted by the baseline plan. */
export type MemoryRetrievalPlanBundle = Readonly<{
  baseline: MemoryRetrievalPlan | null;
  enriched: MemoryRetrievalPlan;
  hardExclusionReasons: readonly MemorySourceFamilyHardExclusionReason[];
}>;

export type MemoryRetrievalPlannerInput = Readonly<{
  aggregationRequested?: boolean;
  allowedEntityRefs?: readonly string[];
  applyResponsePreferences?: boolean;
  currentUserText: string;
  entityMentions?: readonly MemoryRetrievalEntityMention[];
  filters?: Partial<MemoryRetrievalFilters>;
  includePatterns?: boolean;
  mode?: MemoryRetrievalMode;
  now: Date;
  profileRequested?: boolean;
  recencyRequested?: boolean;
  semanticDecompositions?: readonly string[];
  semanticRewrite?: string | null;
  temporalIntent?: MemoryTemporalIntent;
  /** Accepted request zone; UTC is the deterministic fallback. */
  timeZone?: string;
}>;

export type MemoryMatchedEntityRole = "MENTION" | "OBJECT" | "SUBJECT";
export type MemoryRetrievalSourceAuthority =
  | "DIRECT_AUTOMATIC"
  | "EXPLICIT"
  | "PAST_CHAT"
  | "SYNTHESIS"
  | "TOOL_OBSERVATION";

export type MemoryCandidateMetadata = Readonly<{
  canonicalKey: string | null;
  category: string | null;
  confidence: number;
  conflict: boolean;
  coreEligible: boolean;
  coreSalience: "HIGH" | "LOW" | "MEDIUM" | "NONE";
  current: boolean;
  dedupeKey: string;
  directness: MemoryRetrievalDirectness | null;
  dimensionKey: string | null;
  entityIds: readonly string[];
  /** Exact ordered-message-set identity shared by equivalent history projections. */
  evidenceRootHash?: string | null;
  expectedAt: Date | null;
  expiresAt: Date | null;
  factId: string | null;
  historical: boolean;
  historySafetyClass: MemoryRetrievalHistorySafetyClass | null;
  importance: number;
  identityKind: "PROPOSITION" | "SLOT" | null;
  languageCode: string;
  lastConfirmedAt: Date | null;
  lastUsedAt: Date | null;
  lifecycleState: "ACTIVE" | "SUPERSEDED" | null;
  matchedEntityRole: MemoryMatchedEntityRole | null;
  modality: MemoryModality | null;
  observedAt: Date | null;
  occurredAt: Date | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  pinned: boolean;
  parentChunkId?: string | null;
  predicateKey: string | null;
  relationDepth: number;
  scopeAffinity: number;
  scopeType: MemoryScopeType | null;
  sensitivityClass: MemorySensitivityClass | null;
  sourceAssistantId: string | null;
  sourceChatId: string | null;
  sourceFolderId: string | null;
  sourceMode: MemorySourceMode | null;
  sourceAuthority: MemoryRetrievalSourceAuthority;
  subjectKey: string | null;
  synthesisDepth: number;
  systemFrom: Date | null;
  temperatureClass: MemoryRetrievalTemperatureClass | null;
  temperatureScore: number;
  validFrom: Date | null;
  validTo: Date | null;
}>;

export type MemoryLaneCandidate = Readonly<{
  deterministicMatch?: MemoryDeterministicMatch | null;
  entryId: string | null;
  hardFilterPassed: boolean;
  itemId: string;
  itemType: MemoryRetrievalItemType;
  lane: MemoryRetrievalLane;
  /** Private index identity; browser/run-facing identity remains itemId. */
  matchedSegmentId?: string | null;
  matchedSegmentPosition?: MemoryRecallRoundSegmentPosition | null;
  metadata: MemoryCandidateMetadata;
  rawScore: number;
}>;

export type MemoryLaneResult = Readonly<{
  candidates: readonly MemoryLaneCandidate[];
  lane: MemoryRetrievalLane;
}>;

export type MemoryRetrievalFeatureSnapshot = Readonly<{
  authorityRank: number;
  decayAdjustedScore?: number;
  decayAnchor?: "LAST_CONFIRMED" | "LAST_USED" | "OBSERVED" | "OCCURRED" |
    "SYSTEM_FROM" | null;
  decayFactor?: number;
  decayPolicyVersion?: string;
  deterministicMatches?: readonly MemoryDeterministicMatch[];
  directFactAuthority?: boolean;
  fusionVersion: string;
  laneCount: number;
  temporalFit: number;
  tier: "CORE" | "DYNAMIC";
}>;

export type MemoryRankedCandidate = Readonly<{
  entryId: string | null;
  featureSnapshot: MemoryRetrievalFeatureSnapshot;
  finalScore: number;
  /**
   * A bounded authoritative view requested only after a source session has
   * already been selected. Ordinary retrieval keeps the complete projection;
   * USER_TESTIMONY retains exact user-authored spans for episodic expansion.
   */
  historyEvidenceView?: "USER_TESTIMONY";
  itemId: string;
  itemType: MemoryRetrievalItemType;
  laneRanks: Readonly<Partial<Record<MemoryRetrievalLane, number>>>;
  /** Private index identity used for exact expansion and run revalidation. */
  matchedSegmentId?: string | null;
  matchedSegmentPosition?: MemoryRecallRoundSegmentPosition | null;
  metadata: MemoryCandidateMetadata;
  rrfScore: number;
  selectionReason: string;
}>;

export type MemoryCoreCandidate = Readonly<{
  candidate: MemoryRankedCandidate;
  expansion: MemoryExpandedCandidate;
}>;

export const MEMORY_SAFE_PROJECTION_KINDS = [
  "CHAT_DIGEST_SAFE_TEXT",
  "FACT_DISPLAY_TEXT",
  "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
  "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
  "RECALL_ROUND_RAW_SAFE_TEXT",
  "TOOL_EVENT_SAFE_TEXT"
] as const;

export type MemorySafeProjectionKind = (typeof MEMORY_SAFE_PROJECTION_KINDS)[number];

export type MemoryPackedEvidenceType =
  | "current_fact"
  | "derived_session_synopsis"
  | "historical_fact"
  | "pattern"
  | "raw_chunk"
  | "raw_round"
  | "supporting_observation"
  | "tool_observation";

export type MemoryPackedSourceAuthority =
  | "derived_pattern"
  | "learned_from_user"
  | "past_chat"
  | "supporting_observation"
  | "tool_observation"
  | "user_saved";

export type MemoryPackedSpeakerScope =
  | "derived"
  | "mixed_conversation"
  | "tool"
  | "user";

export type MemoryPackedStatus = "current" | "historical" | "superseded";

export type MemoryContextBudgetProfile = "COMPLEX" | "PAST_CHAT" | "SIMPLE";

export type MemoryExpandedCandidate = Readonly<{
  itemId: string;
  itemType: MemoryRetrievalItemType;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  projectionKind: MemorySafeProjectionKind;
  patternSupportingEvidence?: readonly Readonly<{
    itemId: string;
    observedAt: Date;
    safeText: string;
    sourceAuthority: "DIRECT_AUTOMATIC" | "EXPLICIT";
    sourceChatId: string | null;
    sourceRootHash: string;
  }>[];
  retrievalHint?: string | null;
  safeText: string;
  sourceChatId: string | null;
  supportingEvidence?: readonly Readonly<{
    itemId: string;
    occurredFrom: Date;
    occurredTo: Date;
    safeText: string;
    sourceChatId: string;
  }>[];
  supportingItemId: string | null;
}>;

export type MemoryPackedItem = Readonly<{
  derived: boolean;
  documentTime: string | null;
  eventTimeEnd: string | null;
  eventTimeStart: string | null;
  evidenceHandle: string;
  evidenceType: MemoryPackedEvidenceType;
  exactSafeText: string;
  finalScore: number;
  itemId: string;
  itemType: MemoryRetrievalItemType;
  lastConfirmedAt: string | null;
  observedAt: string | null;
  patternSupportingEvidence?: readonly Readonly<{
    documentTime: string;
    itemId: string;
    rawSafeText: string;
    sourceAuthority: "learned_from_user" | "user_saved";
    sourceRootHash: string;
    sourceSessionHandle: string;
  }>[];
  projectionKind: MemorySafeProjectionKind;
  rawSafeText: string;
  retrievalHint?: string | null;
  retrievalReason: "exact" | "fused" | "profile" | "semantic_sort";
  section: "CORE" | "FACT" | "HISTORICAL_FACT" | "HISTORY" | "PATTERN";
  sourceAuthority: MemoryPackedSourceAuthority;
  sourceChatId: string | null;
  sourceSessionHandle: string | null;
  speakerScope: MemoryPackedSpeakerScope;
  recordStatus: MemoryPackedStatus;
  supportingEvidence?: readonly Readonly<{
    documentTime: string;
    itemId: string;
    rawSafeText: string;
    sourceSessionHandle: string;
  }>[];
  supportingItemId: string | null;
  temporalReason: "any" | "as_of" | "between" | "current" | "historical";
  tier: "CORE" | "DYNAMIC";
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryContextPack = Readonly<{
  approxTokens: number;
  budgetProfile: MemoryContextBudgetProfile;
  candidateCount: number;
  coreTokens: number;
  hardCapTokens: number;
  items: readonly MemoryPackedItem[];
  omissionCounts: Readonly<Record<string, number>>;
  packerVersion: string;
  providerTokenLimit: number | null;
  targetTokens: number;
  text: string | null;
}>;
