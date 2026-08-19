import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
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

const vectorSpaceFingerprint = "e".repeat(64);
const evidenceProfileFixture = Object.freeze({
  connectionId: "knowledge-evidence-v2-test-connection",
  profileId: "knowledge-evidence-v2-test-profile",
  profileRevisionId: "knowledge-evidence-v2-test-profile-revision",
  providerModelId: "knowledge-evidence-v2-test-model"
});

type RunFixture = Readonly<{
  chatId: string;
  runId: string;
  userId: string;
}>;

function planner(query: string) {
  return {
    automaticRetrieval: true,
    coverage: { expectedPassageCount: null, mode: "partial", namedTargets: [] },
    evidenceMode: "compact",
    intent: "fact_lookup",
    originalQuery: query,
    rewrite: { exactTerms: [], query },
    status: "ready",
    strategy: "focused",
    subqueries: [{
      exactTerms: [],
      lanes: ["semantic", "lexical"],
      ordinal: 0,
      purpose: "answer",
      query,
      targetNames: []
    }],
    version: 1
  } as const;
}

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
        knowledgePlan: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 },
        knowledgePlanner: planner(input.query)
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
        ? [{ count: 1, reason: "processing", resourceType: "source" }]
        : [],
      modelRunId: run.id,
      resolvedBaseCount: input.readyBases,
      resolvedSourceCount: input.readySources,
      selection: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
    }
  });
  return { chatId: chat.id, runId: run.id, userId };
}

async function cleanupRunFixture(fixture: RunFixture): Promise<void> {
  await prisma.chat.deleteMany({ where: { id: fixture.chatId, userId: fixture.userId } });
  await prisma.user.deleteMany({ where: { id: fixture.userId } });
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
        egressPolicy: {},
        embeddingConfiguration: {},
        embeddingProviderModelId: evidenceProfileFixture.providerModelId,
        executionAuthority: "installation",
        id: evidenceProfileFixture.profileRevisionId,
        preflightCheckedAt: new Date(),
        preflightStatus: "ready",
        profileConfiguration: {},
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
    documentId: "document-evidence-v2",
    documentVersionId: "document-version-evidence-v2",
    documentVersionNumber: 1,
    fileName: "retention.md",
    ftsRank: 1,
    ftsScore: 0.8,
    fusedScore: 2 / 61,
    handle: "K1.1",
    headingPath: ["Retention"],
    includedText: input.text,
    includedTextBytes: byteSize,
    knowledgeBaseId: input.baseId,
    page: 2,
    sectionId: "section-retention",
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
    candidateLimit: 40,
    durationMs: 4,
    embeddingExecutions: [],
    fusion: "rrf_k60",
    invocationOrdinal: input.invocationOrdinal,
    operation: "automatic_search",
    outcome: "complete",
    postRerankOrder: input.results.map((entry) => entry.chunkId),
    preRerankOrder: input.results.map((entry) => entry.chunkId),
    providerText: "pending",
    query: input.query,
    rerankerBinding: null,
    resultLimit: 8,
    results: input.results,
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION
  };
}

function clarificationEvidence(input: Readonly<{
  query: string;
  question: string;
}>): KnowledgeRetrievalEvidence {
  return {
    bases: [{
      baseContentRevision: 1,
      baseName: "Finance",
      candidateCount: 0,
      indexedContentRevision: 1,
      indexGenerationId: "generation-structured-clarification",
      knowledgeBaseId: "base-structured-clarification",
      ordinal: 0,
      state: "empty",
      targetDimension: 1024,
      vectorSpaceFingerprint
    }],
    candidateCount: 0,
    candidateLimit: 40,
    durationMs: 1,
    embeddingExecutions: [],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    operation: "automatic_search",
    outcome: "structured_clarification_required",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "pending",
    query: input.query,
    rerankerBinding: null,
    resultLimit: 8,
    results: [],
    structured: {
      question: input.question,
      status: "needs_clarification",
      version: 1
    },
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION
  };
}

describe("Prisma Knowledge Evidence v2 receipts", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("deduplicates stable handles, persists operation provenance, and seals accepted evidence", async () => {
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

      const firstCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query: "Atlas retention" },
          modelRunId: fixture.runId,
          ordinal: 0,
          providerCallId: `knowledge-evidence-call-1-${suffix}`,
          roundIndex: 0,
          startedAt: new Date(),
          state: "running",
          toolName: "retrieve_knowledge"
        },
        select: { id: true }
      });
      const firstPassage = passage({
        artifactId,
        baseId,
        passageId: "passage-1",
        text: "Completed Atlas exports are retained for 30 days after completion."
      });
      const store = createPrismaKnowledgeRetrievalStore(prisma);
      const first = await store.persistReceipt({
        evidence: evidence({
          invocationOrdinal: 1,
          query: "Atlas retention",
          results: [firstPassage]
        }),
        modelRunToolCallId: firstCall.id,
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(first?.results.map((entry) => entry.handle)).toEqual(["K1"]);

      const secondCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query: "Atlas deletion" },
          modelRunId: fixture.runId,
          ordinal: 1,
          providerCallId: `knowledge-evidence-call-2-${suffix}`,
          roundIndex: 0,
          startedAt: new Date(),
          state: "running",
          toolName: "retrieve_knowledge"
        },
        select: { id: true }
      });
      const secondPassage = passage({
        artifactId,
        baseId,
        passageId: "passage-2",
        text: "Atlas export deletion runs automatically after the 30-day retention period."
      });
      const second = await store.persistReceipt({
        evidence: evidence({
          invocationOrdinal: 2,
          query: "Atlas deletion",
          results: [firstPassage, secondPassage]
        }),
        modelRunToolCallId: secondCall.id,
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(second?.results.map((entry) => entry.handle)).toEqual(["K1", "K2"]);
      expect(second?.providerText).toContain("[K1]");
      expect(second?.providerText).toContain("[K2]");
      expect(second?.providerText).not.toMatch(/\[K\d+\.\d+\]/u);

      const receipt = await loadKnowledgeEvidencePackage(prisma, {
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(receipt).toMatchObject({
        items: [{
          handle: "K1",
          provenance: [
            { confidenceBucket: "unavailable", invocationOrdinal: 1, postRerankRank: 1 },
            { confidenceBucket: "unavailable", invocationOrdinal: 2, postRerankRank: 1 }
          ]
        }, {
          handle: "K2",
          provenance: [
            { confidenceBucket: "unavailable", invocationOrdinal: 2, postRerankRank: 2 }
          ]
        }],
        originalIntent: { intent: "fact_lookup" },
        version: 2
      });
      await expect(prisma.knowledgeRunEvidence.count({
        where: { evidenceItem: { retrievalSessionId: receipt!.sessionId } }
      })).resolves.toBe(3);

      const grounded = await groundKnowledgeRunAnswer(prisma, {
        answer: "Atlas exports are retained for 30 days [K1].",
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(grounded).toMatchObject({ outcome: "passed", repairCount: 0 });
      await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
      await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
      await expect(prisma.knowledgeRetrievalSession.findUnique({
        select: { acceptedAt: true, receiptHash: true },
        where: { id: receipt!.sessionId }
      })).resolves.toMatchObject({
        acceptedAt: expect.any(Date),
        receiptHash: grounded!.receiptHash
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
        data: { repairCount: 1 },
        where: { retrievalSessionId: receipt!.sessionId }
      })).rejects.toThrow(/immutable/u);
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

  it("materializes an empty receipt and returns an honest no-answer when no Source is ready", async () => {
    const fixture = await createRunFixture({
      query: "What is the private launch date?",
      readyBases: 0,
      readySources: 0
    });
    try {
      const grounded = await groundKnowledgeRunAnswer(prisma, {
        answer: "The private launch date is 2026-09-10.",
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(grounded).toMatchObject({ outcome: "no_answer", repairCount: 1 });
      expect(grounded?.finalText).toMatch(/couldn't find enough support/iu);
      const receipt = await loadKnowledgeEvidencePackage(prisma, {
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(receipt).toMatchObject({
        degradedFlags: ["no_ready_evidence", "partial_readiness"],
        items: [],
        readiness: { excludedResources: 1, readyBases: 0, readySources: 0 }
      });
      await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
    } finally {
      await cleanupRunFixture(fixture);
    }
  });

  it("persists a structured clarification and deterministically returns it at finalization", async () => {
    const query = "Покажи итог по этой таблице";
    const question = "Уточните лист: Sales или Forecast?";
    const fixture = await createRunFixture({ query, readyBases: 1, readySources: 1 });
    try {
      const call = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query },
          modelRunId: fixture.runId,
          ordinal: 0,
          providerCallId: `knowledge-structured-clarification-${randomUUID()}`,
          roundIndex: 0,
          startedAt: new Date(),
          state: "running",
          toolName: "retrieve_knowledge"
        },
        select: { id: true }
      });
      const store = createPrismaKnowledgeRetrievalStore(prisma);
      const persisted = await store.persistReceipt({
        evidence: clarificationEvidence({ query, question }),
        modelRunToolCallId: call.id,
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(persisted).toMatchObject({
        outcome: "structured_clarification_required",
        structured: { question, status: "needs_clarification" }
      });

      const receipt = await loadKnowledgeEvidencePackage(prisma, {
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(receipt).toMatchObject({
        items: [],
        structuredClarifications: [question]
      });
      const grounded = await groundKnowledgeRunAnswer(prisma, {
        answer: "Наверное, это Sales.",
        runId: fixture.runId,
        userId: fixture.userId
      });
      expect(grounded).toMatchObject({
        finalText: question,
        outcome: "repaired",
        repairCount: 1
      });
      await prisma.$transaction(async (tx) => settleKnowledgeGrounding(tx, grounded!));
    } finally {
      await cleanupRunFixture(fixture);
    }
  });
});
