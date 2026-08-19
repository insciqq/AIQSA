import { describe, expect, it } from "vitest";
import {
  createKnowledgeStaticBaseline,
  knowledgeEvalQueryVector,
  knowledgeEvalSourceVector
} from "./baseline";
import {
  knowledgeEvalIntents,
  knowledgeEvalQueries,
  knowledgeEvalSources,
  validateKnowledgeEvalFixtures
} from "./fixtures";

describe("Knowledge Engine baseline fixtures", () => {
  it("validates the 50-source corpus and complete labeled intent set", () => {
    expect(validateKnowledgeEvalFixtures).not.toThrow();
    expect(knowledgeEvalSources).toHaveLength(50);
    expect(new Set(knowledgeEvalQueries.map((query) => query.intent)))
      .toEqual(new Set(knowledgeEvalIntents));
    expect(knowledgeEvalSources.some((source) =>
      source.fixtureKind === "knowledge-ocr-image-pdf")).toBe(true);
    expect(knowledgeEvalSources.some((source) =>
      source.readiness === "ready_with_warnings")).toBe(true);
    expect(knowledgeEvalSources.filter((source) => source.traits.includes("table")).length)
      .toBeGreaterThanOrEqual(4);
  });

  it("uses deterministic source-oracle and neutral vectors without mixing axes", () => {
    const first = knowledgeEvalSourceVector("source-001");
    const second = knowledgeEvalSourceVector("source-002");
    const semantic = knowledgeEvalQueryVector(knowledgeEvalQueries.find((query) =>
      query.id === "query-fact-atlas-retention")!);
    const neutral = knowledgeEvalQueryVector(knowledgeEvalQueries.find((query) =>
      query.id === "query-no-answer-lunar-office")!);

    expect(first).toHaveLength(1_024);
    expect(first).toEqual(knowledgeEvalSourceVector("source-001"));
    expect(first[0]).toBe(1);
    expect(second[1]).toBe(1);
    expect(semantic[0]).toBe(1);
    expect(neutral[0]).toBe(0);
    expect(neutral.slice(42, 50)).toEqual(Array<number>(8).fill(1));
    expect(neutral[100]).toBe(0);
  });

  it("derives the current schema/API/UI/retrieval inventory from executable owners", async () => {
    const baseline = await createKnowledgeStaticBaseline();

    expect(baseline.corpus).toMatchObject({
      queryCount: 18,
      sourceCount: 50
    });
    expect(baseline.currentContract).toMatchObject({
      executionBudget: {
        maxFollowUpOperations: 6,
        maxOperations: 14,
        maxRetrievedTokens: 32_000
      },
      explicitSelectionResourceLimit: 128,
      fusion: "rrf_k60",
      resultLimit: 8,
      scopeBindingLimit: 128
    });
    expect(baseline.inventory.knowledgeModels).toEqual(expect.arrayContaining([
      "KnowledgeBase",
      "KnowledgeChunk",
      "KnowledgeDocument",
      "KnowledgeDocumentVersion",
      "KnowledgeIndexGeneration",
      "KnowledgeRun",
      "KnowledgeRunBinding"
    ]));
    expect(baseline.inventory.ordinaryRouteMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        methods: ["GET", "POST"],
        path: "app/api/me/knowledge-bases/route.ts"
      })
    ]));
    expect([...new Set(Object.values(
      baseline.inventory.ordinaryTechnicalMarkerOccurrences
    ))]).toEqual([0]);
    expect(baseline.inventory.implementationDigests.every(({ sha256 }) =>
      /^[0-9a-f]{64}$/u.test(sha256))).toBe(true);
  });
});
