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

export {
  MEMORY_RETRIEVAL_MODES,
  MEMORY_TEMPORAL_INTENTS
} from "../../../contracts/memoryRetrieval";
export type {
  MemoryRetrievalMode,
  MemoryTemporalIntent
} from "../../../contracts/memoryRetrieval";

export type MemoryRetrievalItemType = "FACT_VERSION" | "RECALL_CHUNK";
export type MemoryRetrievalDirectness = "DIRECT" | "INFERRED" | "PARAPHRASED";
export type MemoryRetrievalTemperatureClass = "COLD" | "HOT" | "WARM";
export type MemoryRetrievalHistorySafetyClass =
  | "HIGHLY_SENSITIVE"
  | "NORMAL"
  | "SECRET_TAINTED"
  | "SENSITIVE";

export type MemoryRetrievalSourceKind = "EVENT" | "FACT" | "HISTORY";

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
  /** Allows only the narrow query-independent response-preference projection. */
  applyResponsePreferences: boolean;
  /** Exact query occurrences; resolved refs remain non-authoritative owner-scoped hints. */
  entityMentions: readonly MemoryRetrievalEntityMention[];
  filters: MemoryRetrievalFilters;
  /** Admits depth-one synthesis patterns for an explicitly authorized targeted query. */
  includePatterns: boolean;
  lexicalQuery: string | null;
  mode: MemoryRetrievalMode;
  normalizedExactQuery: string;
  normalizedQuery: string;
  plannerVersion: string;
  /** Broad, System-Model-authorized inventory of current Personal Memory facts. */
  profileRequested: boolean;
  queryPresent: boolean;
  recencyRequested: boolean;
  temporalIntent: MemoryTemporalIntent;
}>;

export type MemoryRetrievalPlannerInput = Readonly<{
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
  temporalIntent?: MemoryTemporalIntent;
}>;

export type MemoryMatchedEntityRole = "MENTION" | "OBJECT" | "SUBJECT";
export type MemoryRetrievalSourceAuthority =
  | "DIRECT_AUTOMATIC"
  | "EXPLICIT"
  | "PAST_CHAT"
  | "SYNTHESIS";

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
  itemId: string;
  itemType: MemoryRetrievalItemType;
  laneRanks: Readonly<Partial<Record<MemoryRetrievalLane, number>>>;
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
  "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
] as const;

export type MemorySafeProjectionKind = (typeof MEMORY_SAFE_PROJECTION_KINDS)[number];

export type MemoryExpandedCandidate = Readonly<{
  itemId: string;
  itemType: MemoryRetrievalItemType;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  projectionKind: MemorySafeProjectionKind;
  safeText: string;
  sourceChatId: string | null;
  supportingItemId: string | null;
}>;

export type MemoryPackedItem = Readonly<{
  exactSafeText: string;
  finalScore: number;
  itemId: string;
  itemType: MemoryRetrievalItemType;
  projectionKind: MemorySafeProjectionKind;
  section: "CORE" | "FACT" | "HISTORICAL_FACT" | "HISTORY" | "PATTERN";
  sourceChatId: string | null;
  supportingItemId: string | null;
  temporalReason: "any" | "as_of" | "between" | "current" | "historical";
  tier: "CORE" | "DYNAMIC";
}>;

export type MemoryContextPack = Readonly<{
  approxTokens: number;
  candidateCount: number;
  coreTokens: number;
  hardCapTokens: number;
  items: readonly MemoryPackedItem[];
  omissionCounts: Readonly<Record<string, number>>;
  packerVersion: string;
  targetTokens: number;
  text: string | null;
}>;
