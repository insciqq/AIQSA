import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DocumentParserError, type ParsedDocument } from "../parsing";
import type { EmbeddingRuntimeBinding } from "../providerRuntime/embeddingRuntime";
import type { ProviderModelConfiguration } from "../providers/providerConfiguration";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import {
  createKnowledgeIngestionProcessor,
  type KnowledgeIngestionProcessorRepository
} from "./ingestionProcessor";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import type { KnowledgeDocumentWorkClaim, KnowledgeReindexWorkClaim } from "./ingestionTypes";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 200,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 200
};

const providerConfiguration: ProviderModelConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32768,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1024,
    providerFamily: "openai",
    queryInstructionTemplate: "Query: {text}",
    supportsMrl: false,
    targetDimension: 1024
  },
  modelClass: "embedding",
  upstreamModelId: "embed-v1"
};

const pin = createKnowledgeVectorSpacePin({
  configuration: providerConfiguration,
  deploymentId: "embedding-1"
})!;

function digest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function claim(
  state: KnowledgeDocumentWorkClaim["state"],
  overrides: Partial<KnowledgeDocumentWorkClaim> = {}
): KnowledgeDocumentWorkClaim {
  return {
    attemptCount: 1,
    byteSize: 5,
    checksum: digest(Buffer.from("hello")),
    claimToken: "claim-1",
    documentId: "document-1",
    documentVersionId: "version-1",
    fileName: "document.txt",
    generation: {
      chunkingProfileVersion: 1,
      embeddingConfiguration: pin.configuration,
      embeddingProviderModelId: "embedding-1",
      id: "generation-1",
      targetDimension: pin.targetDimension,
      vectorSpaceFingerprint: pin.fingerprint
    },
    ingestChunkCount: null,
    kind: "document",
    knowledgeBaseId: "base-1",
    mimeType: "text/plain",
    normalizedTextByteSize: null,
    normalizedTextChecksum: null,
    normalizedTextStorageKey: "normalized.json",
    originalStorageKey: "original.txt",
    ownerUserId: "owner-1",
    state,
    ...overrides
  };
}

function repository() {
  return {
    activateDocumentVersion: vi.fn(async () => "activated" as const),
    advanceDocumentToParsing: vi.fn(async () => true),
    advanceReindexToEmbedding: vi.fn(async () => true),
    completedBatchIndexes: vi.fn(async () => [] as number[]),
    completeChunking: vi.fn(async () => true),
    completeParsing: vi.fn(async () => true),
    persistEmbeddingBatch: vi.fn(async () => true),
    recoverReindexChunkPlan: vi.fn<
      KnowledgeIngestionProcessorRepository["recoverReindexChunkPlan"]
    >(async () => null),
    settleReindexReady: vi.fn(async () => true)
  };
}

function reindexClaim(
  state: KnowledgeReindexWorkClaim["state"],
  overrides: Partial<KnowledgeReindexWorkClaim> = {}
): KnowledgeReindexWorkClaim {
  return {
    attemptCount: 1,
    chunkCount: null,
    claimToken: "reindex-claim-1",
    documentId: "document-1",
    documentVersionId: "version-1",
    generation: {
      chunkingProfileVersion: 1,
      embeddingConfiguration: pin.configuration,
      embeddingProviderModelId: "embedding-1",
      id: "generation-2",
      targetDimension: pin.targetDimension,
      vectorSpaceFingerprint: pin.fingerprint
    },
    kind: "reindex",
    knowledgeBaseId: "base-1",
    normalizedTextByteSize: null,
    normalizedTextChecksum: null,
    normalizedTextStorageKey: "normalized.json",
    ownerUserId: "owner-1",
    state,
    ...overrides
  };
}

function binding(embed: EmbeddingRuntimeBinding["adapter"]["embed"]): EmbeddingRuntimeBinding {
  return {
    adapter: { embed },
    configuration: providerConfiguration,
    connectionId: "connection-1",
    connectionVersion: 1,
    credentialId: "credential-1",
    credentialSource: "default",
    credentialVersionId: "credential-version-1",
    executionSnapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.openai.com/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: "OpenAI",
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: providerConfiguration,
      modelDisplayName: "Embedding v1",
      providerFamily: "openai",
      providerModelId: "embedding-1",
      version: 1
    },
    modelVersion: 1,
    provider: "openai",
    providerModelId: "embedding-1"
  };
}

function parsed(blockCount = 1): ParsedDocument {
  const blocks = Array.from({ length: blockCount }, (_, index) => ({
    headingPath: [`Section ${index}`],
    index,
    isTable: false,
    page: index + 1,
    text: `document block ${index}`
  }));
  return {
    blocks,
    engine: "inline",
    mediaType: "text/plain",
    pageCount: blockCount,
    status: "complete",
    text: blocks.map((block) => block.text).join("\n")
  };
}

describe("Knowledge ingestion processor", () => {
  it("advances queued work without crossing a durable stage boundary", async () => {
    const repo = repository();
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn() },
      parser: { parse: vi.fn() },
      repository: repo,
      storage: createMemoryStorageAdapter()
    });

    await process(claim("queued"));

    expect(repo.advanceDocumentToParsing).toHaveBeenCalledOnce();
    expect(repo.completeParsing).not.toHaveBeenCalled();
  });

  it("writes a checksummed normalized object before committing parse completion", async () => {
    const storage = createMemoryStorageAdapter();
    await storage.putObject({ body: Buffer.from("hello"), contentType: "text/plain", storageKey: "original.txt" });
    const repo = repository();
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn() },
      parser: { parse: vi.fn(async () => parsed()) },
      repository: repo,
      storage
    });

    await process(claim("parsing"));

    const normalized = storage.objects.get("normalized.json")!;
    expect(JSON.parse(normalized.body.toString("utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(repo.completeParsing).toHaveBeenCalledWith(expect.objectContaining({
      normalizedTextByteSize: normalized.body.byteLength,
      normalizedTextChecksum: digest(normalized.body),
      pageCount: 1
    }));
  });

  it("preserves extracted Cyrillic text through normalization, chunking, and embedding input", async () => {
    const cyrillicText = "Русский текст для поиска. English scan 2026.";
    const original = Buffer.from("image-only-pdf-fixture");
    const storage = createMemoryStorageAdapter();
    await storage.putObject({
      body: original,
      contentType: "application/pdf",
      storageKey: "original.txt"
    });
    const embed = vi.fn<EmbeddingRuntimeBinding["adapter"]["embed"]>(async (request) => ({
      model: "embed-v1",
      requestId: "request-cyrillic",
      usage: { inputTokens: 8, totalTokens: 8 },
      vectors: request.texts.map(() => Array.from({ length: 1024 }, () => 0.01))
    }));
    const repo = repository();
    const parser = {
      parse: vi.fn(async (): Promise<ParsedDocument> => ({
        blocks: [{
          headingPath: ["Скан"],
          index: 0,
          isTable: false,
          page: 1,
          text: cyrillicText
        }],
        engine: "docling",
        mediaType: "application/pdf",
        pageCount: 1,
        status: "complete",
        text: cyrillicText
      }))
    };
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn(async () => binding(embed)) },
      parser,
      repository: repo,
      storage
    });
    const source = claim("parsing", {
      byteSize: original.byteLength,
      checksum: digest(original),
      fileName: "scan.pdf",
      mimeType: "application/pdf"
    });

    await process(source);

    const normalized = storage.objects.get("normalized.json")!;
    expect(normalized).toBeDefined();
    expect(parser.parse).toHaveBeenCalledWith(expect.objectContaining({
      bytes: original,
      fileName: "scan.pdf",
      mimeType: "application/pdf"
    }));
    expect(JSON.parse(normalized.body.toString("utf8"))).toMatchObject({
      blocks: [{ headingPath: ["Скан"], page: 1, text: cyrillicText }],
      parserEngine: "docling"
    });

    await process(claim("embedding", {
      ingestChunkCount: 1,
      normalizedTextByteSize: normalized.body.byteLength,
      normalizedTextChecksum: digest(normalized.body)
    }));

    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith({
      mode: "document",
      texts: [cyrillicText]
    });
    expect(repo.persistEmbeddingBatch).toHaveBeenCalledWith(expect.objectContaining({
      batch: expect.objectContaining({
        chunks: [expect.objectContaining({ page: 1, text: cyrillicText })]
      })
    }));
    expect(repo.activateDocumentVersion).toHaveBeenCalledWith(expect.objectContaining({
      expectedChunkCount: 1
    }));
  });

  it("fails closed before normalization when OCR returns no text blocks", async () => {
    const original = Buffer.from("blank-image-only-pdf");
    const storage = createMemoryStorageAdapter();
    await storage.putObject({
      body: original,
      contentType: "application/pdf",
      storageKey: "original.txt"
    });
    const repo = repository();
    const resolveForUser = vi.fn();
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser },
      parser: {
        parse: vi.fn(async (): Promise<ParsedDocument> => ({
          blocks: [],
          engine: "docling",
          mediaType: "application/pdf",
          pageCount: 1,
          status: "complete",
          text: ""
        }))
      },
      repository: repo,
      storage
    });

    await expect(process(claim("parsing", {
      byteSize: original.byteLength,
      checksum: digest(original),
      fileName: "blank-scan.pdf",
      mimeType: "application/pdf"
    }))).rejects.toMatchObject({
      code: "parser_rejected",
      retryable: false
    });
    expect(storage.objects.has("normalized.json")).toBe(false);
    expect(repo.completeParsing).not.toHaveBeenCalled();
    expect(resolveForUser).not.toHaveBeenCalled();
  });

  it("resumes from the durable batch marker and embeds documents without a query instruction", async () => {
    const storage = createMemoryStorageAdapter();
    const encoded = encodeKnowledgeNormalizedDocument(parsed(65), config);
    await storage.putObject({
      body: encoded.body,
      contentType: "application/json",
      storageKey: "normalized.json"
    });
    const embed = vi.fn<EmbeddingRuntimeBinding["adapter"]["embed"]>(async (request) => ({
      model: "embed-v1",
      requestId: "request-1",
      usage: { inputTokens: 3, totalTokens: 3 },
      vectors: request.texts.map(() => Array.from({ length: 1024 }, () => 0.01))
    }));
    const repo = repository();
    repo.completedBatchIndexes.mockResolvedValue([0]);
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn(async () => binding(embed)) },
      repository: repo,
      storage
    });

    await process(claim("embedding", {
      ingestChunkCount: 65,
      normalizedTextByteSize: encoded.body.byteLength,
      normalizedTextChecksum: encoded.checksum
    }));

    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith(expect.objectContaining({
      mode: "document",
      texts: ["document block 64"]
    }));
    expect(repo.persistEmbeddingBatch).toHaveBeenCalledWith(expect.objectContaining({
      batch: expect.objectContaining({ batchIndex: 1, providerModelId: "embedding-1" })
    }));
    expect(repo.activateDocumentVersion).toHaveBeenCalledWith(expect.objectContaining({
      expectedChunkCount: 65
    }));
  });

  it("reindexes from fenced source chunks when the stored normalized object is rejected", async () => {
    const storage = createMemoryStorageAdapter();
    const invalid = Buffer.from('{"schemaVersion":0,"blocks":[]}');
    await storage.putObject({
      body: invalid,
      contentType: "application/json",
      storageKey: "normalized.json"
    });
    const recovered = [{ headingPath: ["Recovered"], index: 0, page: 2, text: "settled source passage" }];
    const embed = vi.fn<EmbeddingRuntimeBinding["adapter"]["embed"]>(async (request) => ({
      model: "embed-v1",
      requestId: "request-reindex",
      usage: { inputTokens: 3, totalTokens: 3 },
      vectors: request.texts.map(() => Array.from({ length: 1024 }, () => 0.01))
    }));
    const repo = repository();
    repo.recoverReindexChunkPlan.mockResolvedValue(recovered);
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn(async () => binding(embed)) },
      repository: repo,
      storage
    });
    const normalized = {
      normalizedTextByteSize: invalid.byteLength,
      normalizedTextChecksum: digest(invalid)
    };

    await process(reindexClaim("queued", normalized));
    expect(repo.advanceReindexToEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      chunkCount: 1
    }));

    await process(reindexClaim("embedding", { ...normalized, chunkCount: 1 }));
    expect(embed).toHaveBeenCalledWith(expect.objectContaining({
      mode: "document",
      texts: ["settled source passage"]
    }));
    expect(repo.settleReindexReady).toHaveBeenCalledWith(expect.objectContaining({
      expectedChunkCount: 1
    }));
  });

  it("reports a reindex-specific failure when neither normalized text nor source chunks are usable", async () => {
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn() },
      repository: repository(),
      storage: createMemoryStorageAdapter()
    });

    await expect(process(reindexClaim("queued"))).rejects.toMatchObject({
      code: "reindex_source_unavailable",
      retryable: false
    });
  });

  it("maps primary parser unavailability to an explicit retryable failure", async () => {
    const storage = createMemoryStorageAdapter();
    await storage.putObject({ body: Buffer.from("hello"), contentType: "text/plain", storageKey: "original.txt" });
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn() },
      parser: { parse: vi.fn(async () => { throw new DocumentParserError("parser_unavailable", "docling"); }) },
      repository: repository(),
      storage
    });

    await expect(process(claim("parsing"))).rejects.toMatchObject({
      code: "parser_unavailable",
      retryable: true
    });
  });

  it("reports a partial parser result as a text-limit failure instead of indexing truncation", async () => {
    const storage = createMemoryStorageAdapter();
    await storage.putObject({ body: Buffer.from("hello"), contentType: "text/plain", storageKey: "original.txt" });
    const process = createKnowledgeIngestionProcessor({
      config,
      embeddingRuntime: { resolveForUser: vi.fn() },
      parser: { parse: vi.fn(async () => ({ ...parsed(), status: "partial" as const })) },
      repository: repository(),
      storage
    });

    await expect(process(claim("parsing"))).rejects.toMatchObject({
      code: "knowledge_text_limit_exceeded",
      retryable: false
    });
  });
});
