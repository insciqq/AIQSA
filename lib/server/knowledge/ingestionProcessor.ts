import { createHash } from "node:crypto";
import {
  createDocumentParserBoundary,
  getDocumentParserConfig,
  isDocumentParserError,
  type DocumentParserBoundary
} from "../parsing";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import type { EmbeddingRuntimeBinding } from "../providerRuntime/embeddingRuntime";
import { EmbeddingAdapterError } from "../providers/embeddings";
import {
  isStoredObjectTooLargeError,
  type StorageAdapter
} from "../uploads/storage";
import {
  chunkKnowledgeDocument,
  KnowledgeChunkingError,
  knowledgeEmbeddingBatches,
  type KnowledgeChunkPlanEntry
} from "./chunking";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";
import {
  KnowledgeIngestionError,
  knowledgeWorkIdentity,
  type KnowledgeEmbeddingBatchWrite,
  type KnowledgeIngestionWarningCode,
  type KnowledgeWorkClaim,
  type KnowledgeWorkIdentity
} from "./ingestionTypes";
import { KnowledgeHierarchicalIndexPersistenceError } from "./hierarchicalIndexRepository";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  decodeKnowledgeNormalizedDocument,
  encodeKnowledgeNormalizedDocument,
  KnowledgeNormalizedDocumentError,
  type StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";

export type KnowledgeIngestionProcessorRepository = Readonly<{
  activateSourceVersion(input: KnowledgeWorkIdentity & {
    expectedChunkCount: number;
    now: Date;
  }): Promise<"activated" | "deferred" | "lease_lost" | "retargeted">;
  advanceSourceToParsing(input: KnowledgeWorkIdentity & { now: Date }): Promise<boolean>;
  completedBatchIndexes(artifactId: string, sourceVersionId: string): Promise<number[]>;
  completeChunking(input: KnowledgeWorkIdentity & {
    chunkCount: number;
    now: Date;
  }): Promise<boolean>;
  completeParsing(input: KnowledgeWorkIdentity & {
    normalizedTextByteSize: number;
    normalizedTextChecksum: string;
    normalizedTextStorageKey: string;
    now: Date;
    pageCount: number;
    warningCodes: readonly KnowledgeIngestionWarningCode[];
  }): Promise<boolean>;
  persistEmbeddingBatch(input: KnowledgeWorkIdentity & {
    batch: KnowledgeEmbeddingBatchWrite;
    now: Date;
    ownerUserId: string;
    targetDimension: number;
  }): Promise<boolean>;
  persistHierarchicalIndex(input: KnowledgeWorkIdentity & {
    chunks: readonly KnowledgeChunkPlanEntry[];
    document: StoredKnowledgeNormalizedDocument | null;
    now: Date;
  }): Promise<boolean>;
  reuseEmbeddingChunks(input: KnowledgeWorkIdentity & {
    chunks: readonly KnowledgeChunkPlanEntry[];
    now: Date;
    targetDimension: number;
  }): Promise<number[]>;
}>;

export type KnowledgeEmbeddingRuntime = Readonly<{
  resolveForInstallation(input: {
    providerModelId: string;
  }): Promise<EmbeddingRuntimeBinding>;
  resolveForUser(input: {
    providerModelId: string;
    userId: string;
  }): Promise<EmbeddingRuntimeBinding>;
}>;

function digest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function parserFailure(error: unknown): KnowledgeIngestionError {
  if (!isDocumentParserError(error)) {
    return new KnowledgeIngestionError("parser_unavailable", true);
  }
  if (error.code === "parser_unavailable" || error.code === "parser_timeout") {
    return new KnowledgeIngestionError("parser_unavailable", true);
  }
  if (error.code === "parser_output_too_large") {
    return new KnowledgeIngestionError("knowledge_text_limit_exceeded");
  }
  return new KnowledgeIngestionError("parser_rejected");
}

function normalizedFailure(error: KnowledgeNormalizedDocumentError): KnowledgeIngestionError {
  return new KnowledgeIngestionError(error.code);
}

function chunkingFailure(error: KnowledgeChunkingError): KnowledgeIngestionError {
  return new KnowledgeIngestionError(error.code);
}

function embeddingFailure(error: unknown): KnowledgeIngestionError {
  if (error instanceof ProviderAdmissionError) {
    return new KnowledgeIngestionError("embedding_unavailable", true);
  }
  if (error instanceof EmbeddingAdapterError) {
    const terminal = [
      "embedding_batch_invalid",
      "embedding_input_invalid",
      "embedding_request_too_large"
    ].includes(error.code);
    return new KnowledgeIngestionError("embedding_failed", !terminal);
  }
  return new KnowledgeIngestionError("embedding_failed", true);
}

function hierarchicalIndexFailure(error: unknown): unknown {
  return error instanceof KnowledgeHierarchicalIndexPersistenceError
    ? new KnowledgeIngestionError("knowledge_hierarchical_index_failed")
    : error;
}

async function readExactObject(input: Readonly<{
  checksum: string;
  maxBytes: number;
  signal?: AbortSignal;
  storage: Pick<StorageAdapter, "getObject">;
  storageKey: string;
}>): Promise<Buffer> {
  let object: Awaited<ReturnType<StorageAdapter["getObject"]>>;
  try {
    object = await input.storage.getObject(input.storageKey, {
      maxBytes: input.maxBytes,
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    if (isStoredObjectTooLargeError(error)) {
      throw new KnowledgeIngestionError("knowledge_object_size_mismatch");
    }
    throw new KnowledgeIngestionError("knowledge_object_read_failed", true);
  }
  if (object.body.byteLength !== input.maxBytes) {
    throw new KnowledgeIngestionError("knowledge_object_size_mismatch");
  }
  if (digest(object.body) !== input.checksum) {
    throw new KnowledgeIngestionError("knowledge_object_checksum_mismatch");
  }
  return object.body;
}

export function createKnowledgeIngestionProcessor(input: Readonly<{
  config?: KnowledgeExtractionConfig;
  embeddingRuntime: KnowledgeEmbeddingRuntime;
  now?: () => Date;
  parser?: Pick<DocumentParserBoundary, "parse">;
  repository: KnowledgeIngestionProcessorRepository;
  storage: Pick<StorageAdapter, "getObject" | "putObject">;
}>) {
  const config = input.config ?? getKnowledgeExtractionConfig();
  const parser = input.parser ?? createDocumentParserBoundary({
    config: getDocumentParserConfig(process.env, {
      requestMaxBytesDefault: config.maxFileBytes
    }),
    inlineMaxChars: config.maxNormalizedChars + 1
  });
  const now = input.now ?? (() => new Date());

  async function normalizedDocument(
    claim: KnowledgeWorkClaim,
    signal?: AbortSignal
  ): Promise<StoredKnowledgeNormalizedDocument> {
    if (
      !claim.normalizedTextStorageKey ||
      claim.normalizedTextByteSize === null ||
      !claim.normalizedTextChecksum
    ) {
      throw new KnowledgeIngestionError("normalized_text_unavailable");
    }
    const body = await readExactObject({
      checksum: claim.normalizedTextChecksum,
      maxBytes: claim.normalizedTextByteSize,
      ...(signal ? { signal } : {}),
      storage: input.storage,
      storageKey: claim.normalizedTextStorageKey
    });
    try {
      return decodeKnowledgeNormalizedDocument(body, config);
    } catch (error) {
      if (error instanceof KnowledgeNormalizedDocumentError) throw normalizedFailure(error);
      throw error;
    }
  }

  async function chunkPlan(claim: KnowledgeWorkClaim, signal?: AbortSignal) {
    try {
      const normalized = await normalizedDocument(claim, signal);
      return {
        chunks: chunkKnowledgeDocument({
          document: normalized,
          maxChunks: config.maxChunksPerDocument,
          profileVersion: claim.artifact.chunkingProfileVersion
        }),
        document: normalized
      };
    } catch (error) {
      throw error instanceof KnowledgeChunkingError
        ? chunkingFailure(error)
        : error;
    }
  }

  async function resolveEmbedding(claim: KnowledgeWorkClaim): Promise<EmbeddingRuntimeBinding> {
    let binding: EmbeddingRuntimeBinding;
    try {
      binding = claim.artifact.profileExecutionAuthority === "installation"
        ? await input.embeddingRuntime.resolveForInstallation({
            providerModelId: claim.artifact.embeddingProviderModelId
          })
        : await input.embeddingRuntime.resolveForUser({
            providerModelId: claim.artifact.embeddingProviderModelId,
            userId: claim.ownerUserId
          });
    } catch (error) {
      throw embeddingFailure(error);
    }
    const pin = createKnowledgeVectorSpacePin({
      configuration: binding.configuration,
      deploymentId: binding.providerModelId
    });
    if (
      !pin ||
      !pin.indexSupported ||
      pin.fingerprint !== claim.artifact.vectorSpaceFingerprint ||
      pin.targetDimension !== claim.artifact.targetDimension
    ) {
      throw new KnowledgeIngestionError("embedding_unavailable", true);
    }
    return binding;
  }

  async function embed(
    claim: KnowledgeWorkClaim,
    expectedChunkCount: number,
    signal?: AbortSignal
  ): Promise<void> {
    const { chunks } = await chunkPlan(claim, signal);
    if (chunks.length !== expectedChunkCount) {
      throw new KnowledgeIngestionError("chunking_failed");
    }
    const completed = new Set(await input.repository.completedBatchIndexes(
      claim.artifact.id,
      claim.sourceVersionId
    ));
    const pending = knowledgeEmbeddingBatches(chunks).filter(
      (batch) => !completed.has(batch.batchIndex)
    );
    let binding: EmbeddingRuntimeBinding | null = null;

    for (const batch of pending) {
      const reused = new Set(await input.repository.reuseEmbeddingChunks({
        ...knowledgeWorkIdentity(claim),
        chunks: batch.chunks,
        now: now(),
        targetDimension: claim.artifact.targetDimension
      }));
      const remaining = batch.chunks.filter((chunk) => !reused.has(chunk.index));
      if (remaining.length === 0) continue;
      binding ??= await resolveEmbedding(claim);
      let result: Awaited<ReturnType<EmbeddingRuntimeBinding["adapter"]["embed"]>>;
      try {
        result = await binding.adapter.embed({
          mode: "document",
          ...(signal ? { signal } : {}),
          texts: remaining.map((chunk) => chunk.embeddingText)
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw embeddingFailure(error);
      }
      if (result.vectors.length !== remaining.length) {
        throw new KnowledgeIngestionError("embedding_failed", true);
      }
      if (result.vectors.some((vector) =>
        vector.length !== claim.artifact.targetDimension ||
        vector.some((value) => !Number.isFinite(value)))) {
        throw new KnowledgeIngestionError("embedding_failed", true);
      }
      const accepted = await input.repository.persistEmbeddingBatch({
        ...knowledgeWorkIdentity(claim),
        batch: {
          batchIndex: batch.batchIndex,
          chunks: remaining.map((chunk, index) => ({
            ...chunk,
            vector: result.vectors[index] ?? []
          })),
          modelId: binding.configuration.upstreamModelId,
          provider: binding.provider,
          providerModelId: binding.providerModelId,
          usage: result.usage
        },
        now: now(),
        ownerUserId: claim.ownerUserId,
        targetDimension: claim.artifact.targetDimension
      });
      if (!accepted) return;
    }

    await input.repository.activateSourceVersion({
      ...knowledgeWorkIdentity(claim),
      expectedChunkCount,
      now: now()
    });
  }

  return async function processKnowledgeWork(
    claim: KnowledgeWorkClaim,
    signal?: AbortSignal
  ): Promise<void> {
    const identity = knowledgeWorkIdentity(claim);
    if (claim.state === "queued") {
      await input.repository.advanceSourceToParsing({ ...identity, now: now() });
      return;
    }
    if (claim.state === "parsing") {
      if (!claim.originalStorageKey || claim.byteSize > config.maxFileBytes) {
        throw new KnowledgeIngestionError("knowledge_file_limit_exceeded");
      }
      const body = await readExactObject({
        checksum: claim.checksum,
        maxBytes: claim.byteSize,
        ...(signal ? { signal } : {}),
        storage: input.storage,
        storageKey: claim.originalStorageKey
      });
      let parsed: Awaited<ReturnType<DocumentParserBoundary["parse"]>>;
      try {
        parsed = await parser.parse({
          bytes: body,
          fileName: claim.fileName,
          mimeType: claim.mimeType,
          ...(signal ? { signal } : {})
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw parserFailure(error);
      }
      let encoded;
      try {
        encoded = encodeKnowledgeNormalizedDocument(parsed, config, {
          sourceDisplayName: claim.fileName,
          sourceMediaType: claim.mimeType
        });
      } catch (error) {
        if (error instanceof KnowledgeNormalizedDocumentError) throw normalizedFailure(error);
        throw error;
      }
      if (!claim.normalizedTextStorageKey) {
        throw new KnowledgeIngestionError("knowledge_ingestion_failed");
      }
      try {
        await input.storage.putObject({
          body: encoded.body,
          contentType: "application/json",
          storageKey: claim.normalizedTextStorageKey
        });
      } catch {
        throw new KnowledgeIngestionError("knowledge_object_read_failed", true);
      }
      await input.repository.completeParsing({
        ...identity,
        normalizedTextByteSize: encoded.body.byteLength,
        normalizedTextChecksum: encoded.checksum,
        normalizedTextStorageKey: claim.normalizedTextStorageKey,
        now: now(),
        pageCount: encoded.document.pageCount,
        warningCodes: encoded.document.warnings
      });
      return;
    }
    if (claim.state === "chunking") {
      const { chunks, document } = await chunkPlan(claim, signal);
      let indexed: boolean;
      try {
        indexed = await input.repository.persistHierarchicalIndex({
          ...identity,
          chunks,
          document,
          now: now()
        });
      } catch (error) {
        throw hierarchicalIndexFailure(error);
      }
      if (!indexed) return;
      await input.repository.completeChunking({
        ...identity,
        chunkCount: chunks.length,
        now: now()
      });
      return;
    }
    const expectedChunkCount = claim.ingestChunkCount;
    if (expectedChunkCount === null) {
      throw new KnowledgeIngestionError("chunking_failed");
    }
    await embed(claim, expectedChunkCount, signal);
  };
}
