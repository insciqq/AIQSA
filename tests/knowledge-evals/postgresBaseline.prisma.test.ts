import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/prisma";
import { runKnowledgePostgresBaseline } from "./postgresBaseline";

describe("Knowledge Engine current PostgreSQL baseline", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("emits aggregate retrieval, citation, and exact-vs-HNSW evidence", async () => {
    const report = await runKnowledgePostgresBaseline(prisma);

    expect(report).toMatchObject({
      citations: {
        handleValidity: 1,
        persistedReceipt: true,
        providerTextContainsStructuredIdentity: false,
        status: "complete"
      },
      database: {
        pgvectorVersion: "0.8.5",
        postgresVersion: expect.stringMatching(/^16\.14(?:\D|$)/u)
      },
      ingestion: {
        admittedSourceCount: 50,
        fileAdmissionAccuracy: 1,
        partialParseAcceptedByCurrentPipeline: true,
        sidecarFallbackEnabledByCurrentKnowledgeIngestion: true,
        sourceCount: 50
      },
      reportVersion: "knowledge-engine-current-baseline-v1",
      retrieval: {
        evaluatedQueryCount: 14,
        latencyMs: { samples: 14 }
      },
      sanitizedAggregatesOnly: true,
      static: {
        corpus: { queryCount: 18, sourceCount: 50 }
      },
      vectorQualification: {
        global1024Rows: 5_697,
        incompatible1536Rows: 128
      }
    });
    expect(report.vectorQualification.slices).toHaveLength(3);
    expect(report.vectorQualification.slices.every((slice) =>
      slice.exactPlanUsesHnsw === false &&
      slice.forcedHnswPlanUsesIndex &&
      slice.incompatibleOrCrossOwnerLeakageCount === 0 &&
      slice.currentPlanRecallAt10 >= 0 &&
      slice.currentPlanRecallAt10 <= 1 &&
      slice.forcedHnswRecallAt10 >= 0 &&
      slice.forcedHnswRecallAt10 <= 1
    )).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /knowledge-eval-[0-9a-f]{8}-[0-9a-f-]{27,}/u
    );
    console.info("knowledge_engine_current_baseline", report);
  }, 240_000);
});
