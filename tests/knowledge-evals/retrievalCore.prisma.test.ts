import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/prisma";
import {
  assertKnowledgeRetrievalCoreEvaluation,
  runKnowledgeRetrievalCoreEvaluation
} from "./retrievalCore";

describe("Knowledge retrieval core PostgreSQL evaluation", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("meets the Stage 4 hybrid, rerank, fallback, coverage, and relevance gates", async () => {
    const report = await runKnowledgeRetrievalCoreEvaluation(prisma);

    console.info("knowledge_retrieval_core_eval", report);
    expect(() => assertKnowledgeRetrievalCoreEvaluation(report)).not.toThrow();
    expect(report).toMatchObject({
      reportVersion: "knowledge-retrieval-core-eval-v1",
      sanitizedAggregatesOnly: true,
      fallback: {
        rerankerOutageMode: "degraded"
      },
      retrieval: {
        comparisonTargetCoverage: 1,
        noAnswerFalsePositiveRate: 0
      },
      vectorEvidence: {
        fixture: "deterministic-source-oracle-v1",
        purpose: "retrieval_plumbing",
        qualityGateEligible: false,
        realEmbeddingExecution: "not_measured"
      }
    });
    expect(JSON.stringify(report)).not.toMatch(/knowledge-hierarchical-eval-/u);
  }, 300_000);
});
