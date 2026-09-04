import { describe, expect, it } from "vitest";
import type { KnowledgeExtractionConfig } from
  "../../lib/server/knowledge/knowledgeExtractionConfig";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from
  "../../lib/server/knowledge/indexProfile";
import { KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER } from
  "../../lib/server/knowledge/tokenizer/knowledgeTokenCounter";
import {
  BRIGHT_STACKOVERFLOW_FILE_NAME,
  BRIGHT_STACKOVERFLOW_SOURCE_NAME,
  assertBrightGpt2Census,
  brightDeterministicUuid,
  decodeBrightDocumentRow,
  decodeBrightExampleRow,
  decodeBrightPreparedEvaluationQueryRow,
  decodeBrightPreparedDocumentRow,
  decodeBrightPreparedRuntimeQueryRow,
  prepareBrightDocument
} from "./brightStackOverflowContract";
import {
  aggregateBrightRetrievalMetrics,
  buildBrightRetrievalQueries
} from "./brightStackOverflowRetrieval";
import { buildBrightProductDocumentPlan } from "./brightStackOverflowProduct";

const extractionConfig: KnowledgeExtractionConfig = Object.freeze({
  maxChunksPerDocument: 100,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 100_000,
  maxNormalizedObjectBytes: 1_000_000,
  maxPages: 10
});

function exampleRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    excluded_ids: ["N/A"],
    gold_answer: "Private evaluator answer",
    gold_ids: ["docs/relevant.txt"],
    gold_ids_long: ["docs/relevant-long.txt"],
    id: "7",
    query: "How does the operation work?",
    reasoning: "Private evaluator reasoning",
    ...overrides
  };
}

describe("BRIGHT Stack Overflow dataset contract", () => {
  it("normalizes only the hostile encoding artifacts and binds opaque identities", () => {
    const decoded = decodeBrightDocumentRow({
      content: "  line one\r\nline\u0000 two \uFFFD  ",
      id: "public/folder/document.txt"
    }, 3);
    const prepared = prepareBrightDocument(decoded);

    expect(prepared).toMatchObject({
      officialId: "public/folder/document.txt",
      ordinal: 3,
      preparedText: "line one\nline two"
    });
    expect(prepared.sourceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(prepared.sourceVersionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(prepared.sourceId).not.toContain("public");
    expect(prepareBrightDocument(decoded)).toEqual(prepared);
    expect(brightDeterministicUuid("source", decoded.officialId))
      .toBe(prepared.sourceId);
  });

  it("separates runtime query input from evaluator-only fields", () => {
    const decoded = decodeBrightExampleRow(exampleRow());

    expect(decoded.runtime).toEqual({
      officialId: "7",
      text: "How does the operation work?"
    });
    expect(decoded.runtime).not.toHaveProperty("goldIds");
    expect(decoded.runtime).not.toHaveProperty("goldAnswer");
    expect(decoded.runtime).not.toHaveProperty("reasoning");
    expect(decoded.evaluator).toEqual({
      excludedIds: [],
      goldAnswer: "Private evaluator answer",
      goldIds: ["docs/relevant.txt"],
      officialId: "7"
    });
    expect(decoded.evaluatorSourceFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("strictly joins prepared runtime queries to evaluator labels after product bounds", () => {
    const privateAnswer = "Evaluator answer must not enter retrieval input";
    const querySet = buildBrightRetrievalQueries([{
      formatVersion: 1,
      officialId: "7",
      query: `  marker\t${"x".repeat(3_100)}`
    }], [{
      evaluatorSourceFingerprint: "a".repeat(64),
      excludedIds: ["docs/excluded/file.txt"],
      formatVersion: 1,
      goldAnswer: privateAnswer,
      goldIds: ["docs/relevant/file.txt"],
      officialId: "7"
    }]);

    expect(querySet).toMatchObject({ boundedQueryCount: 1, normalizedQueryCount: 1 });
    expect([...querySet.queries[0]!.text]).toHaveLength(3_000);
    expect(querySet.queries[0]).toMatchObject({
      excludedDocumentIds: ["docs/excluded/file.txt"],
      officialId: "7",
      relevant: { "docs/relevant/file.txt": 1 }
    });
    expect(JSON.stringify(querySet)).not.toContain(privateAnswer);
    expect(() => buildBrightRetrievalQueries([{
      formatVersion: 1,
      officialId: "8",
      query: "unmatched"
    }], [{
      evaluatorSourceFingerprint: "b".repeat(64),
      excludedIds: [],
      formatVersion: 1,
      goldAnswer: "answer",
      goldIds: ["docs/relevant/file.txt"],
      officialId: "9"
    }])).toThrow("bright_stackoverflow_retrieval_query_mapping_mismatch");
  });

  it("reports BRIGHT Success/Recall at 5, 10, and the product final limit", () => {
    const baseOutcome = {
      candidatesAfterRerank: 16,
      candidatesBeforeRerank: 64,
      embeddingUsage: { costMicros: null, requests: 1, tokens: 10 },
      rerankApplied: false,
      rerankFallback: false,
      rerankerUsage: { costMicros: null, requests: 0, tokens: 0 }
    } as const;
    const outcomes = [{
      ...baseOutcome,
      queryId: "1",
      rankedDocumentIds: ["x1", "x2", "x3", "x4", "gold-a"],
      relevant: { "gold-a": 1, "gold-b": 1 },
      rerankMs: null,
      rerankerDiagnostic: { fallbackReason: null, timedOut: false },
      retrievalMs: 100
    }, {
      ...baseOutcome,
      queryId: "2",
      rankedDocumentIds: [
        "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "gold-c"
      ],
      relevant: { "gold-c": 1 },
      rerankFallback: true,
      rerankMs: 200,
      rerankerDiagnostic: {
        fallbackReason: "rerank_request_timed_out",
        timedOut: true
      },
      retrievalMs: 300
    }];
    const metrics = aggregateBrightRetrievalMetrics(outcomes, 16);

    expect(metrics).toMatchObject({
      classifiedFailureCounts: { rerank_request_timed_out: 1 },
      finalResultLimit: 16,
      queryFailureCount: 0,
      recall10: 0.75,
      recall5: 0.25,
      recallFinal: 0.75,
      rerankMsP99: 200,
      retryCount: 0,
      retrievalMsP99: 300,
      success10: 1,
      success5: 0.5,
      successFinal: 1,
      timeoutCount: 1
    });
    expect(aggregateBrightRetrievalMetrics(outcomes, 16, false)).toMatchObject({
      attemptAccountingComplete: false,
      queryFailureCount: null,
      retryCount: null,
      timeoutCount: null,
      recall10: metrics.recall10,
      classifiedFailureCounts: metrics.classifiedFailureCounts
    });
  });

  it("rejects drift in prepared runtime and evaluator query rows", () => {
    expect(() => decodeBrightPreparedRuntimeQueryRow({
      extra: true,
      formatVersion: 1,
      officialId: "7",
      query: "query"
    })).toThrow("bright_stackoverflow_runtime_query_invalid");
    expect(() => decodeBrightPreparedEvaluationQueryRow({
      evaluatorSourceFingerprint: "not-a-hash",
      excludedIds: [],
      formatVersion: 1,
      goldAnswer: "answer",
      goldIds: ["docs/relevant.txt"],
      officialId: "7"
    })).toThrow("bright_stackoverflow_evaluator_query_invalid");
  });

  it("rejects schema drift, duplicate qrels, and qrel/exclusion overlap", () => {
    expect(() => decodeBrightDocumentRow({
      content: "text",
      extra: true,
      id: "id"
    }, 0)).toThrow("bright_stackoverflow_document_row_invalid");
    expect(() => decodeBrightExampleRow(exampleRow({
      gold_ids: ["same", "same"]
    }))).toThrow("bright_stackoverflow_gold_ids_invalid");
    expect(() => decodeBrightExampleRow(exampleRow({
      excluded_ids: ["docs/relevant.txt"]
    }))).toThrow("bright_stackoverflow_qrel_overlap");
  });

  it("enforces the scoreable 50M-token floor", () => {
    expect(() => assertBrightGpt2Census(49_999_999))
      .toThrow("bright_stackoverflow_gpt2_token_floor_not_met");
    expect(() => assertBrightGpt2Census(50_000_000)).not.toThrow();
  });

  it("revalidates every prepared identity and rejects checkpoint drift", () => {
    const prepared = prepareBrightDocument(decodeBrightDocumentRow({
      content: "stable prepared text",
      id: "docs/stable.txt"
    }, 9));
    const row = {
      formatVersion: 1,
      officialId: prepared.officialId,
      ordinal: prepared.ordinal,
      sourceId: prepared.sourceId,
      sourceVersionId: prepared.sourceVersionId,
      text: prepared.preparedText
    };

    expect(decodeBrightPreparedDocumentRow(row)).toEqual(prepared);
    expect(() => decodeBrightPreparedDocumentRow({
      ...row,
      text: `${row.text} changed`
    })).toThrow("bright_stackoverflow_prepared_identity_mismatch");
    expect(() => decodeBrightPreparedDocumentRow({
      ...row,
      extra: true
    })).toThrow("bright_stackoverflow_prepared_document_invalid");
  });
});

describe("BRIGHT direct normalized-text product boundary", () => {
  it("builds normal validated chunks and hierarchy without public-id metadata", () => {
    const document = prepareBrightDocument(decodeBrightDocumentRow({
      content: "A deterministic Stack Overflow passage with enough useful text.",
      id: "private-mapping/public-id.txt"
    }, 0));
    const artifactId = brightDeterministicUuid(
      "artifact",
      document.sourceVersionId,
      "profile-fingerprint"
    );
    const plan = buildBrightProductDocumentPlan({
      artifactId,
      chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      config: extractionConfig,
      document,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(plan.normalized.body.byteLength).toBeGreaterThan(0);
    expect(plan.normalized.document.source.displayName)
      .toBe(BRIGHT_STACKOVERFLOW_FILE_NAME);
    expect(plan.normalized.document.blocks).toHaveLength(1);
    expect(plan.chunks.length).toBeGreaterThan(0);
    expect(plan.hierarchicalIndex.document).toMatchObject({
      fileName: BRIGHT_STACKOVERFLOW_FILE_NAME,
      sourceName: BRIGHT_STACKOVERFLOW_SOURCE_NAME
    });
    expect(JSON.stringify(plan.hierarchicalIndex))
      .not.toContain(document.officialId);
  });
});
