import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRankingEvidence,
  KnowledgeRerankerBindingEvidence
} from "./retrievalRanking";
import type { KnowledgeRerankerBindingEvidenceV2 } from "./rerankEvidence";
import type {
  KnowledgeBudgetEvidence,
  LegacyKnowledgeBudgetEvidence,
  KnowledgeOperationKind
} from "./knowledgeBudget";
import type { StructuredAnalysisResult } from "./structuredData";
import type { KnowledgeVisualAnalysisResult } from "./visualEvidence";
import type { NormalizedReadSourceRequest } from "./readSourceLocator";
import type { KnowledgeCanonicalSourceProvenance } from "./canonicalSourceCandidates";
import type { KnowledgeDocumentContextV1 } from "./documentContext";
import type { KnowledgeLexicalBackendEvidenceV1 } from "./searchRetrieval";

/** Server-only checkpoint operation. This name is never advertised to an
 * answer provider. */
export const KNOWLEDGE_FOCUSED_OPERATION_NAME = "knowledge_focused_v1";
export const KNOWLEDGE_SEARCH_TOOL_NAME = "search_knowledge";
export const KNOWLEDGE_EXACT_TOOL_NAME = "find_exact";
export const KNOWLEDGE_READ_SOURCE_TOOL_NAME = "read_source";
export const KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME = "discover_sources";
export const KNOWLEDGE_INTERNAL_OPERATION_NAMES = Object.freeze([
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
] as const);
export const KNOWLEDGE_EXECUTION_TOOL_NAMES = Object.freeze([
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  ...KNOWLEDGE_INTERNAL_OPERATION_NAMES
] as const);
export const KNOWLEDGE_LEGACY_RESULT_VERSION = 1 as const;
export const KNOWLEDGE_RESULT_VERSION = 2 as const;
export const KNOWLEDGE_RESULT_VERSIONS = Object.freeze([
  KNOWLEDGE_LEGACY_RESULT_VERSION,
  KNOWLEDGE_RESULT_VERSION
] as const);
export const KNOWLEDGE_QUERY_MAX_CHARACTERS = 3_000;
/**
 * Legacy ranking-profile-v1 per-lane candidate limit. Retained only for
 * historical focused-receipt decoding and the read-only Admin retrieval
 * projection; new operations use `KNOWLEDGE_LANE_CANDIDATE_LIMIT` from the
 * versioned ranking profile in `retrievalRanking.ts`.
 */
export const KNOWLEDGE_CANDIDATE_LIMIT = 40;
/** Broad map-stage recall. Source-scoped reduce calls intentionally stay
 * smaller so later rounds trade breadth for row-level precision. */
export const KNOWLEDGE_RESULT_LIMIT = 16;
export const KNOWLEDGE_SCOPED_RESULT_LIMIT = 8;
export const KNOWLEDGE_PRIOR_OCCURRENCE_MAX = 256;
export const KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES = 48 * 1024;
export const KNOWLEDGE_SCOPE_MAX_BINDINGS = 128;
export const KNOWLEDGE_SCOPE_MAX_SOURCES = 999;
export const KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER = "eager_v1" as const;
export const KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED = "disclosed_v1" as const;

export type KnowledgeSourceBindingStrategy =
  | typeof KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
  | typeof KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED;

export type KnowledgeExactCaseMode = "insensitive" | "sensitive";
export type KnowledgeExactMatchMode = "pattern" | "phrase" | "token";
export type KnowledgeExactSearchField =
  | "any"
  | "body"
  | "filename"
  | "heading"
  | "tag"
  | "title";
export type KnowledgeSourceDiscoveryField =
  | "filename"
  | "heading"
  | "source_name"
  | "tag"
  | "title";

export type KnowledgeExactSearchRequest = Readonly<{
  caseMode: KnowledgeExactCaseMode;
  cursor: string | null;
  field: KnowledgeExactSearchField;
  limit: number;
  match: KnowledgeExactMatchMode;
  value: string;
}>;

export type KnowledgeSourceDiscoveryRequest = Readonly<{
  cursor: string | null;
  fields: readonly KnowledgeSourceDiscoveryField[];
  limit: number;
  query: string;
}>;

export type KnowledgeResultVersion = (typeof KNOWLEDGE_RESULT_VERSIONS)[number];

export type KnowledgeRetrievalOutcome =
  | "base_empty"
  | "base_indexing"
  | "budget_exhausted"
  | "complete"
  | "embedding_model_unavailable"
  | "no_relevant_evidence"
  | "source_location_unavailable"
  | "zero_above_threshold";

export type KnowledgePassageLayoutKind =
  | "body"
  | "field_ambiguous"
  | "field_pair"
  | "table_ambiguous"
  | "table_row"
  | "table_row_projection";

/**
 * One same-Source context segment attached to a selected primary passage
 * (FR-14 child-to-parent expansion). Units exist only in memory between the
 * retrieval core and provider-text assembly: the persisted receipt keeps the
 * rendered `expandedContext` text plus the content-free
 * `KnowledgeParentExpansionEvidence` summary, exactly like the pre-existing
 * neighbor context persisted before this stage existed.
 */
export type KnowledgeParentExpansionUnit = Readonly<{
  chunkId: string;
  chunkIndex: number;
  contentHash: string;
  /** Exact provider-visible segment label for non-section origins. */
  label: string;
  /**
   * "section": same-Source context merged into the single previous/next
   * same-Source block (section-window text, field-group neighbors, and
   * same-row projection neighbors all carry this provider-visible label
   * today); "table": complete nearby row from the same table; "independent":
   * independently matched same-Source segment.
   */
  origin: "independent" | "section" | "table";
  position: "next" | "previous";
  /** Relevance order inside one primary's group; higher ranks trim first. */
  rank: number;
  text: string;
  /** Tokens in this unit's text alone. The group cap is checked against the
   * complete rendered expansion, including labels and separators. */
  tokens: number;
}>;

/** In-memory expansion attached to one selected primary passage. */
export type KnowledgeParentExpansion = Readonly<{
  /** Content-free classification code, present only when degraded. */
  reason?: string;
  /**
   * "expanded": the canonical-section window was consulted; "legacy": the
   * passage has no canonical section (legacy generation) so only the
   * candidate-pool neighbor mechanics apply; "degraded": window loading or
   * assembly failed and the atomic evidence plus candidate-pool fallback was
   * kept (PRD §18: parent expansion failure never loses the answer).
   */
  state: "degraded" | "expanded" | "legacy";
  units: readonly KnowledgeParentExpansionUnit[];
}>;

/**
 * Content-free source-order coordinates for the rendered parent expansion.
 * Offsets address the already persisted `expandedContext` string and never
 * duplicate source text. They let downstream coverage projection restore the
 * retrieval layer's explicit previous/next order without parsing untrusted
 * provider-visible labels back out of the evidence text.
 */
export type KnowledgeExpandedContextOrderV1 = Readonly<{
  offsetEncoding: "utf16_code_units";
  segments: readonly Readonly<{
    end: number;
    position: "next" | "previous";
    sourceOrdinal: number;
    start: number;
  }>[];
  version: 1;
}>;

/**
 * Content-free structural facts persisted with each receipt result: how many
 * expanded passages and model tokens shipped, and why expansion degraded.
 * Never contains text.
 */
export type KnowledgeParentExpansionEvidence = Readonly<{
  contextOrder?: KnowledgeExpandedContextOrderV1;
  passageCount: number;
  reason?: string;
  state: KnowledgeParentExpansion["state"];
  tokens: number;
}>;

export type KnowledgeAcceptedBinding = Readonly<{
  baseContentRevision: number;
  baseName: string;
  embeddingConnectionId: string;
  embeddingCredentialId: string;
  embeddingCredentialSource: "default" | "group" | "user";
  embeddingCredentialVersionId: string;
  embeddingExecutionSnapshot: ProviderExecutionSnapshot | unknown;
  embeddingProviderModelId: string;
  executionScope?: "base" | "profile";
  indexedContentRevision: number;
  indexGenerationId: string;
  includeWholeBase: boolean;
  knowledgeBaseId: string;
  knowledgeBaseSnapshotId: string;
  ordinal: number;
  profileRevisionId?: string;
  selectedSourceIds: readonly string[];
  targetDimension: 1024 | 1536;
  vectorSpaceFingerprint: string;
}>;

export type KnowledgeVectorSearchEvidence = Readonly<{
  bindingOrdinal: number;
  candidateCount: number;
  eligibleRows: number;
  mode: "ann" | "exact" | "unavailable";
  scan: Readonly<{
    efSearch: number | null;
    iterativeScan: "strict_order" | null;
    maxScanTuples: number | null;
    retrievalBucket: number;
  }>;
  targetDimension: 1024 | 1536;
}>;

export type KnowledgeBaseRetrievalEvidence = Readonly<{
  baseContentRevision: number;
  baseName: string;
  candidateCount: number;
  indexedContentRevision: number;
  indexGenerationId: string;
  knowledgeBaseId: string;
  ordinal: number;
  state: "empty" | "indexing" | "ready";
  targetDimension: 1024 | 1536;
  /** Content-free tokenizer identity (name:version[:asset fingerprint])
   * derived from the pinned embedding profile; absent on older receipts. */
  tokenizerProfile?: string;
  vectorSearch?: KnowledgeVectorSearchEvidence;
  vectorSpaceFingerprint: string;
}>;

export type KnowledgeEmbeddingExecutionEvidence = Readonly<{
  bindingOrdinals: readonly number[];
  durationMs: number;
  inputTokens: number;
  modelId: string;
  provider: string;
  providerModelId: string;
  requestId: string | null;
  status: "complete" | "error";
  totalTokens: number;
}>;

export type KnowledgeHybridPassage = Readonly<{
  annRank: number | null;
  baseName: string;
  bindingOrdinal: number;
  chunkId: string;
  chunkIndex: number;
  confidence?: number;
  contentHash?: string;
  documentId: string;
  documentVersionId: string;
  documentVersionNumber: number;
  documentContext?: KnowledgeDocumentContextV1 | null;
  expandedContext?: string;
  /** In-memory FR-14 expansion; never persisted with unit text. */
  expansion?: KnowledgeParentExpansion;
  fileName: string;
  ftsRank: number | null;
  ftsScore: number | null;
  fusedScore: number;
  headingPath?: readonly string[];
  knowledgeBaseId: string;
  layoutKind?: KnowledgePassageLayoutKind;
  page: number;
  rerankScore?: number | null;
  sectionId?: string | null;
  signalProvenance?: readonly KnowledgeCandidateSignal[];
  sourceArtifactId?: string | null;
  sourceName?: string;
  /** Read-only compatibility for immutable citation receipts. */
  structuredAnalysis?: StructuredAnalysisResult;
  text: string;
  vectorDistance: number | null;
  vectorScore: number | null;
  /** Read-only compatibility for immutable citation receipts. */
  visualAnalysis?: KnowledgeVisualAnalysisResult;
}>;

export type KnowledgeRetrievedPassageEvidence =
  Omit<KnowledgeHybridPassage, "expansion" | "text"> & Readonly<{
    /** Content-free FR-14 expansion facts for the receipt; never unit text. */
    expansion?: KnowledgeParentExpansionEvidence;
    handle: string;
    includedText: string;
    includedTextBytes: number;
    sourceAlias?: string;
    sourceTextBytes: number;
    textTruncated: boolean;
  }>;

/**
 * Current result passages always carry an immutable Source/Version identity
 * and the run-local alias that was actually shown to the answer model. The
 * wider legacy passage type remains available solely for V1 receipt reads.
 */
export type KnowledgeSourceBoundRetrievedPassageEvidence =
  Omit<KnowledgeRetrievedPassageEvidence, "sourceAlias" | "sourceArtifactId" | "sourceName"> &
  Readonly<{
    sourceAlias: string;
    sourceArtifactId: string;
    sourceName: string;
  }>;

export type KnowledgeEvidenceScopeAlias = Readonly<{
  alias: string;
  kind: "base" | "source";
  label: string;
}>;

export type KnowledgeReadResolvedSource = Readonly<{
  sourceAlias: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceName: string;
  sourceVersionId: string;
}>;

export type KnowledgeReadReceipt = NormalizedReadSourceRequest & Readonly<{
  resolvedSource: KnowledgeReadResolvedSource;
  version: 1;
}>;

export type KnowledgeExactMatchEvidence = Readonly<{
  field: Exclude<KnowledgeExactSearchField, "any">;
  resultOrdinal: number;
}>;

export type KnowledgeExactRetrievalEvidence = KnowledgeExactSearchRequest & Readonly<{
  matches: readonly KnowledgeExactMatchEvidence[];
  nextCursor: string | null;
  scannedBytes: number;
  scanTruncated: boolean;
  version: 1;
}>;

export type KnowledgeDiscoveredSourceEvidence = Readonly<{
  ambiguous: boolean;
  fileName: string;
  matchedFields: readonly KnowledgeSourceDiscoveryField[];
  readiness: "ready";
  sourceAlias: string;
  sourceName: string;
  sourceVersionNumber: number;
}>;

export type KnowledgeSourceDiscoveryEvidence = KnowledgeSourceDiscoveryRequest & Readonly<{
  nextCursor: string | null;
  sources: readonly KnowledgeDiscoveredSourceEvidence[];
  version: 1;
}>;

export type KnowledgeRetrievalEvidence = Readonly<{
  bases: readonly KnowledgeBaseRetrievalEvidence[];
  budget?: KnowledgeBudgetEvidence | LegacyKnowledgeBudgetEvidence;
  candidateCount: number;
  candidateLimit: number;
  durationMs: number;
  embeddingExecutions: readonly KnowledgeEmbeddingExecutionEvidence[];
  discovery?: KnowledgeSourceDiscoveryEvidence;
  exact?: KnowledgeExactRetrievalEvidence;
  failureCode?: string;
  fusion: "none" | "rrf_k60" | "weighted_rrf_v2";
  invocationOrdinal: number;
  lexicalBackend?: KnowledgeLexicalBackendEvidenceV1;
  operation?: KnowledgeOperationKind;
  outcome: KnowledgeRetrievalOutcome;
  /** Decode-only fields from accepted planner-era receipts. */
  postRerankOrder?: null | readonly string[];
  preRerankOrder?: null | readonly string[];
  providerText: string;
  query: string;
  read?: KnowledgeReadReceipt;
  /**
   * Version 1 shapes are decode-only compatibility for immutable legacy
   * receipts. New automatic-search operations record the content-free hosted
   * reranker execution evidence as `KnowledgeRerankerBindingEvidenceV2`.
   */
  rerankerBinding?:
    | null
    | KnowledgeRerankerBindingEvidence
    | KnowledgeRerankerBindingEvidenceV2;
  resultLimit: number;
  results: readonly KnowledgeRetrievedPassageEvidence[];
  scopeAliases?: readonly KnowledgeEvidenceScopeAlias[];
  /** Decode-only confidence threshold from accepted planner-era receipts. */
  threshold?: number;
  version: KnowledgeResultVersion;
}>;

export type KnowledgeRetrievalEvidenceV1 =
  Omit<KnowledgeRetrievalEvidence, "read" | "version"> & Readonly<{
    read?: never;
    version: typeof KNOWLEDGE_LEGACY_RESULT_VERSION;
  }>;

export type KnowledgeRetrievalEvidenceV2 =
  Omit<KnowledgeRetrievalEvidence, "results" | "version"> & Readonly<{
    results: readonly KnowledgeSourceBoundRetrievedPassageEvidence[];
    version: typeof KNOWLEDGE_RESULT_VERSION;
  }>;

export type KnowledgeHybridSearchResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  canonicalSourceProvenance?: readonly KnowledgeCanonicalSourceProvenance[];
  lexicalBackendEvidence?: KnowledgeLexicalBackendEvidenceV1;
  passages: readonly KnowledgeHybridPassage[];
  rankingEvidence?: KnowledgeRankingEvidence;
  /** Present exactly when a hosted rerank stage ran for this operation. */
  rerankerBinding?: KnowledgeRerankerBindingEvidenceV2;
  vectorSearchEvidence?: readonly KnowledgeVectorSearchEvidence[];
}>;

export type KnowledgeExactSearchResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  fields: readonly Exclude<KnowledgeExactSearchField, "any">[];
  nextCursor: string | null;
  passages: readonly KnowledgeHybridPassage[];
  scannedBytes: number;
  scanTruncated: boolean;
}>;

export type KnowledgeSourceDiscoveryResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  nextCursor: string | null;
  sources: readonly KnowledgeDiscoveredSourceEvidence[];
}>;

export type KnowledgeRetrievalUsageAttribution = Readonly<{
  modelId: string;
  provider: string;
  usage: ModelRunUsage;
}>;
