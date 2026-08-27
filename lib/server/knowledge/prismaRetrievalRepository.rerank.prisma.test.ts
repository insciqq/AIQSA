import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "./knowledgeProfile";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from "./hierarchicalIndex";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import { KNOWLEDGE_RERANKER_EVIDENCE_VERSION } from "./rerankEvidence";
import type { KnowledgeRerankExecutor } from "./rerankExecution";
import { loadKnowledgeRerankOperationalMetrics } from "./rerankMetrics";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievedPassageEvidence
} from "./retrievalTypes";

const vectorSpaceFingerprint = "e".repeat(64);

function basisVector(axis: number): number[] {
  return Array.from({ length: 1_024 }, (_, index) => index === axis ? 1 : 0);
}
const profileFixture = Object.freeze({
  connectionId: "knowledge-rerank-test-connection",
  credentialId: "knowledge-rerank-test-credential",
  credentialVersionId: "knowledge-rerank-test-credential-version",
  profileId: "knowledge-rerank-test-profile",
  profileRevisionId: "knowledge-rerank-test-profile-revision",
  providerModelId: "knowledge-rerank-test-model"
});

async function ensureProfileFixture(): Promise<string> {
  await prisma.providerConnection.upsert({
    create: {
      displayName: "Rerank test embeddings",
      family: "test",
      id: profileFixture.connectionId
    },
    update: {},
    where: { id: profileFixture.connectionId }
  });
  await prisma.providerModel.upsert({
    create: {
      capabilities: {},
      connectionId: profileFixture.connectionId,
      defaultParams: {},
      displayName: "Rerank test embedding model",
      id: profileFixture.providerModelId,
      modelClass: "embedding",
      modelId: "knowledge-rerank-test-embedding",
      provider: "test"
    },
    update: {},
    where: { id: profileFixture.providerModelId }
  });
  await prisma.providerCredential.upsert({
    create: {
      connectionId: profileFixture.connectionId,
      enabled: true,
      id: profileFixture.credentialId,
      label: "Rerank test embedding credential"
    },
    update: {},
    where: { id: profileFixture.credentialId }
  });
  await prisma.providerCredentialVersion.upsert({
    create: {
      activatedAt: new Date(),
      credentialId: profileFixture.credentialId,
      id: profileFixture.credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: new Date(),
      version: 1
    },
    update: {},
    where: { id: profileFixture.credentialVersionId }
  });
  await prisma.knowledgeIndexProfile.upsert({
    create: { id: profileFixture.profileId },
    update: {},
    where: { id: profileFixture.profileId }
  });
  const existing = await prisma.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: profileFixture.profileRevisionId }
  });
  if (!existing) {
    await prisma.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(),
        chunkingProfileVersion: 1,
        egressPolicy: knowledgeProfileEgressPolicy({
          embeddingProviderModelId: profileFixture.providerModelId
        }),
        embeddingConfiguration: {},
        embeddingProviderModelId: profileFixture.providerModelId,
        executionAuthority: "installation",
        id: profileFixture.profileRevisionId,
        preflightCheckedAt: new Date(),
        preflightStatus: "ready",
        profileConfiguration: knowledgeProfileConfiguration({
          embeddingProviderModelId: profileFixture.providerModelId
        }),
        profileId: profileFixture.profileId,
        revisionNumber: 1,
        targetDimension: 1024,
        vectorSpaceFingerprint
      }
    });
  }
  return profileFixture.profileRevisionId;
}

type RunFixture = Readonly<{
  artifactId: string;
  chatId: string;
  runId: string;
  sourceId: string;
  sourceVersionId: string;
  userId: string;
}>;

async function createRunFixture(
  query: string,
  options: Readonly<{ deferArtifactReady?: boolean }> = {}
): Promise<RunFixture> {
  const suffix = randomUUID();
  const profileRevisionId = await ensureProfileFixture();
  const userId = `knowledge-rerank-owner-${suffix}`;
  await prisma.user.create({
    data: { displayName: "Knowledge rerank owner", id: userId, status: "active" }
  });
  const chat = await prisma.chat.create({
    data: { title: "Rerank receipt", userId },
    select: { id: true }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: { blocks: [{ text: query, type: "text" }] },
      role: "user"
    },
    select: { id: true }
  });
  const run = await prisma.modelRun.create({
    data: {
      chatId: chat.id,
      modelId: "answer-test",
      normalizedRequest: {
        knowledgePlan: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
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
      exclusions: [],
      modelRunId: run.id,
      resolvedBaseCount: 1,
      resolvedSourceCount: 1,
      selection: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
    }
  });
  await prisma.knowledgeRetrievalSession.create({
    data: {
      citationContract: { format: "K{ordinal}", legacyRead: true, maximum: 999, version: 2 },
      degradedFlags: [],
      id: randomUUID(),
      modelRunId: run.id,
      originalIntent: { kind: "tool_loop_v1" },
      readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 1 },
      scopeSnapshot: {},
      version: 2
    }
  });
  const sourceId = `knowledge-rerank-source-${suffix}`;
  const sourceVersionId = `knowledge-rerank-source-version-${suffix}`;
  await prisma.knowledgeSource.create({
    data: { id: sourceId, name: "Rerank policy", ownerUserId: userId }
  });
  await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 256,
      checksum: "a".repeat(64),
      fileName: "rerank.md",
      id: sourceVersionId,
      mimeType: "text/markdown",
      ownerUserId: userId,
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
      chunkCount: 1,
      embeddedPassageCount: options.deferArtifactReady ? 0 : 1,
      normalizedTextByteSize: 256,
      normalizedTextChecksum: "b".repeat(64),
      normalizedTextStorageKey: `knowledge-rerank/${suffix}/normalized`,
      pageCount: 1,
      ...(options.deferArtifactReady ? { processingStage: "embedding" as const } : {}),
      profileRevisionId,
      ...(options.deferArtifactReady ? {} : { readyAt: new Date() }),
      sourceVersionId,
      state: options.deferArtifactReady ? "processing" : "ready"
    },
    select: { id: true }
  });
  await prisma.knowledgeRunProfileBinding.create({
    data: {
      embeddingConnectionId: profileFixture.connectionId,
      embeddingCredentialId: profileFixture.credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: profileFixture.credentialVersionId,
      embeddingExecutionSnapshot: { synthetic: true },
      embeddingProviderModelId: profileFixture.providerModelId,
      modelRunId: run.id,
      ordinal: 0,
      profileRevisionId,
      targetDimension: 1_024,
      vectorSpaceFingerprint
    }
  });
  return {
    artifactId: artifact.id,
    chatId: chat.id,
    runId: run.id,
    sourceId,
    sourceVersionId,
    userId
  };
}

async function createSearchToolCall(runId: string, ordinal: number): Promise<string> {
  const call = await prisma.modelRunToolCall.create({
    data: {
      arguments: { query: "rerank question", sourceAliases: [] },
      modelRunId: runId,
      ordinal,
      providerCallId: `knowledge-rerank-call-${randomUUID()}`,
      roundIndex: 0,
      startedAt: new Date(),
      state: "running",
      toolName: "search_knowledge"
    },
    select: { id: true }
  });
  return call.id;
}

function passage(fixture: RunFixture, text: string): KnowledgeRetrievedPassageEvidence {
  const byteSize = Buffer.byteLength(text, "utf8");
  return {
    annRank: 1,
    baseName: "Policies",
    bindingOrdinal: 0,
    chunkId: "passage-rerank-1",
    chunkIndex: 0,
    contentHash: "1".repeat(64),
    documentId: fixture.sourceId,
    documentVersionId: fixture.sourceVersionId,
    documentVersionNumber: 1,
    fileName: "rerank.md",
    ftsRank: 1,
    ftsScore: 0.8,
    fusedScore: 1,
    handle: "K1",
    headingPath: ["Retention"],
    includedText: text,
    includedTextBytes: byteSize,
    knowledgeBaseId: "base-rerank",
    page: 1,
    rerankScore: 0.91,
    sectionId: "section-1",
    signalProvenance: [{
      exactKind: null,
      lane: "passage_lexical",
      rank: 1,
      rawScore: 1,
      vectorDistance: null,
      vectorMode: null
    }],
    sourceAlias: "S1",
    sourceArtifactId: fixture.artifactId,
    sourceName: "Rerank policy",
    sourceTextBytes: byteSize,
    textTruncated: false,
    vectorDistance: 0.1,
    vectorScore: 0.9
  };
}

function rerankerBinding(status: "complete" | "degraded") {
  return {
    adapterVersion: "openrouter-rerank-v1",
    candidateFormatterVersion: 1,
    connectionSnapshotId: "reranker-connection#v1",
    credentialSnapshotRef: "reranker-credential-version",
    durationMs: status === "complete" ? 120 : 15_000,
    fallbackReason: status === "complete" ? null : "rerank_request_timed_out",
    inputCandidateCount: status === "complete" ? 1 : 2,
    orderedCandidateChunkIds: status === "complete"
      ? ["passage-rerank-1"]
      : ["passage-rerank-1", "passage-rerank-2"],
    outputOrder: status === "complete" ? ["passage-rerank-1"] : [],
    policyVersion: 3,
    provider: status === "complete" ? "openrouter" : null,
    providerModelId: "reranker-deployment-1",
    providerRequestId: status === "complete" ? "req-1" : null,
    rankingProfileVersion: 2,
    relevanceScores: status === "complete" ? [0.91] : [],
    status,
    timedOut: status !== "complete",
    upstreamModelId: "qwen/qwen3-reranker-8b",
    usage: status === "complete"
      ? { searchUnits: 1, totalTokens: 64 }
      : { searchUnits: null, totalTokens: null },
    version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
  } as const;
}

function evidence(fixture: RunFixture, input: Readonly<{
  binding: ReturnType<typeof rerankerBinding> | undefined;
  invocationOrdinal: number;
  results: readonly KnowledgeRetrievedPassageEvidence[];
}>): KnowledgeRetrievalEvidence {
  return {
    bases: [{
      baseContentRevision: 1,
      baseName: "Policies",
      candidateCount: input.binding?.inputCandidateCount ?? input.results.length,
      indexedContentRevision: 1,
      indexGenerationId: "generation-rerank",
      knowledgeBaseId: "base-rerank",
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSearch: {
        bindingOrdinal: 0,
        candidateCount: 1,
        eligibleRows: 1,
        mode: "ann",
        scan: {
          efSearch: 400,
          iterativeScan: "strict_order",
          maxScanTuples: 100_000,
          retrievalBucket: 0
        },
        targetDimension: 1024
      },
      vectorSpaceFingerprint
    }],
    candidateCount: input.binding?.inputCandidateCount ?? input.results.length,
    candidateLimit: 64,
    durationMs: 4,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 2,
      inputTokens: 4,
      modelId: "knowledge-rerank-test-embedding",
      provider: "test",
      providerModelId: profileFixture.providerModelId,
      requestId: "embedding-request",
      status: "complete",
      totalTokens: 4
    }],
    fusion: "weighted_rrf_v2",
    invocationOrdinal: input.invocationOrdinal,
    operation: "automatic_search",
    outcome: "complete",
    providerText: "pending",
    query: "rerank question",
    ...(input.binding ? { rerankerBinding: input.binding } : {}),
    resultLimit: 16,
    results: input.results,
    scopeAliases: [{ alias: "S1", kind: "source", label: "Rerank policy" }],
    version: KNOWLEDGE_RESULT_VERSION
  };
}

describe("Prisma Knowledge hosted rerank receipts", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists V2 reranker evidence with the receipt and replays it without a provider call", async () => {
    const fixture = await createRunFixture("rerank question");
    const store = createPrismaKnowledgeRetrievalStore(prisma);
    const toolCallId = await createSearchToolCall(fixture.runId, 0);
    const binding = rerankerBinding("complete");
    const accepted = await store.persistReceipt({
      evidence: evidence(fixture, {
        binding,
        invocationOrdinal: 1,
        results: [passage(fixture, "Exports are retained for 30 days.")]
      }),
      modelRunToolCallId: toolCallId,
      runId: fixture.runId,
      userId: fixture.userId
    });
    expect(accepted?.rerankerBinding).toEqual(binding);
    expect(accepted?.results[0]).toMatchObject({ rerankScore: 0.91 });

    const stored = await prisma.knowledgeRun.findUnique({
      select: { readReceipt: true },
      where: { modelRunToolCallId: toolCallId }
    });
    expect(stored?.readReceipt).toMatchObject({ rerankerBinding: { status: "complete" } });

    const replayed = await store.loadReceipt!({
      modelRunToolCallId: toolCallId,
      runId: fixture.runId,
      userId: fixture.userId
    });
    expect(replayed?.rerankerBinding).toEqual(binding);
    expect(replayed?.results[0]).toMatchObject({ rerankScore: 0.91 });
  });

  it("marks the session degraded on reranker fallback and feeds aggregate metrics", async () => {
    const fixture = await createRunFixture("rerank question");
    const store = createPrismaKnowledgeRetrievalStore(prisma);
    const completeCall = await createSearchToolCall(fixture.runId, 0);
    await store.persistReceipt({
      evidence: evidence(fixture, {
        binding: rerankerBinding("complete"),
        invocationOrdinal: 1,
        results: [passage(fixture, "Exports are retained for 30 days.")]
      }),
      modelRunToolCallId: completeCall,
      runId: fixture.runId,
      userId: fixture.userId
    });
    const degradedCall = await createSearchToolCall(fixture.runId, 1);
    const { rerankScore: _rerankScore, ...fallbackPassage } =
      passage(fixture, "Deletion runs automatically afterwards.");
    await store.persistReceipt({
      evidence: evidence(fixture, {
        binding: rerankerBinding("degraded"),
        invocationOrdinal: 2,
        results: [fallbackPassage]
      }),
      modelRunToolCallId: degradedCall,
      runId: fixture.runId,
      userId: fixture.userId
    });
    const session = await prisma.knowledgeRetrievalSession.findUnique({
      select: { degradedFlags: true },
      where: { modelRunId: fixture.runId }
    });
    expect(session?.degradedFlags).toContain("knowledge_reranker_degraded");

    const metrics = await loadKnowledgeRerankOperationalMetrics(prisma);
    expect(metrics.operations).toBeGreaterThanOrEqual(2);
    expect(metrics.complete).toBeGreaterThanOrEqual(1);
    expect(metrics.fallback).toBeGreaterThanOrEqual(1);
    expect(metrics.timeout).toBeGreaterThanOrEqual(1);
    expect(metrics.totalTokens).toBeGreaterThanOrEqual(64);
  });

  it("keeps rejecting legacy planner-era ranking fields and unpinned rerank scores", async () => {
    const fixture = await createRunFixture("rerank question");
    const store = createPrismaKnowledgeRetrievalStore(prisma);
    const toolCallId = await createSearchToolCall(fixture.runId, 0);
    const scored = passage(fixture, "Exports are retained for 30 days.");
    await expect(store.persistReceipt({
      evidence: {
        ...evidence(fixture, {
          binding: rerankerBinding("complete"),
          invocationOrdinal: 1,
          results: [scored]
        }),
        preRerankOrder: ["passage-rerank-1"]
      },
      modelRunToolCallId: toolCallId,
      runId: fixture.runId,
      userId: fixture.userId
    })).rejects.toThrow("knowledge_legacy_ranking_write_forbidden");
    await expect(store.persistReceipt({
      evidence: {
        ...evidence(fixture, {
          binding: undefined,
          invocationOrdinal: 1,
          results: [scored]
        }),
        rerankerBinding: {
          egress: "none",
          kind: "deterministic_token_vector_heuristic",
          languages: ["en", "ru"],
          profile: "deterministic-token-vector-heuristic-v1",
          status: "complete",
          version: 1
        }
      },
      modelRunToolCallId: toolCallId,
      runId: fixture.runId,
      userId: fixture.userId
    })).rejects.toThrow("knowledge_legacy_ranking_write_forbidden");
    await expect(store.persistReceipt({
      evidence: evidence(fixture, {
        binding: undefined,
        invocationOrdinal: 1,
        results: [scored]
      }),
      modelRunToolCallId: toolCallId,
      runId: fixture.runId,
      userId: fixture.userId
    })).rejects.toThrow("knowledge_legacy_ranking_write_forbidden");
  });

  it("performs authority scoping before the hosted rerank stage sees any candidate", async () => {
    const owner = await createRunFixture("rerank question", { deferArtifactReady: true });
    const foreign = await createRunFixture("rerank question", { deferArtifactReady: true });
    const suffix = randomUUID();
    const ownedPassage = `knowledge-rerank-own-passage-${suffix}`;
    const foreignPassage = `knowledge-rerank-foreign-passage-${suffix}`;
    for (const [fixture, passageId, snapshotOrdinal] of [
      [owner, ownedPassage, 0],
      [foreign, foreignPassage, 1]
    ] as const) {
      const hierarchyId = `knowledge-rerank-hierarchy-${snapshotOrdinal}-${suffix}`;
      await prisma.knowledgeHierarchicalIndexArtifact.create({
        data: {
          derivationMode: "normalized_v2",
          id: hierarchyId,
          schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
          sourceArtifactId: fixture.artifactId,
          sourceVersionId: fixture.sourceVersionId
        }
      });
      await prisma.knowledgeArtifactDocumentIndex.create({
        data: {
          contentHash: (snapshotOrdinal === 0 ? "a" : "b").repeat(64),
          documentType: "text/markdown",
          fileName: "rerank.md",
          indexArtifactId: hierarchyId,
          pageCount: 1,
          sourceName: "Rerank policy"
        }
      });
      const sectionRowId = `knowledge-rerank-section-${snapshotOrdinal}-${suffix}`;
      await prisma.knowledgeArtifactSectionIndex.create({
        data: {
          contentHash: "d".repeat(64),
          fileName: "rerank.md",
          id: sectionRowId,
          indexArtifactId: hierarchyId,
          label: "Retention",
          ordinal: 0,
          page: 1,
          pageEnd: 1,
          passageEnd: 0,
          passageStart: 0
        }
      });
      await prisma.knowledgeArtifactPassageIndex.create({
        data: {
          contentHash: `${snapshotOrdinal}`.repeat(64),
          embeddingTextHash: `${snapshotOrdinal + 3}`.repeat(64),
          fileName: "rerank.md",
          id: passageId,
          indexArtifactId: hierarchyId,
          ordinal: 0,
          page: 1,
          pageEnd: 1,
          sectionId: sectionRowId,
          sourceBlockEnd: 0,
          sourceBlockIds: ["block-0"],
          sourceBlockStart: 0,
          sourceName: "Rerank policy",
          text: "Retention evidence passage.",
          tokenCount: 3
        }
      });
      await prisma.knowledgeArtifactExactEntry.create({
        data: {
          id: `knowledge-rerank-exact-${snapshotOrdinal}-${suffix}`,
          indexArtifactId: hierarchyId,
          kind: "heading",
          normalizedValue: "retention",
          ordinal: 0,
          page: 1,
          pageEnd: 1,
          sectionId: sectionRowId,
          value: "Retention",
          valueHash: `${snapshotOrdinal + 5}`.repeat(64)
        }
      });
      const vector = `[${basisVector(snapshotOrdinal).join(",")}]`;
      await prisma.$executeRaw`
        INSERT INTO "KnowledgeArtifactPassageEmbedding" (
          "passageId", "indexArtifactId", "embeddingTextHash", "embeddingDimension", "embedding"
        ) VALUES (
          ${passageId}, ${hierarchyId}, ${`${snapshotOrdinal + 3}`.repeat(64)},
          1024, ${vector}::vector
        )
      `;
      await prisma.knowledgeHierarchicalIndexArtifact.update({
        data: {
          checksum: "b".repeat(64),
          documentCount: 1,
          exactEntryCount: 1,
          passageCount: 1,
          readyAt: new Date(),
          sectionCount: 1,
          state: "ready"
        },
        where: { id: hierarchyId }
      });
      await prisma.knowledgeSourceIndexArtifact.update({
        data: {
          embeddedPassageCount: 1,
          processingStage: null,
          readyAt: new Date(),
          state: "ready"
        },
        where: { id: fixture.artifactId }
      });
      const binding = await prisma.knowledgeRunProfileBinding.findFirstOrThrow({
        select: { id: true },
        where: { modelRunId: fixture.runId }
      });
      await prisma.knowledgeRunSourceBinding.create({
        data: {
          directSelected: true,
          fileNameSnapshot: "rerank.md",
          modelRunId: fixture.runId,
          ordinal: 0,
          profileBindingId: binding.id,
          readinessState: "ready",
          selectionKind: "direct",
          sourceAlias: "S1",
          sourceArtifactId: fixture.artifactId,
          sourceId: fixture.sourceId,
          sourceNameSnapshot: "Rerank policy",
          sourceVersionId: fixture.sourceVersionId,
          sourceVersionNumber: 1
        }
      });
    }
    const seen: string[][] = [];
    const executor = vi.fn<KnowledgeRerankExecutor>(async ({ candidates }) => {
      seen.push(candidates.map((candidate) => candidate.chunkId));
      return {
        evidence: rerankerBinding("degraded"),
        scores: new Map<string, number>(),
        status: "degraded" as const
      };
    });
    const result = await executeKnowledgeRetrievalCore(prisma, {
      candidateLimit: 64,
      excludedContentHashes: [],
      query: "retention evidence",
      rerank: { executor },
      resultLimit: 16,
      runId: owner.runId,
      userId: owner.userId,
      vectors: []
    });
    expect(result.bindingCount).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(ownedPassage);
    expect(seen[0]).not.toContain(foreignPassage);
  });
});
