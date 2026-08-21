import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRankingEvidence,
  KnowledgeRerankerBindingEvidence
} from "./retrievalRanking";
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

/** Server-only checkpoint operation. This name is never advertised to an
 * answer provider. */
export const KNOWLEDGE_FOCUSED_OPERATION_NAME = "knowledge_focused_v1";
export const KNOWLEDGE_EXACT_TOOL_NAME = "find_exact";
export const KNOWLEDGE_READ_SOURCE_TOOL_NAME = "read_source";
export const KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME = "discover_sources";
export const KNOWLEDGE_INTERNAL_OPERATION_NAMES = Object.freeze([
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
] as const);
export const KNOWLEDGE_EXECUTION_TOOL_NAMES = Object.freeze([
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
export const KNOWLEDGE_CANDIDATE_LIMIT = 40;
export const KNOWLEDGE_RESULT_LIMIT = 8;
export const KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES = 48 * 1024;
export const KNOWLEDGE_SCOPE_MAX_BINDINGS = 128;
export const KNOWLEDGE_SCOPE_MAX_SOURCES = 999;

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
  | "source_location_unavailable"
  | "zero_above_threshold";

export type KnowledgePassageLayoutKind =
  | "body"
  | "field_ambiguous"
  | "field_pair"
  | "table_ambiguous"
  | "table_row"
  | "table_row_projection";

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

export type KnowledgeRetrievedPassageEvidence = Omit<KnowledgeHybridPassage, "text"> & Readonly<{
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
  operation?: KnowledgeOperationKind;
  outcome: KnowledgeRetrievalOutcome;
  /** Decode-only fields from accepted planner-era receipts. */
  postRerankOrder?: null | readonly string[];
  preRerankOrder?: null | readonly string[];
  providerText: string;
  query: string;
  read?: KnowledgeReadReceipt;
  /** Non-null only when decoding an immutable legacy receipt. */
  rerankerBinding?: null | KnowledgeRerankerBindingEvidence;
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
  passages: readonly KnowledgeHybridPassage[];
  rankingEvidence?: KnowledgeRankingEvidence;
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
