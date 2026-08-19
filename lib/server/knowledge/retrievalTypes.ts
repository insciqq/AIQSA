import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRankingEvidence,
  KnowledgeRerankerBindingEvidence
} from "./retrievalRanking";
import type {
  KnowledgeBudgetEvidence,
  KnowledgeOperationKind
} from "./knowledgeBudget";
import type { StructuredAnalysisResult } from "./structuredData";
import type { KnowledgeVisualAnalysisResult } from "./visualEvidence";

export const KNOWLEDGE_TOOL_NAME = "retrieve_knowledge";
export const KNOWLEDGE_SEARCH_TOOL_NAME = "search_knowledge";
export const KNOWLEDGE_EXACT_TOOL_NAME = "find_exact";
export const KNOWLEDGE_READ_SOURCE_TOOL_NAME = "read_source";
export const KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME = "discover_sources";
export const KNOWLEDGE_FOLLOW_UP_TOOL_NAMES = Object.freeze([
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
] as const);
export const KNOWLEDGE_EXECUTION_TOOL_NAMES = Object.freeze([
  KNOWLEDGE_TOOL_NAME,
  ...KNOWLEDGE_FOLLOW_UP_TOOL_NAMES
] as const);
export const KNOWLEDGE_RESULT_VERSION = 1;
export const KNOWLEDGE_QUERY_MAX_CHARACTERS = 500;
export const KNOWLEDGE_CANDIDATE_LIMIT = 40;
export const KNOWLEDGE_RESULT_LIMIT = 8;
export const KNOWLEDGE_SCORE_THRESHOLD = 0.01;
export const KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES = 48 * 1024;
export const KNOWLEDGE_SCOPE_MAX_BINDINGS = 128;
export const KNOWLEDGE_SCOPE_MAX_SOURCES = 999;

export type KnowledgeRetrievalOutcome =
  | "base_empty"
  | "base_indexing"
  | "budget_exhausted"
  | "complete"
  | "embedding_model_unavailable"
  | "source_location_unavailable"
  | "structured_clarification_required"
  | "zero_above_threshold";

export type KnowledgePassageLayoutKind =
  | "body"
  | "table_ambiguous"
  | "table_row";

export type KnowledgeStructuredRetrievalEvidence = Readonly<{
  question?: string;
  status: "complete" | "needs_clarification";
  version: 1;
}>;

export type KnowledgeVisualRetrievalEvidence = Readonly<{
  status: "available" | "unavailable";
  version: 1;
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
  indexedContentRevision: number;
  indexGenerationId: string;
  includeWholeBase: boolean;
  knowledgeBaseId: string;
  knowledgeBaseSnapshotId: string;
  ordinal: number;
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
  structuredAnalysis?: StructuredAnalysisResult;
  text: string;
  vectorDistance: number | null;
  vectorScore: number | null;
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

export type KnowledgeEvidenceScopeAlias = Readonly<{
  alias: string;
  kind: "base" | "source";
  label: string;
}>;

export type KnowledgeRetrievalEvidence = Readonly<{
  bases: readonly KnowledgeBaseRetrievalEvidence[];
  budget?: KnowledgeBudgetEvidence;
  candidateCount: number;
  candidateLimit: number;
  durationMs: number;
  embeddingExecutions: readonly KnowledgeEmbeddingExecutionEvidence[];
  failureCode?: string;
  fusion: "rrf_k60" | "weighted_rrf_v2";
  invocationOrdinal: number;
  operation?: KnowledgeOperationKind;
  outcome: KnowledgeRetrievalOutcome;
  postRerankOrder: null | readonly string[];
  preRerankOrder: null | readonly string[];
  providerText: string;
  query: string;
  rerankerBinding: null | KnowledgeRerankerBindingEvidence;
  resultLimit: number;
  results: readonly KnowledgeRetrievedPassageEvidence[];
  scopeAliases?: readonly KnowledgeEvidenceScopeAlias[];
  structured?: KnowledgeStructuredRetrievalEvidence;
  threshold: number;
  version: typeof KNOWLEDGE_RESULT_VERSION;
  visual?: KnowledgeVisualRetrievalEvidence;
}>;

export type KnowledgeHybridSearchResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  passages: readonly KnowledgeHybridPassage[];
  rankingEvidence?: KnowledgeRankingEvidence;
  vectorSearchEvidence?: readonly KnowledgeVectorSearchEvidence[];
}>;

export type KnowledgeRetrievalUsageAttribution = Readonly<{
  modelId: string;
  provider: string;
  usage: ModelRunUsage;
}>;
