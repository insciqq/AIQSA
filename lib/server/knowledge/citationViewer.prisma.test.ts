import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import type { StorageAdapter } from "../uploads/storage";
import { resolveKnowledgeCitationViewer } from "./citationViewer";
import { createPrismaKnowledgeDeletionProcessor } from "./deletionProcessor";
import { createPrismaKnowledgeLifecycleRepository } from "./lifecycleRepository";

const unavailableViewerStorage: StorageAdapter = {
  async deleteObject() {},
  async getObject() {
    throw new Error("unexpected_viewer_storage_read");
  },
  async putObject() {}
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function cleanup(ownerUserId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
    await tx.chat.deleteMany({ where: { userId: ownerUserId } });
    await tx.knowledgeDeletionJob.deleteMany({ where: { ownerUserId } });
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId } });
    await tx.user.deleteMany({ where: { id: ownerUserId } });
  });
}

describe("Prisma Knowledge citation viewer after permanent deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns only answer-cited metadata-free tombstones after a real Source purge", async () => {
    const suffix = randomUUID();
    const ownerUserId = `citation-purge-owner-${suffix}`;
    const privateSourceName = `Private citation source ${suffix}`;
    const privateFileName = `private-citation-${suffix}.md`;
    const privateSourceVersionId = `private-version-${suffix}`;
    const privateSourceArtifactId = `private-artifact-${suffix}`;
    const privateBaseId = `private-base-${suffix}`;
    const citedExcerpt = `private cited excerpt ${suffix}`;
    const undispatchedExcerpt = `private undispatched excerpt ${suffix}`;

    await prisma.user.create({
      data: { displayName: "Citation purge owner", id: ownerUserId, status: "active" }
    });

    try {
      const source = await prisma.knowledgeSource.create({
        data: { name: privateSourceName, ownerUserId },
        select: { id: true }
      });
      const chat = await prisma.chat.create({
        data: { title: "Citation purge regression", userId: ownerUserId },
        select: { id: true }
      });
      const userMessage = await prisma.message.create({
        data: { chatId: chat.id, content: { text: "Question" }, role: "user" },
        select: { id: true }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: { text: "Final grounded answer [K1]." },
          parentMessageId: userMessage.id,
          role: "assistant"
        },
        select: { id: true }
      });
      const run = await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: chat.id,
          modelId: "test-model",
          normalizedRequest: {},
          provider: "test",
          status: "complete",
          userId: ownerUserId,
          userMessageId: userMessage.id
        },
        select: { id: true }
      });
      const session = await prisma.knowledgeRetrievalSession.create({
        data: {
          citationContract: {
            format: "K{ordinal}",
            legacyRead: true,
            maximum: 2048,
            version: 2
          },
          degradedFlags: [],
          modelRunId: run.id,
          nextEvidenceOrdinal: 3,
          originalIntent: { kind: "focused_v1", request: { private: suffix } },
          readinessSummary: { excludedResources: 0, readyBases: 0, readySources: 1 },
          scopeSnapshot: {
            selection: { baseIds: [], mode: "explicit", sourceIds: [source.id], version: 1 }
          },
          version: 2
        },
        select: { id: true }
      });

      const evidenceItems = await Promise.all([
        { excerpt: citedExcerpt, handle: "K1", ordinal: 1 },
        { excerpt: undispatchedExcerpt, handle: "K2", ordinal: 2 }
      ].map(({ excerpt, handle, ordinal }) => prisma.knowledgeEvidenceItem.create({
        data: {
          baseName: "Private base",
          contentHash: sha256(excerpt),
          contextBoundaries: { ordinal },
          documentId: source.id,
          documentVersionId: privateSourceVersionId,
          evidenceKey: sha256(`${suffix}:${handle}`),
          excerpt,
          excerptBytes: Buffer.byteLength(excerpt),
          fileName: privateFileName,
          handle,
          headingPath: ["Private"],
          knowledgeBaseId: privateBaseId,
          locator: { page: ordinal },
          ordinal,
          page: ordinal,
          passageId: `private-passage-${ordinal}-${suffix}`,
          retrievalSessionId: session.id,
          sourceArtifactId: privateSourceArtifactId,
          sourceId: source.id,
          sourceName: privateSourceName,
          sourceTextBytes: Buffer.byteLength(excerpt),
          sourceVersionId: privateSourceVersionId,
          sourceVersionNumber: 1,
          state: "available",
          textTruncated: false
        },
        select: { id: true }
      })));

      await prisma.providerRunBinding.create({
        data: {
          bindingKey: "answer",
          credentialSource: "default",
          executionSnapshot: { synthetic: true },
          modelRunId: run.id,
          role: "answer"
        }
      });
      const usage = {
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        estimatedCostMicros: 0,
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: null,
        totalTokens: 2
      };
      const attempt = await prisma.knowledgeProviderAttempt.create({
        data: {
          checkpointHash: "a".repeat(64),
          estimatedUsage: usage,
          idempotencyKey: `citation-purge:${suffix}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseToken: `citation-purge-lease:${suffix}`,
          modelRunId: run.id,
          ordinal: 1,
          providerBindingKey: "answer",
          purpose: "answer",
          requestHash: "b".repeat(64),
          roundIndex: 0,
          state: "reserved"
        },
        select: { id: true }
      });
      const renderedBlock = `[K1] ${privateSourceName}\n${citedExcerpt}`;
      await prisma.knowledgeEvidenceDispatchManifest.create({
        data: {
          coverage: { includedHandles: ["K1"] },
          excludedCount: 0,
          itemCount: 1,
          items: {
            create: {
              contextBoundaries: { ordinal: 1 },
              evidenceItemId: evidenceItems[0]!.id,
              exactExcerpt: citedExcerpt,
              excerptBytes: Buffer.byteLength(citedExcerpt),
              excerptHash: sha256(citedExcerpt),
              handle: "K1",
              ordinal: 0,
              renderedBlock,
              renderedBlockHash: sha256(renderedBlock),
              renderedBytes: Buffer.byteLength(renderedBlock),
              renderedTokens: 4,
              representation: "full",
              safeMetadata: { sourceLabel: privateSourceName },
              sourceAlias: "S1",
              sourceArtifactId: privateSourceArtifactId,
              sourceVersionId: privateSourceVersionId
            }
          },
          messageHash: sha256(renderedBlock),
          messageText: renderedBlock,
          modelRunId: run.id,
          packingVersion: "knowledge_evidence_pack_v1",
          profileRevisionIds: [],
          promptFragmentVersion: "knowledge_evidence_prompt_v1",
          providerAttemptId: attempt.id,
          retrievalSessionId: session.id,
          shortenedCount: 0,
          totalBytes: Buffer.byteLength(renderedBlock),
          totalTokens: 4,
          version: 1
        }
      });
      const settledAt = new Date();
      await prisma.knowledgeProviderAttempt.update({
        data: {
          actualUsage: usage,
          dispatchedAt: settledAt,
          leaseExpiresAt: null,
          leaseToken: null,
          settledAt,
          state: "settled"
        },
        where: { id: attempt.id }
      });

      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteSource(ownerUserId, source.id, 2))
        .resolves.toEqual({ kind: "pending" });

      const job = await prisma.knowledgeDeletionJob.findUniqueOrThrow({
        where: { targetType_targetId: { targetId: source.id, targetType: "SOURCE" } }
      });
      const claimedAt = new Date();
      const claimToken = randomUUID();
      await expect(prisma.knowledgeDeletionJob.updateMany({
        data: {
          attemptCount: { increment: 1 },
          claimedAt,
          claimToken,
          lastAttemptAt: claimedAt,
          leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
          state: "RUNNING"
        },
        where: { id: job.id, state: "PENDING" }
      })).resolves.toEqual({ count: 1 });
      await expect(createPrismaKnowledgeDeletionProcessor(prisma).process({
        claimToken,
        id: job.id,
        ownerUserId,
        targetId: source.id,
        targetType: "SOURCE"
      }, claimedAt)).resolves.toBe("completed");

      const tombstones = await prisma.knowledgeEvidenceItem.findMany({
        orderBy: { ordinal: "asc" },
        where: { retrievalSessionId: session.id }
      });
      expect(tombstones).toHaveLength(2);
      for (const tombstone of tombstones) {
        expect(tombstone).toMatchObject({
          baseName: null,
          contentHash: null,
          contextBoundaries: null,
          documentId: null,
          documentVersionId: null,
          evidenceKey: null,
          excerpt: null,
          excerptBytes: null,
          fileName: null,
          headingPath: [],
          knowledgeBaseId: null,
          locator: null,
          page: null,
          passageId: null,
          sectionId: null,
          sourceArtifactId: null,
          sourceId: null,
          sourceName: null,
          sourceTextBytes: null,
          sourceVersionId: null,
          sourceVersionNumber: null,
          state: "deleted",
          textTruncated: null
        });
      }
      expect(JSON.stringify(tombstones)).not.toMatch(
        /private cited|private undispatched|private-citation|Private citation source/u
      );

      await expect(resolveKnowledgeCitationViewer(prisma, unavailableViewerStorage, {
        assistantMessageId: assistantMessage.id,
        handle: "K1",
        runId: run.id,
        userId: ownerUserId
      })).resolves.toEqual({
        citation: { handle: "K1", state: "deleted" },
        original: null
      });
      await expect(resolveKnowledgeCitationViewer(prisma, unavailableViewerStorage, {
        assistantMessageId: assistantMessage.id,
        handle: "K2",
        runId: run.id,
        userId: ownerUserId
      })).resolves.toBeNull();
    } finally {
      await cleanup(ownerUserId);
    }
  });
});
