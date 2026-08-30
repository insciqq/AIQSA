import type { EmbeddingUsage } from "../providers/embeddings";
import type { ParsedDocumentWarningCode } from "../parsing";
import type { KnowledgePdfProcessingMode } from "./knowledgeProfile";
import type { KnowledgeVectorSpaceConfiguration } from "./indexProfile";

export type KnowledgeIngestionFailureCode =
  | "chunking_failed"
  | "embedding_failed"
  | "embedding_rate_limited"
  | "embedding_unavailable"
  | "knowledge_chunk_limit_exceeded"
  | "knowledge_file_limit_exceeded"
  | "knowledge_hierarchical_index_failed"
  | "knowledge_ingestion_failed"
  | "knowledge_object_checksum_mismatch"
  | "knowledge_object_read_failed"
  | "knowledge_object_size_mismatch"
  | "knowledge_page_limit_exceeded"
  | "knowledge_text_limit_exceeded"
  | "knowledge_tokenizer_unavailable"
  | "normalized_text_unavailable"
  | "parser_rejected"
  | "parser_unavailable"
  | "pdf_processing_ambiguous"
  | "pdf_processing_failed"
  | "pdf_processing_unavailable";

export class KnowledgeIngestionError extends Error {
  constructor(
    readonly code: KnowledgeIngestionFailureCode,
    readonly retryable = false,
    readonly retryAfterMs: number | null = null
  ) {
    super(code);
    this.name = "KnowledgeIngestionError";
  }
}

export type KnowledgeSourceArtifactPinRecord = Readonly<{
  chunkingProfileVersion: number;
  embeddingConfiguration: KnowledgeVectorSpaceConfiguration;
  embeddingProviderModelId: string;
  id: string;
  pdfParserProfileVersion: number;
  pdfProcessingMode: KnowledgePdfProcessingMode;
  pdfSystemModelPolicyVersion: number | null;
  pdfSystemModelSnapshot: unknown;
  processingGeneration: number;
  profileExecutionAuthority: "installation" | "legacy_user";
  profileRevisionId: string | null;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

type KnowledgeWorkClaimBase = Readonly<{
  attemptCount: number;
  claimToken: string;
  sourceId: string;
  sourceVersionId: string;
  artifact: KnowledgeSourceArtifactPinRecord;
  knowledgeBaseId: string;
  normalizedTextByteSize: number | null;
  normalizedTextChecksum: string | null;
  normalizedTextStorageKey: string | null;
  ownerUserId: string;
}>;

export type KnowledgeSourceWorkClaim = KnowledgeWorkClaimBase & Readonly<{
  byteSize: number;
  checksum: string;
  fileName: string;
  ingestChunkCount: number | null;
  mimeType: string;
  originalStorageKey: string | null;
  state: "chunking" | "embedding" | "parsing" | "queued";
}>;

export type KnowledgeWorkClaim = KnowledgeSourceWorkClaim;

export type KnowledgeEmbeddingChunkWrite = Readonly<{
  contentHash: string;
  contextPrefix: string;
  embeddingTextHash: string;
  headingPath: readonly string[];
  index: number;
  page: number;
  pageEnd: number;
  sourceBlockEnd: number;
  sourceBlockIds: readonly string[];
  sourceBlockStart: number;
  text: string;
  tokenCount: number;
  vector: readonly number[];
}>;

export type KnowledgeIngestionWarningCode = ParsedDocumentWarningCode;

export type KnowledgeEmbeddingBatchWrite = Readonly<{
  batchIndex: number;
  chunks: readonly KnowledgeEmbeddingChunkWrite[];
  modelId: string;
  provider: string;
  providerModelId: string;
  usage: EmbeddingUsage;
}>;

export type KnowledgeWorkIdentity = Readonly<{
  claimToken: string;
  sourceVersionId: string;
  artifactId: string;
}>;

export function knowledgeWorkIdentity(claim: KnowledgeWorkClaim): KnowledgeWorkIdentity {
  return {
    claimToken: claim.claimToken,
    sourceVersionId: claim.sourceVersionId,
    artifactId: claim.artifact.id
  };
}
