import type { EmbeddingUsage } from "../providers/embeddings";
import type { KnowledgeVectorSpaceConfiguration } from "./indexProfile";

export type KnowledgeIngestionFailureCode =
  | "chunking_failed"
  | "embedding_failed"
  | "embedding_unavailable"
  | "generation_superseded"
  | "knowledge_chunk_limit_exceeded"
  | "knowledge_file_limit_exceeded"
  | "knowledge_ingestion_failed"
  | "knowledge_object_checksum_mismatch"
  | "knowledge_object_read_failed"
  | "knowledge_object_size_mismatch"
  | "knowledge_page_limit_exceeded"
  | "knowledge_text_limit_exceeded"
  | "normalized_text_unavailable"
  | "parser_rejected"
  | "parser_unavailable"
  | "reindex_source_unavailable";

export class KnowledgeIngestionError extends Error {
  constructor(
    readonly code: KnowledgeIngestionFailureCode,
    readonly retryable = false
  ) {
    super(code);
    this.name = "KnowledgeIngestionError";
  }
}

export type KnowledgeGenerationPinRecord = Readonly<{
  chunkingProfileVersion: number;
  embeddingConfiguration: KnowledgeVectorSpaceConfiguration;
  embeddingProviderModelId: string;
  id: string;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

type KnowledgeWorkClaimBase = Readonly<{
  attemptCount: number;
  claimToken: string;
  documentId: string;
  documentVersionId: string;
  generation: KnowledgeGenerationPinRecord;
  knowledgeBaseId: string;
  normalizedTextByteSize: number | null;
  normalizedTextChecksum: string | null;
  normalizedTextStorageKey: string | null;
  ownerUserId: string;
}>;

export type KnowledgeDocumentWorkClaim = KnowledgeWorkClaimBase & Readonly<{
  byteSize: number;
  checksum: string;
  fileName: string;
  ingestChunkCount: number | null;
  kind: "document";
  mimeType: string;
  originalStorageKey: string | null;
  state: "chunking" | "embedding" | "parsing" | "queued";
}>;

export type KnowledgeReindexWorkClaim = KnowledgeWorkClaimBase & Readonly<{
  chunkCount: number | null;
  kind: "reindex";
  state: "embedding" | "queued";
}>;

export type KnowledgeWorkClaim = KnowledgeDocumentWorkClaim | KnowledgeReindexWorkClaim;

export type KnowledgeEmbeddingChunkWrite = Readonly<{
  headingPath: readonly string[];
  index: number;
  page: number;
  text: string;
  vector: readonly number[];
}>;

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
  documentVersionId: string;
  generationId: string;
  kind: "document" | "reindex";
}>;

export function knowledgeWorkIdentity(claim: KnowledgeWorkClaim): KnowledgeWorkIdentity {
  return {
    claimToken: claim.claimToken,
    documentVersionId: claim.documentVersionId,
    generationId: claim.generation.id,
    kind: claim.kind
  };
}
