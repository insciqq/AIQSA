import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentParserError, type ParsedDocument } from "../parsing";
import type { EmbeddingRuntimeBinding } from "../providerRuntime/embeddingRuntime";
import type { ProviderModelConfiguration } from "../providers/providerConfiguration";
import { createMemoryStorageAdapter } from "../uploads/storage";
import { KnowledgeIngestionCoordinator } from "./ingestionCoordinator";
import { createKnowledgeIngestionProcessor } from "./ingestionProcessor";
import { createPrismaKnowledgeIngestionRepository } from "./prismaIngestionRepository";
import { createPrismaKnowledgeRepository } from "./prismaRepository";

const enabled = process.env.AIQSA_KNOWLEDGE_INGESTION_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const knowledge = createPrismaKnowledgeRepository(database);
const ingestion = createPrismaKnowledgeIngestionRepository(database);
const storage = createMemoryStorageAdapter();
const suffix = randomUUID();
const ownerId = `knowledge-ingestion-owner-${suffix}`;
const connectionId = `knowledge-ingestion-connection-${suffix}`;
const firstModelId = `knowledge-ingestion-embedding-a-${suffix}`;
const secondModelId = `knowledge-ingestion-embedding-b-${suffix}`;
let baseId = "";
let poisonRejected = true;

function embeddingConfiguration(upstreamModelId: string): ProviderModelConfiguration {
  return {
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
      nativeDimension: 1536,
      providerFamily: "openai_compatible",
      queryInstructionTemplate: "Query: {text}",
      supportsMrl: false,
      targetDimension: 1536
    },
    modelClass: "embedding",
    upstreamModelId
  };
}

function checksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function parsed(fileName: string): ParsedDocument {
  if (fileName.includes("poison") && poisonRejected) {
    throw new DocumentParserError("parser_rejected", "docling");
  }
  const count = fileName.includes("bulk") ? 65 : 1;
  const blocks = Array.from({ length: count }, (_, index) => ({
    headingPath: [`Section ${index}`],
    index,
    isTable: false,
    page: index + 1,
    text: `${fileName} block ${index}`
  }));
  return {
    blocks,
    engine: "docling",
    mediaType: "text/plain",
    pageCount: count,
    status: "complete",
    text: blocks.map((block) => block.text).join("\n")
  };
}

const embeddingCalls: Array<{
  mode: string;
  providerModelId: string;
  size: number;
}> = [];

function runtimeBinding(providerModelId: string): EmbeddingRuntimeBinding {
  const configuration = embeddingConfiguration(
    providerModelId === firstModelId ? "embedding-a" : "embedding-b"
  );
  return {
    adapter: {
      async embed(request) {
        embeddingCalls.push({ mode: request.mode, providerModelId, size: request.texts.length });
        return {
          model: configuration.upstreamModelId,
          requestId: null,
          usage: { inputTokens: request.texts.length, totalTokens: request.texts.length },
          vectors: request.texts.map(() => Array.from({ length: 1536 }, () => 0.01))
        };
      }
    },
    configuration,
    connectionId,
    connectionVersion: 1,
    credentialId: "fake-credential",
    credentialSource: "default",
    credentialVersionId: "fake-credential-version",
    executionSnapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://embedding.example.test/v1"
      },
      connectionDisplayName: "Embedding endpoint",
      connectionId,
      credentialId: "fake-credential",
      credentialVersionId: "fake-credential-version",
      model: configuration,
      modelDisplayName: "Embedding model",
      providerFamily: "openai_compatible",
      providerModelId,
      version: 1
    },
    modelVersion: 1,
    provider: "openai_compatible",
    providerModelId
  };
}

const processor = createKnowledgeIngestionProcessor({
  config: {
    maxChunksPerDocument: 200,
    maxFileBytes: 1_000_000,
    maxNormalizedChars: 1_000_000,
    maxNormalizedObjectBytes: 4_000_000,
    maxPages: 200
  },
  embeddingRuntime: {
    resolveForUser: async ({ providerModelId }) => runtimeBinding(providerModelId)
  },
  parser: { parse: async ({ fileName }) => parsed(fileName) },
  repository: ingestion,
  storage
});

async function upload(fileName: string) {
  const body = Buffer.from(`fixture:${fileName}`);
  const documentId = randomUUID();
  const documentVersionId = randomUUID();
  const originalStorageKey = `knowledge-integration/${suffix}/${documentId}/original`;
  const normalizedTextStorageKey = `knowledge-integration/${suffix}/${documentId}/normalized.json`;
  await storage.putObject({ body, contentType: "text/plain", storageKey: originalStorageKey });
  const created = await ingestion.createVersion({
    byteSize: body.byteLength,
    checksum: checksum(body),
    documentId,
    documentVersionId,
    fileName,
    knowledgeBaseId: baseId,
    mimeType: "text/plain",
    normalizedTextStorageKey,
    originalStorageKey,
    replaceDocumentId: null,
    userId: ownerId
  });
  expect(created.kind).toBe("ok");
  return { documentId, documentVersionId };
}

async function drain(now: Date): Promise<void> {
  const coordinator = new KnowledgeIngestionCoordinator({
    maxParallel: 1,
    now: () => now,
    process: processor,
    repository: ingestion
  });
  await coordinator.reconcileNow();
}

async function cleanup(): Promise<void> {
  if (baseId) {
    await database.attachmentDeletionJob.deleteMany({
      where: { storageKey: { startsWith: `knowledge-integration/${suffix}/` } }
    });
    await database.usageEvent.deleteMany({ where: { knowledgeBaseId: baseId } });
    await database.knowledgeGenerationDocument.deleteMany({ where: { knowledgeBaseId: baseId } });
    await database.knowledgeChunk.deleteMany({ where: { knowledgeBaseId: baseId } });
    await database.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: baseId }
    });
    await database.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: baseId }
    });
    await database.knowledgeDocumentVersion.updateMany({
      data: { ingestGenerationId: null },
      where: { knowledgeBaseId: baseId }
    });
    await database.knowledgeDocumentVersion.deleteMany({ where: { knowledgeBaseId: baseId } });
    await database.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: baseId } });
    await database.knowledgeIndexGeneration.updateMany({
      data: {
        sourceBaseVersion: null,
        sourceIndexGenerationId: null,
        targetContentRevision: null
      },
      where: { knowledgeBaseId: baseId }
    });
    await database.knowledgeIndexGeneration.deleteMany({ where: { knowledgeBaseId: baseId } });
    await database.knowledgeBase.deleteMany({ where: { id: baseId } });
  }
  await database.accessGrant.deleteMany({ where: { userId: ownerId } });
  await database.providerModel.deleteMany({ where: { id: { in: [firstModelId, secondModelId] } } });
  await database.providerConnection.deleteMany({ where: { id: connectionId } });
  await database.user.deleteMany({ where: { id: ownerId } });
}

integration("Knowledge ingestion Prisma repository", () => {
  beforeAll(async () => {
    await database.user.create({
      data: {
        displayName: "Knowledge ingestion owner",
        email: `${ownerId}@example.test`,
        id: ownerId,
        status: "active"
      }
    });
    await database.providerConnection.create({
      data: {
        activatedAt: new Date(),
        activeConfig: { allowPrivateNetwork: false, apiRoot: "https://embedding.example.test/v1" },
        activeVersion: 1,
        displayName: "Knowledge ingestion embeddings",
        draftConfig: {},
        enabled: true,
        family: "openai_compatible",
        id: connectionId
      }
    });
    for (const [id, upstream] of [[firstModelId, "embedding-a"], [secondModelId, "embedding-b"]] as const) {
      const configuration = embeddingConfiguration(upstream);
      await database.providerModel.create({
        data: {
          activatedAt: new Date(),
          activeConfig: configuration as unknown as Prisma.InputJsonValue,
          activeVersion: 1,
          capabilities: configuration.capabilities,
          connectionId,
          contextWindow: 32768,
          defaultParams: {},
          displayName: upstream,
          draftConfig: {},
          enabled: true,
          id,
          modelClass: "embedding",
          modelId: upstream,
          provider: "openai_compatible"
        }
      });
    }
    await database.accessGrant.createMany({
      data: [
        { enabled: true, providerModelId: firstModelId, userId: ownerId },
        { enabled: true, providerModelId: secondModelId, userId: ownerId }
      ]
    });
    const created = await knowledge.create(ownerId, {
      description: "Integration corpus",
      embeddingDeploymentId: firstModelId,
      name: "Ingestion integration"
    });
    if (created.kind !== "ok") throw new Error(`base creation failed: ${created.kind}`);
    baseId = created.id;
  });

  afterAll(async () => {
    await cleanup().catch(() => undefined);
    await database.$disconnect();
  });

  it("isolates failures, resumes a committed batch after lease expiry, and atomically catches reindex up", async () => {
    const initialNow = new Date(Date.now() + 60_000);
    const good = await upload("good.txt");
    const poison = await upload("poison.txt");
    await drain(initialNow);

    const firstStates = await database.knowledgeDocumentVersion.findMany({
      orderBy: { fileName: "asc" },
      select: { fileName: true, ingestErrorCode: true, ingestState: true },
      where: { id: { in: [good.documentVersionId, poison.documentVersionId] } }
    });
    expect(firstStates).toEqual([
      { fileName: "good.txt", ingestErrorCode: null, ingestState: "ready" },
      { fileName: "poison.txt", ingestErrorCode: "parser_rejected", ingestState: "failed" }
    ]);

    poisonRejected = false;
    await expect(ingestion.retryVersion({
      documentId: poison.documentId,
      knowledgeBaseId: baseId,
      now: new Date(initialNow.getTime() + 1_000),
      userId: ownerId,
      versionId: poison.documentVersionId
    })).resolves.toEqual({ kind: "ok" });
    await drain(new Date(initialNow.getTime() + 2_000));

    const bulk = await upload("bulk.txt");
    const stageNow = new Date(initialNow.getTime() + 3_000);
    for (const expectedState of ["queued", "parsing", "chunking"] as const) {
      const work = await ingestion.claim({
        claimToken: randomUUID(),
        now: stageNow,
        staleBefore: new Date(0)
      });
      expect(work).toMatchObject({ documentVersionId: bulk.documentVersionId, state: expectedState });
      await processor(work!);
    }
    const embedding = await ingestion.claim({
      claimToken: randomUUID(),
      now: stageNow,
      staleBefore: new Date(0)
    });
    expect(embedding).toMatchObject({ documentVersionId: bulk.documentVersionId, state: "embedding" });
    let crashAfterCommit = true;
    const crashProcessor = createKnowledgeIngestionProcessor({
      config: {
        maxChunksPerDocument: 200,
        maxFileBytes: 1_000_000,
        maxNormalizedChars: 1_000_000,
        maxNormalizedObjectBytes: 4_000_000,
        maxPages: 200
      },
      embeddingRuntime: {
        resolveForUser: async ({ providerModelId }) => runtimeBinding(providerModelId)
      },
      repository: {
        ...ingestion,
        async persistEmbeddingBatch(input) {
          const accepted = await ingestion.persistEmbeddingBatch(input);
          if (crashAfterCommit) {
            crashAfterCommit = false;
            throw new Error("simulated_process_exit_after_batch_commit");
          }
          return accepted;
        }
      },
      storage
    });
    await expect(crashProcessor(embedding!)).rejects.toThrow("simulated_process_exit_after_batch_commit");
    expect(await database.usageEvent.count({
      where: {
        knowledgeDocumentVersionId: bulk.documentVersionId,
        knowledgeIndexGenerationId: embedding!.generation.id
      }
    })).toBe(1);
    expect(await database.knowledgeChunk.count({
      where: {
        documentVersionId: bulk.documentVersionId,
        indexGenerationId: embedding!.generation.id
      }
    })).toBe(64);

    const callsBeforeResume = embeddingCalls.length;
    await drain(new Date(stageNow.getTime() + 61_000));
    expect(embeddingCalls.slice(callsBeforeResume).map((call) => call.size)).toEqual([1]);
    expect(await database.usageEvent.count({
      where: {
        knowledgeDocumentVersionId: bulk.documentVersionId,
        knowledgeIndexGenerationId: embedding!.generation.id
      }
    })).toBe(2);
    expect(await database.knowledgeChunk.count({
      where: {
        documentVersionId: bulk.documentVersionId,
        indexGenerationId: embedding!.generation.id
      }
    })).toBe(65);

    const activeBeforeReindex = (await database.knowledgeBase.findUniqueOrThrow({
      select: { activeIndexGenerationId: true },
      where: { id: baseId }
    })).activeIndexGenerationId!;
    const legacyNormalized = Buffer.from('{"schemaVersion":0,"blocks":[]}');
    const goodStorage = await database.knowledgeDocumentVersion.findUniqueOrThrow({
      select: { normalizedTextStorageKey: true },
      where: { id: good.documentVersionId }
    });
    if (!goodStorage.normalizedTextStorageKey) throw new Error("normalized fixture missing");
    await storage.putObject({
      body: legacyNormalized,
      contentType: "application/json",
      storageKey: goodStorage.normalizedTextStorageKey
    });
    await database.knowledgeDocumentVersion.update({
      data: {
        normalizedTextByteSize: legacyNormalized.byteLength,
        normalizedTextChecksum: checksum(legacyNormalized)
      },
      where: { id: good.documentVersionId }
    });
    const reindex = await ingestion.startReindex({
      embeddingDeploymentId: secondModelId,
      knowledgeBaseId: baseId,
      now: new Date(stageNow.getTime() + 62_000),
      userId: ownerId
    });
    expect(reindex.kind).toBe("ok");
    if (reindex.kind !== "ok") throw new Error(`reindex failed: ${reindex.kind}`);

    const late = await upload("late.txt");
    await drain(new Date(stageNow.getTime() + 63_000));
    await drain(new Date(stageNow.getTime() + 64_000));

    const reindexRows = await database.knowledgeGenerationDocument.findMany({
      orderBy: { documentVersion: { fileName: "asc" } },
      select: {
        chunkCount: true,
        documentVersion: { select: { fileName: true } },
        errorCode: true,
        state: true
      },
      where: { indexGenerationId: reindex.generationId }
    });
    expect(reindexRows).toHaveLength(4);
    expect(reindexRows.every((row) => row.state === "ready" && row.errorCode === null)).toBe(true);

    const base = await database.knowledgeBase.findUniqueOrThrow({
      include: { indexGenerations: true },
      where: { id: baseId }
    });
    expect(base).toMatchObject({
      activeIndexGenerationId: reindex.generationId,
      contentRevision: 4
    });
    expect(base.indexGenerations.find((generation) => generation.id === activeBeforeReindex)?.status)
      .toBe("retired");
    expect(base.indexGenerations.find((generation) => generation.id === reindex.generationId))
      .toMatchObject({
        embeddingProviderModelId: secondModelId,
        indexedContentRevision: 4,
        status: "active",
        targetContentRevision: 4,
        targetDimension: 1536
      });
    expect(await database.knowledgeGenerationDocument.count({
      where: { indexGenerationId: reindex.generationId, state: "ready" }
    })).toBe(4);
    expect(await database.knowledgeChunk.count({
      where: { documentVersionId: late.documentVersionId, indexGenerationId: reindex.generationId }
    })).toBe(1);
    expect(await database.usageEvent.count({
      where: { knowledgeIndexGenerationId: reindex.generationId }
    })).toBe(5);
    expect(embeddingCalls.every((call) => call.mode === "document")).toBe(true);

    await expect(ingestion.listStatus(ownerId, baseId)).resolves.toMatchObject({
      reindex: {
        completedDocuments: 4,
        failedDocuments: 0,
        generationId: reindex.generationId,
        status: "active",
        totalDocuments: 4
      }
    });
    await expect(ingestion.listStatus(ownerId, baseId, {
      page: 1,
      pageSize: 2,
      query: "GOOD"
    })).resolves.toMatchObject({
      documents: [{ versions: [{ fileName: "good.txt" }] }],
      pagination: {
        page: 1,
        pageSize: 2,
        query: "GOOD",
        totalItems: 1,
        totalPages: 1
      }
    });
    const secondPage = await ingestion.listStatus(ownerId, baseId, {
      page: 2,
      pageSize: 2,
      query: ".txt"
    });
    expect(secondPage).toMatchObject({
      pagination: {
        page: 2,
        pageSize: 2,
        query: ".txt",
        totalItems: 4,
        totalPages: 2
      }
    });
    expect(secondPage?.documents).toHaveLength(2);

    const abandoned = await upload("archived-before-claim.txt");
    await database.knowledgeBase.update({
      data: { archivedAt: new Date(stageNow.getTime() + 64_000) },
      where: { id: baseId }
    });
    await expect(ingestion.archiveDocument({
      documentId: abandoned.documentId,
      knowledgeBaseId: baseId,
      now: new Date(stageNow.getTime() + 65_000),
      userId: ownerId
    })).resolves.toEqual({ kind: "not_found" });
    await ingestion.reconcile({ now: new Date(stageNow.getTime() + 65_000) });
    await expect(database.knowledgeDocumentVersion.findUnique({
      select: { ingestErrorCode: true, ingestState: true },
      where: { id: abandoned.documentVersionId }
    })).resolves.toEqual({
      ingestErrorCode: "knowledge_ingestion_failed",
      ingestState: "failed"
    });
    await database.knowledgeBase.update({ data: { archivedAt: null }, where: { id: baseId } });
  });
});
