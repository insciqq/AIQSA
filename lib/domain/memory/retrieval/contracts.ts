import type {
  MemoryModality,
  MemoryScopeType,
  MemorySensitivityClass,
  MemorySourceMode
} from "../../../contracts/memory";
import type { MemoryRetrievalLane } from "./config";

export type MemoryRetrievalItemType = "FACT_VERSION" | "RECALL_CHUNK";
export type MemoryRetrievalDirectness = "DIRECT" | "INFERRED" | "PARAPHRASED";
export type MemoryRetrievalTemperatureClass = "COLD" | "HOT" | "WARM";
export type MemoryRetrievalHistorySafetyClass =
  | "HIGHLY_SENSITIVE"
  | "NORMAL"
  | "SECRET_TAINTED"
  | "SENSITIVE";

export type MemoryRetrievalSourceKind = "EVENT" | "FACT" | "HISTORY";

export type MemoryRetrievalFilters = Readonly<{
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
  filters: MemoryRetrievalFilters;
  lexicalQuery: string | null;
  normalizedExactQuery: string;
  normalizedQuery: string;
  plannerVersion: string;
  /** Broad, System-Model-authorized inventory of current Personal Memory facts. */
  profileRequested: boolean;
  queryPresent: boolean;
  recencyRequested: boolean;
}>;

export type MemoryRetrievalPlannerInput = Readonly<{
  applyResponsePreferences?: boolean;
  currentUserText: string;
  filters?: Partial<MemoryRetrievalFilters>;
  now: Date;
  profileRequested?: boolean;
  recencyRequested?: boolean;
}>;

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
  factId: string | null;
  historical: boolean;
  historySafetyClass: MemoryRetrievalHistorySafetyClass | null;
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
  fusionVersion: string;
  laneCount: number;
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
  supportingItemId: null;
}>;

export type MemoryPackedItem = Readonly<{
  exactSafeText: string;
  finalScore: number;
  itemId: string;
  itemType: MemoryRetrievalItemType;
  projectionKind: MemorySafeProjectionKind;
  section: "CORE" | "FACT" | "HISTORY";
  sourceChatId: string | null;
  supportingItemId: null;
  temporalReason: "absolute_filter" | "current";
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
