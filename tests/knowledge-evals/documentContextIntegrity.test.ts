import { describe, expect, it } from "vitest";
import {
  assertKnowledgeDocumentContextIntegrityGates,
  runKnowledgeDocumentContextIntegrityEval
} from "./documentContextIntegrity";
import { knowledgeDocumentContextFixtureContentSentinels } from
  "./documentContextIntegrityFixtures";

describe("Knowledge document-context integrity evaluation", () => {
  it("passes every deterministic structural gate without human relevance labels", () => {
    const report = runKnowledgeDocumentContextIntegrityEval();

    expect(() => assertKnowledgeDocumentContextIntegrityGates(report)).not.toThrow();
    expect(report).toMatchObject({
      aggregateOnly: true,
      corpus: { version: 2 },
      counts: {
        positionedOcrFixtureCount: 2,
        positionedOcrFragmentCount: 26
      },
      independentHumanLabelsUsed: false,
      passed: true,
      retrievalQualityGateEligible: false,
      scope: "deterministic_document_structure_contract",
      version: 2
    });
    expect(report.corpus.languages).toEqual({ en: 3, ru: 2 });
    expect(report.metrics).toMatchObject({
      lowConfidenceOcrAbstention: 1,
      ocrFragmentContextIntegrity: 1,
      ocrRepeatedHeaderIntegrity: 1
    });
    expect(Object.values(report.metrics).every((value) => value === 0 || value === 1)).toBe(true);
  });

  it("keeps the CLI report content-free and declares production-only gaps", () => {
    const report = runKnowledgeDocumentContextIntegrityEval();
    const serialized = JSON.stringify(report);

    expect(knowledgeDocumentContextFixtureContentSentinels.every((sentinel) =>
      !serialized.includes(sentinel))).toBe(true);
    expect(report.unavailable).toEqual([
      {
        field: "durable_retrieval_context_round_trip",
        reason: "requires_disposable_postgres_repository_lane"
      },
      {
        field: "structured_document_version_field",
        reason: "document_context_v1_retains_version_as_metadata_only"
      }
    ]);
  });
});
