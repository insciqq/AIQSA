import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

export const KNOWLEDGE_TOOL_NAME = "retrieve_knowledge";
export const KNOWLEDGE_RESULT_VERSION = 1;
export const KNOWLEDGE_QUERY_MAX_CHARACTERS = 500;
export const KNOWLEDGE_MAX_INVOCATIONS = 3;
export const KNOWLEDGE_CANDIDATE_LIMIT = 40;
export const KNOWLEDGE_RESULT_LIMIT = 8;
export const KNOWLEDGE_RRF_K = 60;
export const KNOWLEDGE_SCORE_THRESHOLD = 0.01;
export const KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES = 48 * 1024;

export type KnowledgeRetrievalOutcome =
  | "base_empty"
  | "base_indexing"
  | "complete"
  | "embedding_model_unavailable"
  | "zero_above_threshold";

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
  knowledgeBaseId: string;
  ordinal: number;
  targetDimension: 1024 | 1536;
  vectorSpaceFingerprint: string;
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
  documentId: string;
  documentVersionId: string;
  /** User-facing immutable revision number; absent only on legacy receipts. */
  documentVersionNumber?: number;
  fileName: string;
  ftsRank: number | null;
  ftsScore: number | null;
  fusedScore: number;
  knowledgeBaseId: string;
  page: number;
  text: string;
  vectorDistance: number | null;
  vectorScore: number | null;
}>;

export type KnowledgeRetrievedPassageEvidence = Omit<KnowledgeHybridPassage, "text"> & Readonly<{
  handle: string;
  includedText: string;
  includedTextBytes: number;
  sourceTextBytes: number;
  textTruncated: boolean;
}>;

export type KnowledgeRetrievalEvidence = Readonly<{
  bases: readonly KnowledgeBaseRetrievalEvidence[];
  candidateCount: number;
  candidateLimit: number;
  durationMs: number;
  embeddingExecutions: readonly KnowledgeEmbeddingExecutionEvidence[];
  failureCode?: string;
  fusion: "rrf_k60";
  invocationOrdinal: number;
  outcome: KnowledgeRetrievalOutcome;
  postRerankOrder: null;
  preRerankOrder: null;
  providerText: string;
  query: string;
  rerankerBinding: null;
  resultLimit: number;
  results: readonly KnowledgeRetrievedPassageEvidence[];
  threshold: number;
  version: typeof KNOWLEDGE_RESULT_VERSION;
}>;

export type KnowledgeHybridSearchResult = Readonly<{
  bindingCount: number;
  candidateCount: number;
  candidateCounts: Readonly<Record<number, number>>;
  passages: readonly KnowledgeHybridPassage[];
}>;

export type KnowledgeRetrievalUsageAttribution = Readonly<{
  modelId: string;
  provider: string;
  usage: ModelRunUsage;
}>;
