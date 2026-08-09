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
  type KnowledgeWorkClaim,
  type KnowledgeWorkIdentity
} from "./ingestionTypes";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  decodeKnowledgeNormalizedDocument,
  encodeKnowledgeNormalizedDocument,
  KnowledgeNormalizedDocumentError,
  type StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";

export type KnowledgeIngestionProcessorRepository = Readonly<{
  activateDocumentVersion(input: KnowledgeWorkIdentity & {
    expectedChunkCount: number;
    now: Date;
  }): Promise<"activated" | "deferred" | "lease_lost" | "retargeted">;
  advanceDocumentToParsing(input: KnowledgeWorkIdentity & { now: Date }): Promise<boolean>;
  advanceReindexToEmbedding(input: KnowledgeWorkIdentity & {
    chunkCount: number;
    now: Date;
  }): Promise<boolean>;
  completedBatchIndexes(generationId: string, documentVersionId: string): Promise<number[]>;
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
  }): Promise<boolean>;
  persistEmbeddingBatch(input: KnowledgeWorkIdentity & {
    batch: KnowledgeEmbeddingBatchWrite;
    now: Date;
    ownerUserId: string;
    targetDimension: number;
  }): Promise<boolean>;
  recoverReindexChunkPlan(input: KnowledgeWorkIdentity & {
    chunkingProfileVersion: number;
    maxChunks: number;
  }): Promise<readonly KnowledgeChunkPlanEntry[] | null>;
  settleReindexReady(input: KnowledgeWorkIdentity & {
    expectedChunkCount: number;
    now: Date;
  }): Promise<boolean>;
}>;

export type KnowledgeEmbeddingRuntime = Readonly<{
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
    inlineMaxChars: config.maxNormalizedChars + 1,
    sidecarFallback: false
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
      return chunkKnowledgeDocument({
        blocks: normalized.blocks,
        maxChunks: config.maxChunksPerDocument,
        profileVersion: claim.generation.chunkingProfileVersion
      });
    } catch (error) {
      const normalizedError = error instanceof KnowledgeChunkingError
        ? chunkingFailure(error)
        : error;
      if (claim.kind !== "reindex" || !(normalizedError instanceof KnowledgeIngestionError)) {
        throw normalizedError;
      }
      const recovered = await input.repository.recoverReindexChunkPlan({
        ...knowledgeWorkIdentity(claim),
        chunkingProfileVersion: claim.generation.chunkingProfileVersion,
        maxChunks: config.maxChunksPerDocument
      });
      if (
        !recovered ||
        recovered.length === 0 ||
        recovered.length > config.maxChunksPerDocument ||
        recovered.some((chunk, index) =>
          chunk.index !== index ||
          !Number.isSafeInteger(chunk.page) ||
          chunk.page < 1 ||
          !chunk.text.trim() ||
          chunk.headingPath.length > 16)
      ) {
        throw new KnowledgeIngestionError("reindex_source_unavailable");
      }
      return [...recovered];
    }
  }

  async function resolveEmbedding(claim: KnowledgeWorkClaim): Promise<EmbeddingRuntimeBinding> {
    let binding: EmbeddingRuntimeBinding;
    try {
      binding = await input.embeddingRuntime.resolveForUser({
        providerModelId: claim.generation.embeddingProviderModelId,
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
      pin.fingerprint !== claim.generation.vectorSpaceFingerprint ||
      pin.targetDimension !== claim.generation.targetDimension
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
    const chunks = await chunkPlan(claim, signal);
    if (chunks.length !== expectedChunkCount) {
      throw new KnowledgeIngestionError("chunking_failed");
    }
    const completed = new Set(await input.repository.completedBatchIndexes(
      claim.generation.id,
      claim.documentVersionId
    ));
    const pending = knowledgeEmbeddingBatches(chunks).filter(
      (batch) => !completed.has(batch.batchIndex)
    );
    const binding = pending.length > 0 ? await resolveEmbedding(claim) : null;

    for (const batch of pending) {
      let result: Awaited<ReturnType<EmbeddingRuntimeBinding["adapter"]["embed"]>>;
      try {
        result = await binding!.adapter.embed({
          mode: "document",
          ...(signal ? { signal } : {}),
          texts: batch.chunks.map((chunk) => chunk.text)
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw embeddingFailure(error);
      }
      if (result.vectors.length !== batch.chunks.length) {
        throw new KnowledgeIngestionError("embedding_failed", true);
      }
      if (result.vectors.some((vector) =>
        vector.length !== claim.generation.targetDimension ||
        vector.some((value) => !Number.isFinite(value)))) {
        throw new KnowledgeIngestionError("embedding_failed", true);
      }
      const accepted = await input.repository.persistEmbeddingBatch({
        ...knowledgeWorkIdentity(claim),
        batch: {
          batchIndex: batch.batchIndex,
          chunks: batch.chunks.map((chunk, index) => ({
            ...chunk,
            vector: result.vectors[index] ?? []
          })),
          modelId: binding!.configuration.upstreamModelId,
          provider: binding!.provider,
          providerModelId: binding!.providerModelId,
          usage: result.usage
        },
        now: now(),
        ownerUserId: claim.ownerUserId,
        targetDimension: claim.generation.targetDimension
      });
      if (!accepted) return;
    }

    if (claim.kind === "document") {
      await input.repository.activateDocumentVersion({
        ...knowledgeWorkIdentity(claim),
        expectedChunkCount,
        now: now()
      });
    } else {
      await input.repository.settleReindexReady({
        ...knowledgeWorkIdentity(claim),
        expectedChunkCount,
        now: now()
      });
    }
  }

  return async function processKnowledgeWork(
    claim: KnowledgeWorkClaim,
    signal?: AbortSignal
  ): Promise<void> {
    const identity = knowledgeWorkIdentity(claim);
    if (claim.kind === "document" && claim.state === "queued") {
      await input.repository.advanceDocumentToParsing({ ...identity, now: now() });
      return;
    }
    if (claim.kind === "document" && claim.state === "parsing") {
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
      if (parsed.status !== "complete") {
        throw new KnowledgeIngestionError("knowledge_text_limit_exceeded");
      }
      let encoded;
      try {
        encoded = encodeKnowledgeNormalizedDocument(parsed, config);
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
        pageCount: encoded.document.pageCount
      });
      return;
    }
    if (claim.kind === "document" && claim.state === "chunking") {
      const chunks = await chunkPlan(claim, signal);
      await input.repository.completeChunking({
        ...identity,
        chunkCount: chunks.length,
        now: now()
      });
      return;
    }
    if (claim.kind === "reindex" && claim.state === "queued") {
      const chunks = await chunkPlan(claim, signal);
      await input.repository.advanceReindexToEmbedding({
        ...identity,
        chunkCount: chunks.length,
        now: now()
      });
      return;
    }

    const expectedChunkCount = claim.kind === "document"
      ? claim.ingestChunkCount
      : claim.chunkCount;
    if (expectedChunkCount === null) {
      throw new KnowledgeIngestionError("chunking_failed");
    }
    await embed(claim, expectedChunkCount, signal);
  };
}
