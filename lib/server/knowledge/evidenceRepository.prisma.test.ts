import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "./knowledgeProfile";
import {
  groundKnowledgeRunAnswer,
  loadKnowledgeEvidencePackage,
  settleKnowledgeGrounding
} from "./evidenceRepository";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievedPassageEvidence
} from "./retrievalTypes";
import { createKnowledgeFocusedRequest } from "./focusedRequest";

const vectorSpaceFingerprint = "e".repeat(64);
const evidenceProfileFixture = Object.freeze({
  connectionId: "knowledge-evidence-v2-test-connection",
  credentialId: "knowledge-evidence-v2-test-credential",
  credentialVersionId: "knowledge-evidence-v2-test-credential-version",
  profileId: "knowledge-evidence-v2-test-profile",
  profileRevisionId: "knowledge-evidence-v2-test-profile-revision",
  providerModelId: "knowledge-evidence-v2-test-model"
});

type RunFixture = Readonly<{
  chatId: string;
  runId: string;
  userId: string;
}>;

async function createRunFixture(input: Readonly<{
  query: string;
  readyBases: number;
  readySources: number;
}>): Promise<RunFixture> {
  const suffix = randomUUID();
  const userId = `knowledge-evidence-owner-${suffix}`;
  await prisma.user.create({
    data: { displayName: "Knowledge evidence owner", id: userId, status: "active" }
  });
  const chat = await prisma.chat.create({
    data: { title: "Evidence receipt", userId },
    select: { id: true }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: { blocks: [{ text: input.query, type: "text" }] },
      role: "user"
    },
    select: { id: true }
  });
  const run = await prisma.modelRun.create({
    data: {
      chatId: chat.id,
      modelId: "answer-test",
      normalizedRequest: {
        knowledgeFocusedRequest: createKnowledgeFocusedRequest({
          currentUserMessage: input.query
        }),
        knowledgePlan: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 },
      },
      provider: "test",
      status: "in_progress",
      userId,
      userMessageId: message.id
    },
    select: { id: true }
  });
  await prisma.knowledgeRunScope.create({
    data: {
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      exclusions: input.readySources === 0
        ? [{ count: 1, reason: "not_ready", resourceType: "source" }]
        : [],
      modelRunId: run.id,
      resolvedBaseCount: input.readyBases,
      resolvedSourceCount: input.readySources,
      selection: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
    }
  });
  return { chatId: chat.id, runId: run.id, userId };
}

async function ensureEvidenceProfileFixture(): Promise<string> {
  await prisma.providerConnection.upsert({
    create: {
      displayName: "Evidence embeddings",
      family: "test",
      id: evidenceProfileFixture.connectionId
    },
    update: {},
    where: { id: evidenceProfileFixture.connectionId }
  });
  await prisma.providerModel.upsert({
    create: {
      capabilities: {},
      connectionId: evidenceProfileFixture.connectionId,
      defaultParams: {},
      displayName: "Evidence embedding model",
      id: evidenceProfileFixture.providerModelId,
      modelClass: "embedding",
      modelId: "knowledge-evidence-v2-test-embedding",
      provider: "test"
    },
    update: {},
    where: { id: evidenceProfileFixture.providerModelId }
  });
  await prisma.providerCredential.upsert({
    create: {
      connectionId: evidenceProfileFixture.connectionId,
      enabled: true,
      id: evidenceProfileFixture.credentialId,
      label: "Evidence embedding credential"
    },
    update: {},
    where: { id: evidenceProfileFixture.credentialId }
  });
  await prisma.providerCredentialVersion.upsert({
    create: {
      activatedAt: new Date(),
      credentialId: evidenceProfileFixture.credentialId,
      id: evidenceProfileFixture.credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: new Date(),
      version: 1
    },
    update: {},
    where: { id: evidenceProfileFixture.credentialVersionId }
  });
  await prisma.knowledgeIndexProfile.upsert({
    create: { id: evidenceProfileFixture.profileId },
    update: {},
    where: { id: evidenceProfileFixture.profileId }
  });
  const existing = await prisma.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: evidenceProfileFixture.profileRevisionId }
  });
  if (!existing) {
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(),
        chunkingProfileVersion: 1,
        egressPolicy: knowledgeProfileEgressPolicy({
          embeddingProviderModelId: evidenceProfileFixture.providerModelId
        }),
        embeddingConfiguration: {},
        embeddingProviderModelId: evidenceProfileFixture.providerModelId,
        executionAuthority: "installation",
        id: evidenceProfileFixture.profileRevisionId,
        preflightCheckedAt: new Date(),
        preflightStatus: "ready",
        profileConfiguration: knowledgeProfileConfiguration({
          embeddingProviderModelId: evidenceProfileFixture.providerModelId
        }),
        profileId: evidenceProfileFixture.profileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint
      }
    });
  }
  return evidenceProfileFixture.profileRevisionId;
}

function passage(input: Readonly<{
  artifactId: string;
  baseId: string;
  passageId: string;
  sourceId: string;
  sourceVersionId: string;
  text: string;
}>): KnowledgeRetrievedPassageEvidence {
  const byteSize = Buffer.byteLength(input.text, "utf8");
  return {
    annRank: 1,
    baseName: "Policies",
    bindingOrdinal: 0,
    chunkId: input.passageId,
    chunkIndex: input.passageId.endsWith("2") ? 1 : 0,
    contentHash: input.passageId.endsWith("2") ? "2".repeat(64) : "1".repeat(64),
    documentId: input.sourceId,
    documentVersionId: input.sourceVersionId,
    documentVersionNumber: 1,
    fileName: "retention.md",
    ftsRank: 1,
    ftsScore: 0.8,
    fusedScore: 2 / 61,
    handle: "K1",
    headingPath: ["Retention"],
    includedText: input.text,
    includedTextBytes: byteSize,
    knowledgeBaseId: input.baseId,
    page: 2,
    sectionId: "section-retention",
    sourceAlias: "S1",
    sourceArtifactId: input.artifactId,
    sourceName: "Retention policy",
    sourceTextBytes: byteSize,
    textTruncated: false,
    vectorDistance: 0.1,
    vectorScore: 0.9
  };
}

function evidence(input: Readonly<{
  invocationOrdinal: number;
  query: string;
  results: readonly KnowledgeRetrievedPassageEvidence[];
}>): KnowledgeRetrievalEvidence {
  const first = input.results[0];
  if (!first) throw new Error("knowledge_evidence_test_result_required");
  return {
    bases: [{
      baseContentRevision: 1,
      baseName: first.baseName,
      candidateCount: input.results.length,
      indexedContentRevision: 1,
      indexGenerationId: "generation-evidence-v2",
      knowledgeBaseId: first.knowledgeBaseId,
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSpaceFingerprint
    }],
    candidateCount: input.results.length,
    candidateLimit: 64,
    durationMs: 4,
    embeddingExecutions: [],
    fusion: "weighted_rrf_v2",
    invocationOrdinal: input.invocationOrdinal,
    operation: "automatic_search",
    outcome: "complete",
    providerText: "pending",
    query: input.query,
    resultLimit: 8,
    results: input.results,
    scopeAliases: [{ alias: "S1", kind: "source", label: first.sourceName! }],
    version: KNOWLEDGE_RESULT_VERSION
  };
}

describe("Prisma Knowledge Evidence v2 receipts", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists one focused operation with stable handles and seals accepted evidence", async () => {
    const fixture = await createRunFixture({
      query: "How long are Atlas exports retained?",
      readyBases: 1,
      readySources: 1
    });
    const suffix = randomUUID();
    const profileRevisionId = await ensureEvidenceProfileFixture();
    const baseId = `knowledge-evidence-base-${suffix}`;
    const sourceId = `knowledge-evidence-source-${suffix}`;
    const sourceVersionId = `knowledge-evidence-source-version-${suffix}`;
    let artifactId = "";
    try {
      await prisma.knowledgeRunProfileBinding.create({
        data: {
          embeddingConnectionId: evidenceProfileFixture.connectionId,
          embeddingCredentialId: evidenceProfileFixture.credentialId,
          embeddingCredentialSource: "default",
          embeddingCredentialVersionId: evidenceProfileFixture.credentialVersionId,
          embeddingExecutionSnapshot: { synthetic: true },
          embeddingProviderModelId: evidenceProfileFixture.providerModelId,
          modelRunId: fixture.runId,
          ordinal: 0,
          profileRevisionId,
          targetDimension: 1_024,
          vectorSpaceFingerprint
        }
      });
      await prisma.knowledgeBase.create({
        data: { id: baseId, name: "Policies", ownerUserId: fixture.userId }
      });
      await prisma.knowledgeSource.create({
        data: { id: sourceId, name: "Retention policy", ownerUserId: fixture.userId }
      });
      await prisma.knowledgeSourceVersion.create({
        data: {
          byteSize: 256,
          checksum: "a".repeat(64),
          fileName: "retention.md",
          id: sourceVersionId,
          mimeType: "text/markdown",
          ownerUserId: fixture.userId,
          sourceId,
          versionNumber: 1
        }
      });
      await prisma.knowledgeSource.update({
        data: { currentVersionId: sourceVersionId },
        where: { id: sourceId }
      });
      const artifact = await prisma.knowledgeSourceIndexArtifact.create({
        data: {
          chunkCount: 2,
          embeddedPassageCount: 2,
          normalizedTextByteSize: 256,
          normalizedTextChecksum: "b".repeat(64),
          normalizedTextStorageKey: `knowledge-evidence/${suffix}/normalized`,
          pageCount: 2,
          profileRevisionId,
          readyAt: new Date(),
          sourceVersionId,
          state: "ready"
        },
        select: { id: true }
      });
      artifactId = artifact.id;

      const focusedCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query: "How long are Atlas exports retained?" },
          modelRunId: fixture.runId,
          ordinal: 0,
          providerCallId: `knowledge-evidence-focused-call-${suffix}`,
          roundIndex: 0,
          startedAt: new Date(),
          state: "running",
          toolName: "knowledge_focused_v1"
        },
        select: { id: true }
      });
      const firstPassage = passage({
        artifactId,
        baseId,
        passageId: "passage-1",
        sourceId,
        sourceVersionId,
        text: "Completed Atlas exports are retained for 30 days after completion."
      });
      const secondPassage = passage({
        artifactId,
        baseId,
        passageId: "passage-2",
        sourceId,
        sourceVersionId,
        text: "Atlas export deletion runs automatically after the 30-day retention period."
      });
      const store = createPrismaKnowledgeRetrievalStore(prisma);
      const focused = await store.persistReceipt({
        evidence: evidence({
          invocationOrdinal: 1,
          query: "How long are Atlas exports retained?",
          results: [firstPassage, secondPassage]
        }),
        modelRunToolCallId: focusedCall.id,
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(focused?.results.map((entry) => entry.handle)).toEqual(["K1", "K2"]);
      expect(focused?.providerText).toContain("[K1]");
      expect(focused?.providerText).toContain("[K2]");
      expect(focused?.providerText).not.toMatch(/\[K\d+\.\d+\]/u);

      const receipt = await loadKnowledgeEvidencePackage(prisma, {
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(receipt).toMatchObject({
        items: [{
          handle: "K1",
          provenance: [
            { invocationOrdinal: 1, operation: "automatic_search", resultOrdinal: 0, version: 2 }
          ]
        }, {
          handle: "K2",
          provenance: [
            { invocationOrdinal: 1, operation: "automatic_search", resultOrdinal: 1, version: 2 }
          ]
        }],
        originalIntent: {
          kind: "focused_v1",
          query: "How long are Atlas exports retained?"
        },
        version: 2
      });
      await expect(prisma.knowledgeRunEvidence.count({
        where: { evidenceItem: { retrievalSessionId: receipt!.sessionId } }
      })).resolves.toBe(2);

      const grounded = await groundKnowledgeRunAnswer(prisma, {
        answer: "AIQSA_KB_STATUS=ANSWERED\nAtlas exports are retained for 30 days [K1].",
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(grounded).toMatchObject({ grounding: { outcome: "answered" } });
      await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
      await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
      await expect(prisma.knowledgeProviderAttempt.count({
        where: { modelRunId: fixture.runId }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeRetrievalSession.findUnique({
        select: { acceptedAt: true, receiptHash: true },
        where: { id: receipt!.sessionId }
      })).resolves.toMatchObject({
        acceptedAt: expect.any(Date),
        receiptHash: grounded!.grounding.receiptHash
      });
      await expect(prisma.knowledgeEvidenceItem.update({
        data: { sourceName: "tampered" },
        where: { id: receipt!.items[0]!.id }
      })).rejects.toThrow(/immutable/u);
      const sealedLink = await prisma.knowledgeRunEvidence.findFirstOrThrow({
        select: { evidenceItemId: true, knowledgeRunId: true },
        where: { evidenceItemId: receipt!.items[0]!.id }
      });
      await expect(prisma.knowledgeRunEvidence.delete({
        where: {
          knowledgeRunId_evidenceItemId: {
            evidenceItemId: sealedLink.evidenceItemId,
            knowledgeRunId: sealedLink.knowledgeRunId
          }
        }
      })).rejects.toThrow(/immutable/u);
      await expect(prisma.knowledgeEvidenceItem.delete({
        where: { id: receipt!.items[0]!.id }
      })).rejects.toThrow(/immutable/u);
      await expect(prisma.knowledgeRun.delete({
        where: { id: sealedLink.knowledgeRunId }
      })).rejects.toThrow(/immutable/u);
      await expect(prisma.knowledgeGroundingResult.update({
        data: { finalAnswerHash: "0".repeat(64) },
        where: { retrievalSessionId: receipt!.sessionId }
      })).rejects.toThrow(/immutable/u);
      await expect(prisma.$transaction(async (tx) =>
        settleKnowledgeGrounding(tx, grounded!))).resolves.toBeUndefined();
      await expect(prisma.knowledgeRetrievalSession.delete({
        where: { id: receipt!.sessionId }
      })).rejects.toThrow(/immutable/u);
    } finally {
      await prisma.chat.deleteMany({ where: { id: fixture.chatId, userId: fixture.userId } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
        await tx.knowledgeSource.updateMany({
          data: { currentVersionId: null, pendingVersionId: null },
          where: { id: sourceId }
        });
        if (artifactId) {
          await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: artifactId } });
        }
        await tx.knowledgeSourceVersion.deleteMany({ where: { id: sourceVersionId } });
        await tx.knowledgeSource.deleteMany({ where: { id: sourceId } });
        await tx.knowledgeBase.deleteMany({ where: { id: baseId } });
        // The disposable stateful lane owns the stable immutable profile fixture.
      });
      await prisma.user.deleteMany({ where: { id: fixture.userId } });
    }
  });

});
