import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createPrismaKnowledgeRepository } from "./prismaRepository";
import {
  loadKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionPlan
} from "./runAdmission";
import {
  createPrismaKnowledgeRetrievalStore,
  knowledgeHybridRetrievalSql
} from "./prismaRetrievalRepository";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import { knowledgeEvidenceFromToolResult } from "./toolResult";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import type { RunRepository } from "../runs/runRepositoryContract";

const enabled = process.env.AIQSA_KNOWLEDGE_RETRIEVAL_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const knowledge = createPrismaKnowledgeRepository(database);
const runs = createPrismaRunRepository(database);
const store = createPrismaKnowledgeRetrievalStore(database);
const suffix = randomUUID();
const ownerId = `retrieval-owner-${suffix}`;
const memberId = `retrieval-member-${suffix}`;
const groupId = `retrieval-group-${suffix}`;
const connectionId = `retrieval-connection-${suffix}`;
const credentialId = `retrieval-credential-${suffix}`;
const credentialVersionId = `retrieval-credential-version-${suffix}`;
const embeddingModelId = `retrieval-embedding-${suffix}`;
const baseNameSentinel = `RETRIEVAL-BASE-NAME-${suffix}`;
const fileNameSentinel = `RETRIEVAL-FILE-NAME-${suffix}.pdf`;
const storageSentinel = `private/storage/${suffix}`;
let baseId = "";
let outsideBaseId = "";
let acceptedGenerationId = "";
let replacementGenerationId = "";
let runId = "";
let chatId = "";
let closedRevisionRunId = "";
let closedRevisionChatId = "";
let laterRevisionRunId = "";
let laterRevisionChatId = "";
let firstToolCallId = "";

function embeddingConfiguration() {
  return {
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32_768,
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
      nativeDimension: 1_024,
      providerFamily: "openai_compatible",
      queryInstructionTemplate: "Represent this query: {text}",
      supportsMrl: false,
      targetDimension: 1_024
    },
    modelClass: "embedding",
    upstreamModelId: "retrieval-embedding-v1"
  } as const;
}

function runInput(
  plan: KnowledgeRunAdmissionPlan,
  targetChatId = chatId
): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Use private Knowledge");
  return {
    chatId: targetChatId,
    content,
    expectedActiveLeafId: null,
    knowledgeAdmissionPlan: plan,
    modelId: "fake-answer",
    normalizedRequest: {
      attachmentIds: [],
      chatId: targetChatId,
      content,
      knowledgePlan: { baseIds: [baseId] },
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        toolCalling: true,
        vision: false
      },
      modelId: "fake-answer",
      params: {},
      prompt: { developer: null, system: "Integration" },
      provider: "fake",
      searchStrategy: null,
      toolMode: "auto"
    },
    provider: "fake",
    providerRequestPreview: {},
    userId: memberId
  };
}

function unitVector(dimension = 1_024): number[] {
  return Array.from({ length: dimension }, (_, index) => index === 0 ? 1 : 0);
}

function orthogonalVector(dimension = 1_024): number[] {
  return Array.from({ length: dimension }, (_, index) => index === 1 ? 1 : 0);
}

async function insertChunk(input: Readonly<{
  base: string;
  chunkId: string;
  documentId: string;
  fileName: string;
  generationId: string;
  storageKey: string;
  text: string;
  versionId: string;
  versionNumber: number;
  visibleFromRevision: number;
  visibleUntilRevision?: number | null;
}>): Promise<void> {
  await database.knowledgeDocument.create({
    data: { id: input.documentId, knowledgeBaseId: input.base }
  });
  await database.knowledgeDocumentVersion.create({
    data: {
      byteSize: Buffer.byteLength(input.text, "utf8"),
      checksum: "b".repeat(64),
      documentId: input.documentId,
      fileName: input.fileName,
      id: input.versionId,
      ingestGenerationId: input.generationId,
      ingestState: "ready",
      knowledgeBaseId: input.base,
      mimeType: "application/pdf",
      originalStorageKey: input.storageKey,
      versionNumber: input.versionNumber,
      visibleFromRevision: input.visibleFromRevision,
      visibleUntilRevision: input.visibleUntilRevision ?? null
    }
  });
  await database.knowledgeDocument.update({
    data: { currentVersionId: input.versionId },
    where: { id: input.documentId }
  });
  const vector = `[${unitVector().join(",")}]`;
  await database.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeChunk" (
      "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
      "chunkIndex", "page", "headingPath", "text", "embeddingDimension", "embedding"
    ) VALUES (
      ${input.chunkId}, ${input.base}, ${input.versionId}, ${input.generationId},
      0, 3, ARRAY[]::text[], ${input.text}, 1024, ${vector}::vector
    )
  `);
}

async function insertRetrievalDistractors(input: Readonly<{
  base: string;
  generationId: string;
  versionId: string;
}>): Promise<void> {
  const vector = `[${orthogonalVector().join(",")}]`;
  await database.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeChunk" (
      "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
      "chunkIndex", "page", "headingPath", "text", "embeddingDimension", "embedding"
    )
    SELECT
      ${`retrieval-distractor-${suffix}-`} || series::text,
      ${input.base},
      ${input.versionId},
      ${input.generationId},
      series,
      4,
      ARRAY[]::text[],
      'unrelated retrieval fixture ' || series::text,
      1024,
      ${vector}::vector
    FROM generate_series(1, 512) AS series
  `);
}

integration("Knowledge hybrid retrieval repository", () => {
  beforeAll(async () => {
    const now = new Date();
    await database.user.createMany({
      data: [
        {
          displayName: "Retrieval owner",
          email: `${ownerId}@example.test`,
          id: ownerId,
          role: "admin",
          status: "active"
        },
        {
          displayName: "Retrieval member",
          email: `${memberId}@example.test`,
          id: memberId,
          status: "active"
        }
      ]
    });
    await database.group.create({ data: { id: groupId, name: `Retrieval ${suffix}` } });
    await database.userGroup.create({ data: { groupId, userId: memberId } });
    await database.providerConnection.create({
      data: {
        activatedAt: now,
        activeConfig: { allowPrivateNetwork: false, apiRoot: "https://embedding.example.test/v1" },
        activeVersion: 1,
        displayName: "Retrieval embedding endpoint",
        draftConfig: {},
        enabled: true,
        family: "openai_compatible",
        id: connectionId
      }
    });
    await database.providerCredential.create({
      data: {
        activatedAt: now,
        connectionId,
        enabled: true,
        id: credentialId,
        label: "Retrieval credential",
        testedAt: now
      }
    });
    await database.providerCredentialVersion.create({
      data: {
        activatedAt: now,
        credentialId,
        id: credentialVersionId,
        secretEnvelope: "integration-fixture-envelope",
        testEvidence: { authenticationMode: "bearer" },
        testedAt: now,
        version: 1
      }
    });
    await database.providerCredential.update({
      data: { activeVersionId: credentialVersionId },
      where: { id: credentialId }
    });
    await database.providerConnection.update({
      data: { defaultCredentialId: credentialId },
      where: { id: connectionId }
    });
    const configuration = embeddingConfiguration();
    await database.providerModel.create({
      data: {
        activatedAt: now,
        activeConfig: configuration,
        activeVersion: 1,
        capabilities: configuration.capabilities,
        connectionId,
        contextWindow: 32_768,
        defaultParams: {},
        displayName: "Retrieval embedding model",
        draftConfig: {},
        enabled: true,
        id: embeddingModelId,
        modelClass: "embedding",
        modelId: configuration.upstreamModelId,
        provider: "openai_compatible"
      }
    });
    await database.providerModelCredentialCheck.create({
      data: {
        checkedAt: now,
        connectionId,
        connectionVersion: 1,
        credentialId,
        credentialVersionId,
        evidence: {},
        modelVersion: 1,
        providerModelId: embeddingModelId,
        status: "available"
      }
    });
    await database.accessGrant.createMany({
      data: [
        { enabled: true, providerModelId: embeddingModelId, userId: ownerId },
        { enabled: true, providerModelId: embeddingModelId, userId: memberId }
      ]
    });

    const created = await knowledge.create(ownerId, {
      description: "Accepted retrieval base",
      embeddingDeploymentId: embeddingModelId,
      name: baseNameSentinel
    });
    const outside = await knowledge.create(ownerId, {
      description: "Outside retrieval base",
      embeddingDeploymentId: embeddingModelId,
      name: `OUTSIDE-BASE-${suffix}`
    });
    if (created.kind !== "ok" || outside.kind !== "ok") {
      throw new Error("retrieval base fixture failed");
    }
    baseId = created.id;
    outsideBaseId = outside.id;
    const active = await database.knowledgeBase.findUniqueOrThrow({
      select: { activeIndexGenerationId: true },
      where: { id: baseId }
    });
    const outsideActive = await database.knowledgeBase.findUniqueOrThrow({
      select: { activeIndexGenerationId: true },
      where: { id: outsideBaseId }
    });
    acceptedGenerationId = active.activeIndexGenerationId!;
    await database.knowledgeBase.update({
      data: { contentRevision: 1 },
      where: { id: baseId }
    });
    await database.knowledgeIndexGeneration.update({
      data: { indexedContentRevision: 1 },
      where: { id: acceptedGenerationId }
    });
    await database.knowledgeBase.update({
      data: { contentRevision: 1 },
      where: { id: outsideBaseId }
    });
    await database.knowledgeIndexGeneration.update({
      data: { indexedContentRevision: 1 },
      where: { id: outsideActive.activeIndexGenerationId! }
    });
    await insertChunk({
      base: baseId,
      chunkId: `accepted-chunk-${suffix}`,
      documentId: `accepted-document-${suffix}`,
      fileName: fileNameSentinel,
      generationId: acceptedGenerationId,
      storageKey: storageSentinel,
      text: "contract passage retained from the accepted revision",
      versionId: `accepted-version-${suffix}`,
      versionNumber: 1,
      visibleFromRevision: 1,
      visibleUntilRevision: 2
    });
    await insertRetrievalDistractors({
      base: baseId,
      generationId: acceptedGenerationId,
      versionId: `accepted-version-${suffix}`
    });
    await insertChunk({
      base: outsideBaseId,
      chunkId: `outside-chunk-${suffix}`,
      documentId: `outside-document-${suffix}`,
      fileName: `OUTSIDE-FILE-${suffix}.pdf`,
      generationId: outsideActive.activeIndexGenerationId!,
      storageKey: `outside/storage/${suffix}`,
      text: "contract passage outside the accepted binding",
      versionId: `outside-version-${suffix}`,
      versionNumber: 1,
      visibleFromRevision: 1
    });
    const publication = await database.knowledgeBasePublication.create({
      data: { groupId, knowledgeBaseId: baseId, publishedByUserId: ownerId, scope: "group" }
    });
    const plan = await loadKnowledgeRunAdmissionPlan(database, {
      knowledgePlan: { baseIds: [baseId] },
      userId: memberId
    });
    chatId = (await database.chat.create({
      data: { title: "Retrieval integration", userId: memberId },
      select: { id: true }
    })).id;
    runId = (await runs.createRun(runInput(plan))).runId;

    // Later content and active-generation changes must not rewrite the accepted tuple.
    await database.knowledgeBase.update({ data: { contentRevision: 2 }, where: { id: baseId } });
    await database.knowledgeIndexGeneration.update({
      data: { indexedContentRevision: 2 },
      where: { id: acceptedGenerationId }
    });
    await insertChunk({
      base: baseId,
      chunkId: `future-revision-chunk-${suffix}`,
      documentId: `future-document-${suffix}`,
      fileName: `FUTURE-FILE-${suffix}.pdf`,
      generationId: acceptedGenerationId,
      storageKey: `future/storage/${suffix}`,
      text: "contract passage from a later content revision",
      versionId: `future-version-${suffix}`,
      versionNumber: 1,
      visibleFromRevision: 2
    });
    const closedRevisionPlan = await loadKnowledgeRunAdmissionPlan(database, {
      knowledgePlan: { baseIds: [baseId] },
      userId: memberId
    });
    closedRevisionChatId = (await database.chat.create({
      data: { title: "Closed revision retrieval integration", userId: memberId },
      select: { id: true }
    })).id;
    closedRevisionRunId = (await runs.createRun(
      runInput(closedRevisionPlan, closedRevisionChatId)
    )).runId;
    await database.knowledgeBase.update({ data: { contentRevision: 3 }, where: { id: baseId } });
    await database.knowledgeIndexGeneration.update({
      data: { indexedContentRevision: 3 },
      where: { id: acceptedGenerationId }
    });
    const laterRevisionPlan = await loadKnowledgeRunAdmissionPlan(database, {
      knowledgePlan: { baseIds: [baseId] },
      userId: memberId
    });
    laterRevisionChatId = (await database.chat.create({
      data: { title: "Later revision retrieval integration", userId: memberId },
      select: { id: true }
    })).id;
    laterRevisionRunId = (await runs.createRun(
      runInput(laterRevisionPlan, laterRevisionChatId)
    )).runId;
    await database.knowledgeBasePublication.delete({ where: { id: publication.id } });
    const acceptedGeneration = await database.knowledgeIndexGeneration.findUniqueOrThrow({
      where: { id: acceptedGenerationId }
    });
    replacementGenerationId = (await database.knowledgeIndexGeneration.create({
      data: {
        activatedAt: now,
        chunkingProfileVersion: acceptedGeneration.chunkingProfileVersion,
        embeddingConfiguration: acceptedGeneration.embeddingConfiguration as Prisma.InputJsonValue,
        embeddingProviderModelId: embeddingModelId,
        indexedContentRevision: 2,
        knowledgeBaseId: baseId,
        readyAt: now,
        status: "active",
        targetDimension: 1024,
        vectorSpaceFingerprint: acceptedGeneration.vectorSpaceFingerprint.trim()
      },
      select: { id: true }
    })).id;
    await database.knowledgeBase.update({
      data: { activeIndexGenerationId: replacementGenerationId },
      where: { id: baseId }
    });
    await insertChunk({
      base: baseId,
      chunkId: `replacement-generation-chunk-${suffix}`,
      documentId: `replacement-document-${suffix}`,
      fileName: `REPLACEMENT-FILE-${suffix}.pdf`,
      generationId: replacementGenerationId,
      storageKey: `replacement/storage/${suffix}`,
      text: "contract passage from the replacement generation",
      versionId: `replacement-version-${suffix}`,
      versionNumber: 1,
      visibleFromRevision: 1
    });
    await database.$executeRaw`ANALYZE "KnowledgeChunk"`;

    firstToolCallId = (await database.modelRunToolCall.create({
      data: {
        arguments: { query: "contract passage" },
        modelRunId: runId,
        ordinal: 0,
        providerCallId: `retrieval-provider-call-${suffix}`,
        roundIndex: 1,
        startedAt: now,
        state: "running",
        toolName: "retrieve_knowledge"
      },
      select: { id: true }
    })).id;
  }, 30_000);

  afterAll(async () => {
    await database.chat.deleteMany({
      where: { id: { in: [chatId, closedRevisionChatId, laterRevisionChatId].filter(Boolean) } }
    });
    await database.knowledgeChunk.deleteMany({
      where: { knowledgeBaseId: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeDocumentVersion.deleteMany({
      where: { knowledgeBaseId: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeDocument.deleteMany({
      where: { knowledgeBaseId: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeBasePublication.deleteMany({
      where: { knowledgeBaseId: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.knowledgeBase.deleteMany({
      where: { id: { in: [baseId, outsideBaseId].filter(Boolean) } }
    });
    await database.providerModelCredentialCheck.deleteMany({ where: { providerModelId: embeddingModelId } });
    await database.accessGrant.deleteMany({ where: { userId: { in: [ownerId, memberId] } } });
    await database.providerModel.deleteMany({ where: { id: embeddingModelId } });
    await database.providerConnection.updateMany({ data: { defaultCredentialId: null }, where: { id: connectionId } });
    await database.providerCredential.updateMany({ data: { activeVersionId: null }, where: { id: credentialId } });
    await database.providerCredentialVersion.deleteMany({ where: { id: credentialVersionId } });
    await database.providerCredential.deleteMany({ where: { id: credentialId } });
    await database.providerConnection.deleteMany({ where: { id: connectionId } });
    await database.userGroup.deleteMany({ where: { groupId } });
    await database.group.deleteMany({ where: { id: groupId } });
    await database.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await database.$disconnect();
  });

  it("serves only the accepted revision/generation after unpublish and persists a private receipt", async () => {
    const embed = vi.fn(async (request: { mode: "document" | "query"; texts: readonly string[] }) => ({
      model: "retrieval-embedding-v1",
      requestId: null,
      usage: { inputTokens: 3, totalTokens: 3 },
      vectors: [unitVector()]
    }));
    const executor = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: async () => ({
          adapter: { embed },
          configuration: embeddingConfiguration(),
          provider: "openai_compatible",
          providerModelId: embeddingModelId
        })
      },
      scoreThreshold: 0.01,
      store
    });
    const result = await executor.execute({
      arguments: { query: "contract passage" },
      id: `retrieval-provider-call-${suffix}`,
      name: "retrieve_knowledge"
    }, {
      persistedToolCallId: firstToolCallId,
      request: {} as never,
      runId,
      userId: memberId
    });
    const evidence = knowledgeEvidenceFromToolResult(result);
    if (!evidence) throw new Error("missing_retrieval_evidence");
    const providerText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(embed).toHaveBeenCalledWith({ mode: "query", texts: ["contract passage"] });
    expect(evidence).toMatchObject({
      outcome: "complete"
    });
    expect(evidence.results[0]).toMatchObject({
      documentVersionId: `accepted-version-${suffix}`,
      documentVersionNumber: 1,
      fileName: fileNameSentinel,
      handle: "K1.1",
      textTruncated: false
    });
    expect(evidence.candidateCount).toBeGreaterThan(0);
    expect(providerText).toContain("contract passage retained from the accepted revision");
    for (const sentinel of [
      baseNameSentinel,
      fileNameSentinel,
      storageSentinel,
      baseId,
      `accepted-version-${suffix}`,
      `outside-chunk-${suffix}`,
      `future-revision-chunk-${suffix}`,
      `replacement-generation-chunk-${suffix}`
    ]) expect(providerText).not.toContain(sentinel);
    const receipt = await database.knowledgeRun.findUniqueOrThrow({
      where: { modelRunToolCallId: firstToolCallId }
    });
    expect(receipt).toMatchObject({
      modelRunId: runId,
      outcome: "complete",
      providerText,
      query: "contract passage"
    });
    expect(receipt.candidateCount).toBe(evidence.candidateCount);
    expect(JSON.stringify(receipt.results)).toContain(fileNameSentinel);
    const inspection = await runs.getRunForUser(runId, memberId);
    expect(inspection?.knowledgeRuns).toEqual([
      expect.objectContaining({
        invocationOrdinal: 1,
        modelRunToolCallId: firstToolCallId,
        outcome: "complete",
        results: expect.any(Array)
      })
    ]);
  });

  it("records a real high-threshold zero outcome and exposes ANN plus FTS indexes", async () => {
    const second = await database.modelRunToolCall.create({
      data: {
        arguments: { query: "contract passage" },
        modelRunId: runId,
        ordinal: 0,
        providerCallId: `retrieval-provider-call-high-${suffix}`,
        roundIndex: 2,
        startedAt: new Date(),
        state: "running",
        toolName: "retrieve_knowledge"
      }
    });
    const executor = createKnowledgeToolExecutor({
      embeddingRuntime: {
        resolve: async () => ({
          adapter: {
            embed: async () => ({
              model: "retrieval-embedding-v1",
              requestId: null,
              usage: { inputTokens: 2, totalTokens: 2 },
              vectors: [unitVector()]
            })
          },
          configuration: embeddingConfiguration(),
          provider: "openai_compatible",
          providerModelId: embeddingModelId
        })
      },
      scoreThreshold: 1,
      store
    });
    const result = await executor.execute({
      arguments: { query: "contract passage" },
      id: second.providerCallId,
      name: "retrieve_knowledge"
    }, {
      persistedToolCallId: second.id,
      request: {} as never,
      runId,
      userId: memberId
    });
    const evidence = knowledgeEvidenceFromToolResult(result);
    if (!evidence) throw new Error("missing_high_threshold_evidence");
    expect(evidence).toMatchObject({
      outcome: "zero_above_threshold",
      results: []
    });
    expect(evidence.candidateCount).toBeGreaterThan(0);

    const statement = knowledgeHybridRetrievalSql({
      candidateLimit: 40,
      query: "contract passage",
      resultLimit: 8,
      runId,
      threshold: 0.01,
      userId: memberId,
      vectors: [{
        bindingOrdinal: 0,
        indexGenerationId: acceptedGenerationId,
        knowledgeBaseId: baseId,
        targetDimension: 1024,
        vector: unitVector()
      }]
    });
    const annPlan = await database.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      return tx.$queryRaw<unknown[]>(Prisma.sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${statement}`);
    });
    const ftsPlan = await database.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
      return tx.$queryRaw<unknown[]>(Prisma.sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${statement}`);
    });
    expect(JSON.stringify(annPlan)).toContain("KnowledgeChunk_embedding_1024_hnsw_idx");
    expect(JSON.stringify(ftsPlan)).toContain("KnowledgeChunk_searchVector_gin_idx");
  });

  it("keeps the prior version at revision one and excludes it at its exclusive revision-two bound", async () => {
    const vectorOnly = await database.$queryRaw<unknown[]>(knowledgeHybridRetrievalSql({
      candidateLimit: 40,
      query: `no-lexical-match-${suffix}`,
      resultLimit: 40,
      runId: closedRevisionRunId,
      threshold: 0,
      userId: memberId,
      vectors: [{
        bindingOrdinal: 0,
        indexGenerationId: acceptedGenerationId,
        knowledgeBaseId: baseId,
        targetDimension: 1024,
        vector: unitVector()
      }]
    }));
    const lexicalOnly = await database.$queryRaw<unknown[]>(knowledgeHybridRetrievalSql({
      candidateLimit: 40,
      query: "retained accepted revision",
      resultLimit: 40,
      runId: closedRevisionRunId,
      threshold: 0,
      userId: memberId,
      vectors: [{
        bindingOrdinal: 0,
        indexGenerationId: acceptedGenerationId,
        knowledgeBaseId: baseId,
        targetDimension: 1024,
        vector: orthogonalVector()
      }]
    }));

    expect(JSON.stringify(vectorOnly)).not.toContain(`accepted-version-${suffix}`);
    expect(JSON.stringify(lexicalOnly)).not.toContain(`accepted-version-${suffix}`);

    const laterRevision = await database.$queryRaw<unknown[]>(knowledgeHybridRetrievalSql({
      candidateLimit: 40,
      query: "retained accepted revision",
      resultLimit: 40,
      runId: laterRevisionRunId,
      threshold: 0,
      userId: memberId,
      vectors: [{
        bindingOrdinal: 0,
        indexGenerationId: acceptedGenerationId,
        knowledgeBaseId: baseId,
        targetDimension: 1024,
        vector: unitVector()
      }]
    }));
    expect(JSON.stringify(laterRevision)).not.toContain(`accepted-version-${suffix}`);
  });
});
