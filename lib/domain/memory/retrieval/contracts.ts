import type {
  MemoryModality,
  MemoryScopeType,
  MemorySensitivityClass,
  MemorySourceMode
} from "../../../contracts/memory";
import type { MemoryRetrievalLane } from "./config";

export type MemoryRetrievalItemType = "EPISODE" | "FACT_VERSION" | "RECALL_CHUNK";
export type MemoryRetrievalDirectness = "DIRECT" | "INFERRED" | "PARAPHRASED";
export type MemoryRetrievalTemperatureClass = "COLD" | "HOT" | "WARM";
export type MemoryRetrievalHistorySafetyClass =
  | "HIGHLY_SENSITIVE"
  | "NORMAL"
  | "SECRET_TAINTED"
  | "SENSITIVE";

export const MEMORY_RETRIEVAL_INTENTS = [
  "NONE",
  "PERSONALIZE",
  "PAST_HISTORY",
  "CURRENT_STATE",
  "TEMPORAL",
  "MEMORY_MANAGEMENT"
] as const;

export type MemoryRetrievalIntent = (typeof MEMORY_RETRIEVAL_INTENTS)[number];
export type MemoryRetrievalLanguage = "EN" | "MIXED" | "OTHER" | "RU";
export type MemoryTemporalMode = "AMBIGUOUS" | "CURRENT" | "HISTORICAL" | "RANGE";

export type MemoryTemporalQuery = Readonly<{
  from: Date | null;
  mode: MemoryTemporalMode;
  rawExpressions: readonly string[];
  resolverVersion: string;
  to: Date | null;
}>;

export type MemoryRetrievalPlan = Readonly<{
  canonicalKeyHints: readonly string[];
  entityHints: readonly string[];
  intent: MemoryRetrievalIntent;
  language: MemoryRetrievalLanguage;
  normalizedQuery: string;
  normalizedYoQuery: string;
  plannerVersion: string;
  queryTerms: readonly string[];
  retrievalAllowed: boolean;
  temporal: MemoryTemporalQuery;
  usedPriorUserTurns: number;
}>;

export type MemoryRetrievalPlannerInput = Readonly<{
  currentUserText: string;
  explicitMemoryManagement?: boolean;
  now: Date;
  priorDirectUserTexts?: readonly string[];
  timeZone?: string;
}>;

export type MemoryCandidateMetadata = Readonly<{
  canonicalKey: string | null;
  category: string | null;
  confidence: number;
  conflict: boolean;
  current: boolean;
  dedupeKey: string;
  directness: MemoryRetrievalDirectness | null;
  factId: string | null;
  historical: boolean;
  importance: number;
  languageCode: string;
  modality: MemoryModality | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  pinned: boolean;
  scopeAffinity: number;
  scopeType: MemoryScopeType | null;
  sensitivityClass: MemorySensitivityClass | null;
  sourceAssistantId: string | null;
  sourceChatId: string | null;
  sourceFolderId: string | null;
  sourceMode: MemorySourceMode | null;
  systemFrom: Date | null;
  temperatureClass: MemoryRetrievalTemperatureClass | null;
  validFrom: Date | null;
  validTo: Date | null;
  historySafetyClass: MemoryRetrievalHistorySafetyClass | null;
}>;

export type MemoryLaneCandidate = Readonly<{
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
  conflictPenalty: number;
  currentness: number;
  directness: number;
  exactCanonical: number;
  exactEntity: number;
  explicitAuthority: number;
  featureVersion: string;
  importance: number;
  languageMatch: number;
  pinned: number;
  scopeAffinity: number;
  sensitivityPenalty: number;
  sourceRecency: number;
  temporalFit: number;
  temperature: number;
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

export const MEMORY_SAFE_PROJECTION_KINDS = [
  "FACT_DISPLAY_TEXT",
  "EPISODE_SAFE_SUMMARY",
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

export type MemoryTemporalDecision = Readonly<{
  disposition: "INCLUDE_CURRENT" | "INCLUDE_QUALIFIED" | "OMIT";
  qualification: string | null;
  reason: string;
  temporalFit: number;
}>;

export type MemoryPackedItem = Readonly<{
  exactSafeText: string;
  finalScore: number;
  itemId: string;
  itemType: MemoryRetrievalItemType;
  projectionKind: MemorySafeProjectionKind;
  section: "CONFLICT" | "FACT" | "HISTORY";
  sourceChatId: string | null;
  supportingItemId: string | null;
  temporalReason: string;
}>;

export type MemoryContextPack = Readonly<{
  approxTokens: number;
  candidateCount: number;
  hardCapTokens: number;
  items: readonly MemoryPackedItem[];
  omissionCounts: Readonly<Record<string, number>>;
  packerVersion: string;
  targetTokens: number;
  text: string | null;
}>;
