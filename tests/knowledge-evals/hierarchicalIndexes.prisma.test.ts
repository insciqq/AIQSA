import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/prisma";
import {
  assertKnowledgeHierarchicalIndexEvaluation,
  runKnowledgeHierarchicalIndexEvaluation
} from "./hierarchicalIndexes";

describe("Knowledge hierarchical index PostgreSQL evaluation", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("meets the Stage 4 lexical, exact, scope, immutability, and plan gates", async () => {
    const report = await runKnowledgeHierarchicalIndexEvaluation(prisma);

    console.info("knowledge_hierarchical_index_eval", report);
    expect(() => assertKnowledgeHierarchicalIndexEvaluation(report)).not.toThrow();
    expect(report).toMatchObject({
      reportVersion: "knowledge-hierarchical-index-eval-v1",
      sanitizedAggregatesOnly: true,
      retrieval: {
        documentRecallAt10: expect.any(Number),
        passageRecallAt10: expect.any(Number),
        sectionRecallAt10: expect.any(Number)
      },
      safety: {
        crossOwnerExactLeakageCount: 0,
        crossOwnerLexicalLeakageCount: 0,
        outOfScopeLeakageCount: 0
      }
    });
    expect(JSON.stringify(report)).not.toMatch(/knowledge-hierarchical-eval-/u);
  }, 180_000);
});
