import { describe, expect, it, vi } from "vitest";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence
} from "./retrievalTypes";
import { decodeKnowledgeRetrievalEvidence, knowledgeToolResultText } from "./toolResult";
import { KNOWLEDGE_STRATEGY_EXECUTION_VERSION } from "./knowledgeStrategyExecution";

const fingerprint = "a".repeat(64);

function budget(operation: "automatic_search" | "structured_analysis" | "visual_analysis") {
  return {
    noveltyRatio: 1,
    operation,
    stopReason: null,
    usage: {
      cumulativeCandidates: 1,
      estimatedCostMicros: 0,
      followUpOperations: 0,
      latencyMs: 2,
      lowNoveltyStreak: 0,
      operations: 1,
      queryEmbeddingCalls: 0,
      rerankerCalls: 0,
      retrievedTokens: 8,
      searchPhases: 1,
      subqueriesInCurrentPhase: 1
    },
    version: 1 as const
  };
}

function finalized(
  draft: Omit<KnowledgeRetrievalEvidence, "providerText">
): KnowledgeRetrievalEvidence {
  const pending = { ...draft, providerText: "pending" };
  return { ...pending, providerText: knowledgeToolResultText(pending) };
}

function structuredClarification(): KnowledgeRetrievalEvidence {
  return finalized({
    bases: [{
      baseContentRevision: 1,
      baseName: "Finance",
      candidateCount: 0,
      indexedContentRevision: 1,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      state: "empty",
      targetDimension: 1_024,
      vectorSpaceFingerprint: fingerprint
    }],
    budget: budget("structured_analysis"),
    candidateCount: 0,
    candidateLimit: 40,
    durationMs: 2,
    embeddingExecutions: [],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    operation: "structured_analysis",
    outcome: "structured_clarification_required",
    postRerankOrder: null,
    preRerankOrder: null,
    query: "Sum Revenue",
    rerankerBinding: null,
    resultLimit: 8,
    results: [],
    scopeAliases: [{ alias: "B1", kind: "base", label: "Finance" }],
    structured: {
      question: "Choose Sales or Forecast.",
      status: "needs_clarification",
      version: 1
    },
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION
  });
}

function visualEvidence(operation: "automatic_search" | "visual_analysis"):
KnowledgeRetrievalEvidence {
  const includedText = "Visual evidence: Quarterly revenue\nBounded analysis: North increased.";
  return finalized({
    bases: [{
      baseContentRevision: 1,
      baseName: "Reports",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      state: "ready",
      targetDimension: 1_024,
      vectorSpaceFingerprint: fingerprint
    }],
    budget: budget(operation),
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 2,
    embeddingExecutions: [],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    operation,
    outcome: "complete",
    postRerankOrder: null,
    preRerankOrder: null,
    query: "Describe the chart",
    rerankerBinding: null,
    resultLimit: 8,
    results: [{
      annRank: null,
      baseName: "Reports",
      bindingOrdinal: 0,
      chunkId: "visual:block-1:asset-1",
      chunkIndex: 0,
      contentHash: "b".repeat(64),
      documentId: "source-1",
      documentVersionId: "source-version-1",
      documentVersionNumber: 1,
      fileName: "report.pdf",
      ftsRank: null,
      ftsScore: null,
      fusedScore: 0,
      handle: "K1",
      headingPath: ["Results"],
      includedText,
      includedTextBytes: Buffer.byteLength(includedText),
      knowledgeBaseId: "base-1",
      page: 2,
      rerankScore: null,
      sectionId: null,
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceName: "Quarterly report",
      sourceTextBytes: Buffer.byteLength(includedText),
      textTruncated: false,
      vectorDistance: null,
      vectorScore: null,
      visualAnalysis: {
        assetId: "asset-1",
        blockId: "block-1",
        boundingBoxes: [{
          bottom: 80,
          coordinateOrigin: "top_left",
          left: 10,
          page: 2,
          right: 90,
          top: 20
        }],
        caption: "Quarterly revenue",
        description: "North increased.",
        headingPath: ["Results"],
        kind: "chart",
        label: "Quarterly revenue",
        page: 2,
        provider: {
          modelId: "vision-upstream-1",
          profileRevisionId: "profile-revision-1",
          provider: "openai",
          providerModelId: "vision-model-1",
          usage: {
            cachedInputTokens: 2,
            inputTokens: 20,
            outputTokens: 8,
            reasoningTokens: 0,
            totalTokens: 28
          }
        },
        status: "available",
        version: 1,
        warnings: []
      }
    }],
    scopeAliases: [
      { alias: "B1", kind: "base", label: "Reports" },
      { alias: "S1", kind: "source", label: "Quarterly report" }
    ],
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION,
    visual: { status: "available", version: 1 }
  });
}

function storedRow(evidence: KnowledgeRetrievalEvidence) {
  return {
    baseEvidence: evidence.bases,
    budgetEvidence: evidence.budget,
    candidateCount: evidence.candidateCount,
    candidateLimit: evidence.candidateLimit,
    durationMs: evidence.durationMs,
    embeddingUsage: evidence.embeddingExecutions,
    failureCode: evidence.failureCode ?? null,
    fusion: evidence.fusion,
    invocationOrdinal: evidence.invocationOrdinal,
    operation: evidence.operation,
    outcome: evidence.outcome,
    postRerankOrder: evidence.postRerankOrder,
    preRerankOrder: evidence.preRerankOrder,
    providerText: evidence.providerText,
    query: evidence.query,
    readReceipt: evidence.structured ?? evidence.visual ?? null,
    rerankerBinding: evidence.rerankerBinding,
    resultLimit: evidence.resultLimit,
    results: evidence.results,
    strategyStepEvidence: evidence.strategyStepEvidence ?? null,
    threshold: evidence.threshold
  };
}

describe("Prisma Knowledge analysis receipt replay", () => {
  it("loads strategy-step evidence independently from the purpose receipt", async () => {
    const marker = {
      executionId: "strategy-execution-1",
      kind: "multi_hop_follow_up" as const,
      ordinal: 0,
      requestHash: "b".repeat(64),
      resultHash: "c".repeat(64),
      stepId: "strategy-step-1",
      version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
    };
    const evidence = visualEvidence("visual_analysis");
    const marked = finalized({ ...evidence, strategyStepEvidence: marker });
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: { findFirst: vi.fn(async () => storedRow(marked)) }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-1",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toMatchObject({
      strategyStepEvidence: marker,
      visual: evidence.visual
    });
  });

  it.each([
    ["explicit structured clarification", structuredClarification()],
    ["explicit visual result", visualEvidence("visual_analysis")],
    ["legacy automatic visual result", visualEvidence("automatic_search")]
  ])("reconstructs %s from the durable operation marker", async (_name, evidence) => {
    expect(decodeKnowledgeRetrievalEvidence(evidence)).toEqual(evidence);
    const findFirst = vi.fn(async () => storedRow(evidence));
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: { findFirst }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-1",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toEqual(evidence);
  });

  it("fails closed when a stored analysis marker is missing", async () => {
    const evidence = visualEvidence("visual_analysis");
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: {
        findFirst: vi.fn(async () => ({ ...storedRow(evidence), readReceipt: null }))
      }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-1",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toBeNull();
  });
});
