import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaAdminRepository } from "../auth/adminRepository";
import { listAdminDashboard } from "../auth/adminDashboardQueries";
import { prisma } from "../prisma";
import {
  createPrismaRetentionRepository,
  drainDeletionObligations
} from "../retention/prune";
import { createPrismaKnowledgeLifecycleRepository } from "./lifecycleRepository";
import { createAccountKnowledgeDeletionHook } from "./accountDeletion";
import {
  groundKnowledgeRunAnswer,
  loadKnowledgeEvidencePackage,
  settleKnowledgeGrounding
} from "./evidenceRepository";
import { knowledgeEvidenceReceiptHash } from "./evidencePackage";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";

const checksum = "a".repeat(64);

async function cleanup(input: Readonly<{
  baseIds: readonly string[];
  ownerUserId: string;
  storageKeys?: readonly string[];
}>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
    await tx.sharedChatSnapshot.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.chat.deleteMany({ where: { userId: input.ownerUserId } });
    await tx.knowledgeDeletionJob.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1GenerationArtifactMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1DocumentSourceMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocumentVersion.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocument.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeUploadBatch.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: [...input.baseIds] } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: [...input.baseIds] } } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId: input.ownerUserId }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId: input.ownerUserId } }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    if (input.storageKeys && input.storageKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: [...input.storageKeys] } }
      });
    }
    await tx.user.deleteMany({ where: { id: input.ownerUserId } });
  });
}

describe("Prisma Knowledge trash and permanent deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is idempotent, tombstones Source evidence, and settles every object", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-delete-owner-" + suffix;
    const originalStorageKey = "knowledge-delete/" + suffix + "/original";
    const normalizedStorageKey = "knowledge-delete/" + suffix + "/normalized";
    await prisma.user.create({
      data: { displayName: "Knowledge deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Product docs", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Private guide", ownerUserId },
      select: { id: true }
    });
    const sourceVersion = await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 128,
        checksum,
        fileName: "private-guide.md",
        mimeType: "text/markdown",
        originalStorageKey,
        ownerUserId,
        sourceId: source.id,
        versionNumber: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeSource.update({
      data: { currentVersionId: sourceVersion.id },
      where: { id: source.id }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    const uploadBatch = await prisma.knowledgeUploadBatch.create({
      data: {
        clientBatchId: `delete-source-${suffix}`,
        items: {
          create: {
            clientFileId: "deleted-source-file",
            declaredByteSize: 128,
            declaredMimeType: "text/markdown",
            fileName: "private-guide.md",
            normalizedMimeType: "text/markdown",
            sessionExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
            settledAt: new Date(),
            sourceId: source.id,
            state: "REUSED",
            transport: "PROXY",
            uploadedByteSize: 128
          }
        },
        knowledgeBaseId: base.id,
        ownerUserId
      },
      select: { id: true }
    });
    const document = await prisma.knowledgeDocument.create({
      data: { knowledgeBaseId: base.id },
      select: { id: true }
    });
    const documentVersion = await prisma.knowledgeDocumentVersion.create({
      data: {
        byteSize: 128,
        checksum,
        documentId: document.id,
        fileName: "private-guide.md",
        ingestCompletedAt: new Date(),
        ingestState: "ready",
        knowledgeBaseId: base.id,
        mimeType: "text/markdown",
        normalizedTextByteSize: 64,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: normalizedStorageKey,
        originalStorageKey,
        ownerUserId,
        versionNumber: 1,
        visibleFromRevision: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeDocument.update({
      data: { currentVersionId: documentVersion.id },
      where: { id: document.id }
    });
    await prisma.knowledgeV1DocumentSourceMap.create({
      data: {
        documentId: document.id,
        knowledgeBaseId: base.id,
        ownerUserId,
        sourceId: source.id
      }
    });
    await prisma.knowledgeV1DocumentVersionSourceMap.create({
      data: {
        documentId: document.id,
        documentVersionId: documentVersion.id,
        knowledgeBaseId: base.id,
        ownerUserId,
        sourceId: source.id,
        sourceVersionId: sourceVersion.id
      }
    });

    const chat = await prisma.chat.create({
      data: { title: "Deletion evidence", userId: ownerUserId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: { text: "question" }, role: "user" },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "test-model",
        normalizedRequest: { knowledgePlan: { baseIds: [base.id] } },
        provider: "test",
        status: "complete",
        userId: ownerUserId,
        userMessageId: message.id
      },
      select: { id: true }
    });
    const evidenceSession = await prisma.knowledgeRetrievalSession.create({
      data: {
        citationContract: {
          format: "K{ordinal}",
          legacyRead: true,
          maximum: 2048,
          version: 2
        },
        coverageRequirements: {
          expectedPassageCount: 1,
          mode: "verified_only",
          namedTargets: [],
          verified: false
        },
        degradedFlags: [],
        modelRunId: run.id,
        nextEvidenceOrdinal: 2,
        originalIntent: { intent: "fact_lookup", query: "private guide" },
        readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 1 },
        scopeSnapshot: {
          budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          selection: { baseIds: [base.id], mode: "explicit", sourceIds: [source.id], version: 1 }
        },
        strategySnapshot: { strategy: "focused" },
        version: 2
      },
      select: { id: true }
    });
    const toolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: { query: "private guide" },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: "knowledge-" + suffix,
        result: { fileName: "private-guide.md", locator: "page 7" },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "knowledge_search"
      },
      select: { id: true }
    });
    const includedText = "private deletion marker";
    const evidenceItem = await prisma.knowledgeEvidenceItem.create({
      data: {
        baseName: "Product docs",
        contentHash: "b".repeat(64),
        contextBoundaries: {
          expanded: false,
          excerptBytes: Buffer.byteLength(includedText),
          sourceTextBytes: Buffer.byteLength(includedText)
        },
        documentId: document.id,
        documentVersionId: documentVersion.id,
        evidenceKey: "c".repeat(64),
        excerpt: includedText,
        excerptBytes: Buffer.byteLength(includedText),
        fileName: "private-guide.md",
        handle: "K1",
        headingPath: ["Deletion"],
        knowledgeBaseId: base.id,
        locator: { page: 7 },
        ordinal: 1,
        page: 7,
        passageId: `private-passage-${suffix}`,
        retrievalSessionId: evidenceSession.id,
        sectionId: `private-section-${suffix}`,
        sourceArtifactId: `private-artifact-${suffix}`,
        sourceId: source.id,
        sourceName: "Private guide",
        sourceTextBytes: Buffer.byteLength(includedText),
        sourceVersionId: sourceVersion.id,
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      },
      select: { id: true }
    });
    const knowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ knowledgeBaseId: base.id, name: "Product docs" }],
        candidateCount: 1,
        candidateLimit: 12,
        durationMs: 4,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: run.id,
        modelRunToolCallId: toolCall.id,
        operation: "automatic_search",
        outcome: "complete",
        providerText: "[K1] private-guide.md\n" + includedText,
        query: "private guide",
        retrievalSessionId: evidenceSession.id,
        resultLimit: 8,
        results: [{
          documentVersionId: documentVersion.id,
          fileName: "private-guide.md",
          handle: "K1",
          includedText,
          knowledgeBaseId: base.id,
          locator: { page: 7 },
          sourceId: source.id
        }],
        threshold: 0.2
      },
      select: { id: true }
    });
    await prisma.knowledgeRunEvidence.create({
      data: {
        evidenceItemId: evidenceItem.id,
        knowledgeRunId: knowledgeRun.id,
        resultOrdinal: 0,
        retrievalProvenance: {
          confidence: null,
          confidenceBucket: "unavailable",
          fusion: "rrf_k60",
          invocationOrdinal: 1,
          operation: "automatic_search",
          postRerankRank: 1,
          preRerankRank: 1,
          rerankScore: null,
          signals: [],
          version: 1
        }
      }
    });
    const grounded = await groundKnowledgeRunAnswer(prisma, {
      answer: "The private deletion marker is present [K1].",
      runId: run.id,
      userId: ownerUserId
    });
    expect(grounded).toMatchObject({ outcome: "passed", repairCount: 0 });
    await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
    const acceptedReceiptHash = grounded!.receiptHash;
    const share = await prisma.sharedChatSnapshot.create({
      data: {
        chatId: chat.id,
        ownerUserId,
        slugHash: "slug-" + suffix,
        snapshot: { messages: [], version: 1 },
        title: "Deletion evidence"
      },
      select: { id: true }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(prisma.knowledgeBase.findUnique({
        select: { sourceRevision: true, version: true },
        where: { id: base.id }
      })).resolves.toEqual({ sourceRevision: 2, version: 2 });
      await expect(lifecycle.restoreSource(ownerUserId, source.id, 2))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.restoreSource(ownerUserId, source.id, 2))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.trashSource(ownerUserId, source.id, 3))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteSource(ownerUserId, source.id, 4))
        .resolves.toEqual({ kind: "pending" });

      const deletedObjects: string[] = [];
      const summary = await drainDeletionObligations({
        batchSize: 20,
        repository: createPrismaRetentionRepository(prisma),
        storage: {
          async deleteObject(storageKey) {
            deletedObjects.push(storageKey);
          }
        }
      });
      expect(summary.exhausted).toBe(false);
      expect(summary.attachmentJobs.failed).toBe(0);
      expect(deletedObjects.sort()).toEqual([normalizedStorageKey, originalStorageKey].sort());
      await expect(prisma.knowledgeSource.findUnique({ where: { id: source.id } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeBase.findUnique({ where: { id: base.id } }))
        .resolves.toMatchObject({ id: base.id });
      await expect(prisma.knowledgeBaseSource.count({
        where: { knowledgeBaseId: base.id, sourceId: source.id }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeUploadBatch.findUnique({ where: { id: uploadBatch.id } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeDeletionJob.findFirst({
        select: { state: true },
        where: { targetId: source.id, targetType: "SOURCE" }
      })).resolves.toEqual({ state: "SUCCEEDED" });
      await expect(prisma.knowledgeDeletionObject.findMany({
        orderBy: { storageKey: "asc" },
        select: { disposition: true, storageKey: true },
        where: { job: { targetId: source.id, targetType: "SOURCE" } }
      })).resolves.toEqual([]);

      const historical = await prisma.knowledgeRun.findUnique({
        select: { providerText: true, results: true },
        where: { id: knowledgeRun.id }
      });
      expect(historical).toEqual({
        providerText: "Knowledge passages:\n\n[K1] Deleted Knowledge source.",
        results: [{ deleted: true, handle: "K1" }]
      });
      expect(JSON.stringify(historical)).not.toMatch(
        /private-guide|private deletion marker|documentVersionId|sourceId/u
      );
      await expect(prisma.modelRunToolCall.findUnique({
        select: { result: true },
        where: { id: toolCall.id }
      })).resolves.toEqual({ result: null });
      await expect(prisma.sharedChatSnapshot.findUnique({
        select: { revokedAt: true },
        where: { id: share.id }
      })).resolves.toMatchObject({ revokedAt: expect.any(Date) });

      const tombstone = await prisma.knowledgeEvidenceItem.findUnique({
        where: { id: evidenceItem.id }
      });
      expect(tombstone).toMatchObject({
        baseName: null,
        contentHash: null,
        contextBoundaries: null,
        documentId: null,
        documentVersionId: null,
        evidenceKey: null,
        excerpt: null,
        fileName: null,
        handle: "K1",
        headingPath: [],
        knowledgeBaseId: null,
        locator: null,
        page: null,
        passageId: null,
        sourceArtifactId: null,
        sourceId: null,
        sourceName: null,
        sourceVersionId: null,
        state: "deleted"
      });
      expect(JSON.stringify(tombstone)).not.toMatch(
        /private-guide|private deletion marker|private-artifact|private-section/u
      );
      const tombstonedReceipt = await loadKnowledgeEvidencePackage(prisma, {
        runId: run.id,
        userId: ownerUserId
      });
      expect(tombstonedReceipt).toMatchObject({
        degradedFlags: ["evidence_deleted"],
        items: [{ handle: "K1", provenance: [], state: "deleted" }]
      });
      await expect(prisma.knowledgeRunEvidence.count({
        where: { evidenceItemId: evidenceItem.id }
      })).resolves.toBe(0);
      const tombstonedHash = knowledgeEvidenceReceiptHash(tombstonedReceipt!);
      expect(tombstonedHash).not.toBe(acceptedReceiptHash);
      await expect(prisma.knowledgeRetrievalSession.findUnique({
        select: { receiptHash: true },
        where: { id: evidenceSession.id }
      })).resolves.toEqual({ receiptHash: tombstonedHash });
    } finally {
      await cleanup({
        baseIds: [base.id],
        ownerUserId,
        storageKeys: [originalStorageKey, normalizedStorageKey]
      });
    }
  });

  it("allows only one winner when restore races permanent Source deletion", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-delete-race-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Knowledge deletion race owner", id: ownerUserId, status: "active" }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Racing Source", ownerUserId },
      select: { id: true }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });

      const outcomes = await Promise.all([
        lifecycle.restoreSource(ownerUserId, source.id, 2),
        lifecycle.permanentlyDeleteSource(ownerUserId, source.id, 2)
      ]);
      expect(outcomes.filter((outcome) => outcome.kind === "version_conflict"))
        .toHaveLength(1);
      const winner = outcomes.find((outcome) => outcome.kind !== "version_conflict");
      expect(["ok", "pending"]).toContain(winner?.kind);

      const persisted = await prisma.knowledgeSource.findUniqueOrThrow({
        select: { deletionRequestedAt: true, trashedAt: true, version: true },
        where: { id: source.id }
      });
      const deletionJobs = await prisma.knowledgeDeletionJob.count({
        where: { targetId: source.id, targetType: "SOURCE" }
      });
      if (winner?.kind === "pending") {
        expect(persisted).toEqual({
          deletionRequestedAt: expect.any(Date),
          trashedAt: expect.any(Date),
          version: 3
        });
        expect(deletionJobs).toBe(1);
      } else {
        expect(persisted).toEqual({ deletionRequestedAt: null, trashedAt: null, version: 3 });
        expect(deletionJobs).toBe(0);
      }
    } finally {
      await cleanup({ baseIds: [], ownerUserId });
    }
  });

  it("purges a Base without deleting its independently owned Sources", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-base-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Base deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Disposable Base", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Reusable Source", ownerUserId },
      select: { id: true }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    const proxyStorageKey = `knowledge/uploads/${suffix}/proxy`;
    const multipartStorageKey = `knowledge/uploads/${suffix}/multipart`;
    await prisma.knowledgeUploadBatch.create({
      data: {
        clientBatchId: `base-delete-${suffix}`,
        items: {
          create: [
            {
              clientFileId: "proxy-file",
              declaredByteSize: 12,
              declaredMimeType: "text/markdown",
              fileName: "proxy.md",
              normalizedMimeType: "text/markdown",
              sessionExpiresAt: new Date(Date.now() + 60_000),
              storageKey: proxyStorageKey,
              transport: "PROXY"
            },
            {
              clientFileId: "multipart-file",
              declaredByteSize: 12,
              declaredMimeType: "text/markdown",
              fileName: "multipart.md",
              multipartUploadId: "multipart-upload-id",
              normalizedMimeType: "text/markdown",
              sessionExpiresAt: new Date(Date.now() + 60_000),
              storageKey: multipartStorageKey,
              transport: "MULTIPART"
            }
          ]
        },
        knowledgeBaseId: base.id,
        ownerUserId
      }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashBase(ownerUserId, base.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteBase(ownerUserId, base.id, 2))
        .resolves.toEqual({ kind: "pending" });
      const deletedObjects: string[] = [];
      const abortedUploads: Array<{ storageKey: string; uploadId: string }> = [];
      const summary = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: {
          async deleteObject(storageKey) {
            deletedObjects.push(storageKey);
          },
          directMultipartUpload: {
            async abortMultipartUpload(input) {
              abortedUploads.push(input);
            },
            async completeMultipartUpload() {},
            async createMultipartUpload() {
              return { uploadId: "unused" };
            },
            async presignMultipartPart() {
              return "https://storage.example.test/unused";
            }
          }
        }
      });
      expect(summary.knowledgeJobs.failed).toBe(0);
      expect(abortedUploads).toEqual([{
        storageKey: multipartStorageKey,
        uploadId: "multipart-upload-id"
      }]);
      expect(deletedObjects.sort()).toEqual([multipartStorageKey, proxyStorageKey].sort());
      await expect(prisma.knowledgeBase.findUnique({ where: { id: base.id } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeUploadBatch.count({
        where: { knowledgeBaseId: base.id }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeSource.findUnique({ where: { id: source.id } }))
        .resolves.toMatchObject({ id: source.id, name: "Reusable Source" });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("scrubs a deleted Base from an empty-result historical receipt", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-base-receipt-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Base receipt deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Private empty Base", ownerUserId },
      select: { id: true }
    });
    const chat = await prisma.chat.create({
      data: { title: "Empty Knowledge receipt", userId: ownerUserId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: { text: "question" }, role: "user" },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "test-model",
        normalizedRequest: { knowledgePlan: { baseIds: [base.id] } },
        provider: "test",
        status: "complete",
        userId: ownerUserId,
        userMessageId: message.id
      },
      select: { id: true }
    });
    const toolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: { query: "private empty base" },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: "knowledge-empty-" + suffix,
        result: {
          bases: [{ baseName: "Private empty Base", knowledgeBaseId: base.id }],
          results: []
        },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "retrieve_knowledge"
      },
      select: { id: true }
    });
    const knowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ baseName: "Private empty Base", knowledgeBaseId: base.id }],
        candidateCount: 0,
        candidateLimit: 12,
        durationMs: 4,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: run.id,
        modelRunToolCallId: toolCall.id,
        outcome: "base_empty",
        providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
        query: "private empty base",
        resultLimit: 8,
        results: [],
        threshold: 0.2
      },
      select: { id: true }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashBase(ownerUserId, base.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteBase(ownerUserId, base.id, 2))
        .resolves.toEqual({ kind: "pending" });
      const summary = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(summary.knowledgeJobs.failed).toBe(0);

      const historical = await prisma.knowledgeRun.findUnique({
        select: { baseEvidence: true, providerText: true, results: true },
        where: { id: knowledgeRun.id }
      });
      expect(historical).toEqual({
        baseEvidence: [{ deleted: true }],
        providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
        results: []
      });
      expect(JSON.stringify(historical)).not.toContain(base.id);
      expect(JSON.stringify(historical)).not.toContain("Private empty Base");
      await expect(prisma.modelRunToolCall.findUnique({
        select: { result: true },
        where: { id: toolCall.id }
      })).resolves.toEqual({ result: null });
      await expect(prisma.modelRun.findUnique({
        select: { normalizedRequest: true },
        where: { id: run.id }
      })).resolves.toEqual({ normalizedRequest: { knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 } } });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("stages expired Source trash before Base trash and leaves newer trash alone", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-retention-owner-" + suffix;
    const oldTrashTime = new Date("2000-01-01T00:00:00.000Z");
    const cutoff = new Date("2001-01-01T00:00:00.000Z");
    const newerTrashTime = new Date("2002-01-01T00:00:00.000Z");
    const now = new Date("2026-08-18T04:00:00.000Z");
    await prisma.user.create({
      data: { displayName: "Knowledge retention owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Expired Base", ownerUserId, trashedAt: oldTrashTime },
      select: { id: true }
    });
    const expiredSource = await prisma.knowledgeSource.create({
      data: { name: "Expired Source", ownerUserId, trashedAt: oldTrashTime },
      select: { id: true }
    });
    const newerSource = await prisma.knowledgeSource.create({
      data: { name: "Newer Source", ownerUserId, trashedAt: newerTrashTime },
      select: { id: true }
    });

    try {
      const repository = createPrismaRetentionRepository(prisma);
      await expect(repository.stageExpiredKnowledgeTrash({ cutoff, limit: 1, now }))
        .resolves.toEqual({ bases: 0, jobsStaged: 1, sources: 1 });
      await expect(prisma.knowledgeDeletionJob.findMany({
        orderBy: { id: "asc" },
        select: { targetId: true, targetType: true },
        where: { ownerUserId }
      })).resolves.toEqual([{ targetId: expiredSource.id, targetType: "SOURCE" }]);

      await expect(repository.stageExpiredKnowledgeTrash({ cutoff, limit: 1, now }))
        .resolves.toEqual({ bases: 1, jobsStaged: 1, sources: 0 });
      const jobs = await prisma.knowledgeDeletionJob.findMany({
        select: { targetId: true, targetType: true },
        where: { ownerUserId }
      });
      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(expect.arrayContaining([
        { targetId: expiredSource.id, targetType: "SOURCE" },
        { targetId: base.id, targetType: "BASE" }
      ]));
      await expect(prisma.knowledgeSource.findUnique({
        select: { deletionRequestedAt: true },
        where: { id: newerSource.id }
      })).resolves.toEqual({ deletionRequestedAt: null });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("holds account deletion until every owned Knowledge obligation settles", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-account-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Disabled Knowledge owner", id: ownerUserId, status: "disabled" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Account Base", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Account Source", ownerUserId },
      select: { id: true }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    let kicks = 0;
    const admin = createPrismaAdminRepository(prisma, {
      accountKnowledgeDeletionHook: () => createAccountKnowledgeDeletionHook({
        kick: () => {
          kicks += 1;
        }
      })
    });

    try {
      const dashboard = await listAdminDashboard(prisma, {
        actingAdminUserId: "admin-" + suffix,
        now: new Date("2026-08-18T04:00:00.000Z")
      });
      expect(dashboard.users.find((user) => user.id === ownerUserId)?.deletion)
        .toMatchObject({ canDelete: true, reason: null });
      expect(dashboard.users.find((user) => user.id === ownerUserId)?.deletion.summary)
        .toMatch(/Memory or Knowledge/u);

      await expect(admin.deleteStaleUser({
        actingAdminUserId: "admin-" + suffix,
        userId: ownerUserId
      })).resolves.toBe("deletion_pending");
      expect(kicks).toBe(1);
      await expect(prisma.knowledgeDeletionJob.count({
        where: { ownerUserId }
      })).resolves.toBe(2);
      await expect(prisma.knowledgeBase.findUnique({
        select: { deletionRequestedAt: true, trashedAt: true },
        where: { id: base.id }
      })).resolves.toMatchObject({
        deletionRequestedAt: expect.any(Date),
        trashedAt: expect.any(Date)
      });

      const drained = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(drained.knowledgeJobs.failed).toBe(0);
      await expect(admin.deleteStaleUser({
        actingAdminUserId: "admin-" + suffix,
        userId: ownerUserId
      })).resolves.toBe("deleted");
      await expect(prisma.user.findUnique({ where: { id: ownerUserId } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeDeletionJob.count({
        where: { ownerUserId }
      })).resolves.toBe(0);
    } finally {
      if (await prisma.user.count({ where: { id: ownerUserId } })) {
        await cleanup({ baseIds: [base.id], ownerUserId });
      }
    }
  });
});
