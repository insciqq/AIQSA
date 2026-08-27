import { describe, expect, it, vi } from "vitest";
import {
  LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY,
  LONGMEMEVAL_MAX_CONCURRENCY,
  assertBenchmarkBaseUrl,
  assertBenchmarkDatabaseUrl,
  buildLongMemEvalBaselineManifest,
  decodeLongMemEvalDataset,
  decodeLongMemEvalProfile,
  decodeLongMemEvalProfileManifest,
  evaluateLongMemEvalComponentMetrics,
  longMemEvalQuestionPrompt,
  longMemEvalEmbeddingBatchSizeDistribution,
  longMemEvalExpectedUtilityModelId,
  longMemEvalProfileManifest,
  longMemEvalProductMemoryPipelineComplete,
  longMemEvalQualificationGate,
  longMemEvalReaderOracleGap,
  longMemEvalSettledImportTurns,
  mapConcurrentOrdered,
  mergeLongMemEvalEvaluationResults,
  parseLongMemEvalDate,
  partitionLongMemEvalEvaluation,
  resolveBenchmarkOutputDirectory,
  sanitizeLongMemEvalRetrievalAudit,
  selectLongMemEvalCases
} from "./contract";

function fixture(questionId = "question-1") {
  return {
    answer: "Business Administration",
    answer_session_ids: ["session-1"],
    haystack_dates: ["2023/05/20 (Sat) 02:21"],
    haystack_session_ids: ["session-1"],
    haystack_sessions: [[
      { content: "I graduated in Business Administration.", role: "user" },
      { content: "Congratulations!", role: "assistant" }
    ]],
    question: "What degree did I graduate with?",
    question_date: "2023/05/30 (Tue) 23:40",
    question_id: questionId,
    question_type: "single-session-user"
  };
}

describe("LongMemEval adapter contract", () => {
  it("fails qualification on a degraded Memory outcome independently of oracle scoring", () => {
    expect(longMemEvalQualificationGate({
      executionFailures: 0,
      memoryOutcomes: ["USED", "DEGRADED"]
    })).toEqual({
      degradedMemoryOutcomes: 1,
      executionFailures: 0,
      passed: false,
      successfulCases: 2
    });
    expect(longMemEvalQualificationGate({
      executionFailures: 0,
      memoryOutcomes: ["USED", "USED"]
    }).passed).toBe(true);
  });

  it("keeps the official and product profiles explicit and non-interchangeable", () => {
    expect(longMemEvalProfileManifest(decodeLongMemEvalProfile("official")))
      .toEqual({
        automaticFactLearning: false,
        id: "official",
        label: "official-history-recall",
        officialComparable: true,
        patternSynthesis: false,
        version: 2
      });
    const product = longMemEvalProfileManifest(
      decodeLongMemEvalProfile("product")
    );
    expect(product).toEqual({
      automaticFactLearning: true,
      id: "product",
      label: "product-full-memory",
      officialComparable: false,
      patternSynthesis: true,
      version: 2
    });
    expect(decodeLongMemEvalProfileManifest(product)).toEqual(product);
    expect(() => decodeLongMemEvalProfile("benchmark-boost"))
      .toThrow("longmemeval_profile_invalid");
    expect(() => decodeLongMemEvalProfileManifest({
      ...product,
      officialComparable: true
    })).toThrow("longmemeval_profile_manifest_invalid");
  });

  it("requires a real applied Dream call while accepting a valid empty result", () => {
    const evidence = {
      appliedSynthesisExecutions: 1,
      assistantEvidence: 0,
      automaticFactLearning: true,
      automaticFactVersions: 24,
      classifiedAutomaticFactVersions: 24,
      classifiedPatternVersions: 0,
      directUserEvidence: 24,
      eligibleSynthesisSources: 24,
      expectedSettlements: 46,
      extractionJobs: 46,
      factVersionRelations: 2,
      lastSynthesisAtRecorded: true,
      patternVersions: 0,
      relationJobs: 2,
      retainedSynthesisPayloads: 0,
      successfulFactExtractionExecutions: 46,
      successfulFactExtractionJobs: 46,
      successfulSynthesisExecutions: 1,
      successfulSynthesisJobs: 1,
      synthesizedFromRelations: 0,
      synthesisDue: false,
      synthesisEnabled: true,
      synthesisJobs: 1,
      synthesisScheduleReason: "NO_NEW_ACTIVITY",
      synthesisThreshold: 3
    };
    expect(longMemEvalProductMemoryPipelineComplete(evidence)).toBe(true);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      successfulFactExtractionExecutions: 48,
      successfulFactExtractionJobs: 45
    })).toBe(true);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      successfulFactExtractionJobs: 0
    })).toBe(false);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      successfulSynthesisExecutions: 0
    })).toBe(false);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      classifiedPatternVersions: 1,
      patternVersions: 1,
      synthesizedFromRelations: 2
    })).toBe(false);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      classifiedPatternVersions: 1,
      patternVersions: 1,
      synthesizedFromRelations: 3
    })).toBe(true);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      appliedSynthesisExecutions: 0,
      eligibleSynthesisSources: 17,
      lastSynthesisAtRecorded: false,
      successfulSynthesisExecutions: 0,
      successfulSynthesisJobs: 0,
      synthesisJobs: 0
    })).toBe(true);
    expect(longMemEvalProductMemoryPipelineComplete({
      ...evidence,
      appliedSynthesisExecutions: 0,
      lastSynthesisAtRecorded: false,
      successfulSynthesisExecutions: 0,
      successfulSynthesisJobs: 0,
      synthesisDue: true,
      synthesisJobs: 0
    })).toBe(false);
  });

  it("routes utility-model evidence by role with an optional dedicated reranker", () => {
    const expected = (logicalRole: string, rerankerModelId: string | null) =>
      longMemEvalExpectedUtilityModelId({
        embeddingModelId: "embedding-model",
        logicalRole,
        rerankerModelId,
        systemModelId: "system-model"
      });
    expect(expected("MEMORY_DOCUMENT_EMBED", "reranker-model"))
      .toBe("embedding-model");
    expect(expected("MEMORY_QUERY_EMBED", "reranker-model"))
      .toBe("embedding-model");
    expect(expected("MEMORY_RERANK", "reranker-model"))
      .toBe("reranker-model");
    expect(expected("MEMORY_RERANK", null)).toBe("system-model");
    expect(expected("MEMORY_HISTORY_CLASSIFY", "reranker-model"))
      .toBe("system-model");
  });

  it("decodes aligned official rows without changing their text", () => {
    const [entry] = decodeLongMemEvalDataset([fixture()]);
    expect(entry).toMatchObject({
      question: "What degree did I graduate with?",
      questionId: "question-1",
      questionType: "single-session-user"
    });
    expect(entry?.haystackSessions[0]?.[0]?.content)
      .toBe("I graduated in Business Administration.");
  });

  it("preserves empty turn content present in the official cleaned dataset", () => {
    const value = fixture();
    value.haystack_sessions[0]![0]!.content = "";
    const [entry] = decodeLongMemEvalDataset([value]);
    expect(entry?.haystackSessions[0]?.[0]?.content).toBe("");
  });

  it("closes any user-ended external transcript without rewriting official turns", () => {
    const official = Object.freeze([
      Object.freeze({ content: "External greeting", role: "assistant" as const }),
      Object.freeze({ content: "Final user detail", role: "user" as const })
    ]);
    const prepared = longMemEvalSettledImportTurns(official);
    expect(prepared).toEqual({
      appendedAssistantSettlement: true,
      turns: [
        ...official,
        { content: "", role: "assistant" }
      ]
    });
    expect(prepared.turns.slice(0, official.length)).toEqual(official);
    expect(official).toHaveLength(2);
    expect(longMemEvalSettledImportTurns([
      { content: "Settled answer", role: "assistant" }
    ])).toEqual({
      appendedAssistantSettlement: false,
      turns: [{ content: "Settled answer", role: "assistant" }]
    });
  });

  it("rejects misaligned sessions and malformed benchmark dates", () => {
    expect(() => decodeLongMemEvalDataset([{
      ...fixture(),
      haystack_dates: []
    }])).toThrow("longmemeval_session_alignment_invalid");
    expect(() => parseLongMemEvalDate("2023/05/30 (Mon) 23:40"))
      .toThrow("longmemeval_date_invalid");
  });

  it("uses the official question fields in the Memory query wrapper", () => {
    const [entry] = decodeLongMemEvalDataset([fixture()]);
    expect(longMemEvalQuestionPrompt(entry!)).toBe(
      "Please answer the question based on the relevant chat history.\n\n" +
      "Current Date: 2023/05/30 (Tue) 23:40\n" +
      "Question: What degree did I graduate with?\nAnswer:"
    );
  });

  it("selects a reproducible sample and preserves explicit question order", () => {
    const cases = decodeLongMemEvalDataset([
      fixture("question-1"),
      fixture("question-2"),
      fixture("question-3")
    ]);
    const first = selectLongMemEvalCases(cases, { sampleSize: 2, seed: "seed" });
    const second = selectLongMemEvalCases(cases, { sampleSize: 2, seed: "seed" });
    expect(first.cases.map(({ questionId }) => questionId))
      .toEqual(second.cases.map(({ questionId }) => questionId));
    expect(selectLongMemEvalCases(cases, {
      questionIds: ["question-3", "question-1"]
    }).cases.map(({ questionId }) => questionId)).toEqual([
      "question-3",
      "question-1"
    ]);
  });

  it("records a deterministic content-free baseline manifest", () => {
    const selection = selectLongMemEvalCases(decodeLongMemEvalDataset([
      fixture("question-1"),
      fixture("question-2")
    ]), { sampleSize: 2, seed: "fixed-seed" });
    const first = buildLongMemEvalBaselineManifest(selection);
    const second = buildLongMemEvalBaselineManifest(selection);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      configuration: {
        automaticFactLearning: false,
        embeddingBatchSize: 1,
        targetedPreFusionCandidates: 30
      },
      questionCount: 2,
      questionIdDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      seed: "fixed-seed",
      version: 1
    });
    expect(JSON.stringify(first)).not.toContain("What degree");
  });

  it("reports durable document batch sizes and one-input query requests", () => {
    expect(longMemEvalEmbeddingBatchSizeDistribution({
      documentBatches: [
        { executionBindingId: "document-1", itemCount: 16 },
        { executionBindingId: "document-2", itemCount: 3 }
      ],
      successfulExecutions: [
        { id: "contextual-key", logicalRole: "MEMORY_HISTORY_CLASSIFY" },
        { id: "document-1", logicalRole: "MEMORY_DOCUMENT_EMBED" },
        { id: "document-2", logicalRole: "MEMORY_DOCUMENT_EMBED" },
        { id: "query-1", logicalRole: "MEMORY_QUERY_EMBED" }
      ]
    })).toEqual({ "1": 1, "3": 1, "16": 1 });
    expect(() => longMemEvalEmbeddingBatchSizeDistribution({
      documentBatches: [],
      successfulExecutions: [{
        id: "document-1",
        logicalRole: "MEMORY_DOCUMENT_EMBED"
      }]
    })).toThrow("longmemeval_embedding_batch_receipt_incomplete");
  });

  it("computes benchmark-only source, round, MRR, NDCG, and reader-gap metrics", () => {
    expect(evaluateLongMemEvalComponentMetrics({
      answerRoundIds: ["round-b", "round-d"],
      answerSessionIds: ["session-b", "session-d"],
      candidates: [
        { evidenceHandle: "e1", roundId: "round-a", sessionId: "session-a" },
        { evidenceHandle: "e2", roundId: "round-b", sessionId: "session-b" },
        { evidenceHandle: "e3", roundId: "round-d", sessionId: "session-d" }
      ],
      k: 2
    })).toEqual({
      evidenceMrr: 0.5,
      evidenceNdcgAtK: 1 / Math.log2(3) / (1 + 1 / Math.log2(3)),
      k: 2,
      roundRecallAtK: 0.5,
      sourceSessionRecallAtK: 0.5
    });
    expect(longMemEvalReaderOracleGap(0.4, 1)).toBeCloseTo(0.6);
    expect(() => evaluateLongMemEvalComponentMetrics({
      answerSessionIds: ["session-b"],
      candidates: [
        { evidenceHandle: "duplicate", sessionId: "session-a" },
        { evidenceHandle: "duplicate", sessionId: "session-b" }
      ],
      k: 2
    })).toThrow("longmemeval_component_metric_input_invalid");
  });

  it("runs bounded concurrent work while preserving input order", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const pending = mapConcurrentOrdered([3, 2, 1, 0], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return value * 2;
    });

    await vi.waitFor(() => expect(active).toBe(3));
    release.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(active).toBe(1));
    release.splice(0).forEach((resolve) => resolve());

    await expect(pending).resolves.toEqual([6, 4, 2, 0]);
    expect(peak).toBe(3);
  });

  it("rejects invalid concurrency before starting work", async () => {
    const operation = vi.fn(async () => 1);
    await expect(mapConcurrentOrdered([1], 0, operation))
      .rejects.toThrow("longmemeval_concurrency_invalid");
    await expect(mapConcurrentOrdered(
      [1], LONGMEMEVAL_MAX_CONCURRENCY + 1, operation
    )).rejects.toThrow("longmemeval_concurrency_invalid");
    expect(operation).not.toHaveBeenCalled();
  });

  it("shards 500 evaluations evenly and merges them in answer order", () => {
    const questionIds = Array.from(
      { length: 500 },
      (_, index) => `question-${index}`
    );
    const shards = partitionLongMemEvalEvaluation(questionIds, 16);
    const sizes = shards.map((shard) => shard.length);
    expect(shards).toHaveLength(16);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(new Set(shards.flat())).toEqual(new Set(questionIds));

    const completed = [...shards].reverse().map((shard) =>
      [...shard].reverse().map((questionId) => ({
        questionId,
        value: `label-${questionId}`
      })));
    expect(mergeLongMemEvalEvaluationResults(questionIds, completed)).toEqual(
      questionIds.map((questionId) => `label-${questionId}`)
    );
  });

  it("fails closed for invalid evaluator concurrency or shard coverage", () => {
    expect(() => partitionLongMemEvalEvaluation(
      ["question-1"],
      LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY + 1
    )).toThrow("longmemeval_evaluator_concurrency_invalid");
    expect(() => mergeLongMemEvalEvaluationResults(
      ["question-1", "question-2"],
      [[{ questionId: "question-1", value: true }]]
    )).toThrow("longmemeval_evaluator_result_incomplete");
    expect(() => mergeLongMemEvalEvaluationResults(
      ["question-1"],
      [[
        { questionId: "question-1", value: true },
        { questionId: "question-1", value: false }
      ]]
    )).toThrow("longmemeval_evaluator_result_invalid");
  });

  it("stops admission and waits for active work before rejecting", async () => {
    let releaseActive: (() => void) | undefined;
    let activeSettled = false;
    const started: number[] = [];
    const pending = mapConcurrentOrdered([0, 1, 2], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
        activeSettled = true;
        return value;
      }
      throw new Error("expected_failure");
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(activeSettled).toBe(false);
    releaseActive?.();

    await expect(pending).rejects.toThrow("expected_failure");
    expect(activeSettled).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it("retains only aggregate text-free retrieval diagnostics", () => {
    expect(sanitizeLongMemEvalRetrievalAudit({
      aggregationBoundaryCount: 1,
      aggregationGroupCounts: { BOUNDARY: 1, MEMBER: 4, private_text: "hidden" },
      aggregationGuideFormat: "DETAILED",
      aggregationMemberCount: 4,
      aggregationOperation: "COUNT",
      aggregationResolution: "RESOLVED",
      aggregationState: "READY",
      budgetProfile: "COMPLEX",
      componentMetrics: {
        candidateCountsByLane: {
          FACT_EXACT: 4,
          HISTORY_RECALL_VECTOR: 6,
          private_text: "hidden"
        },
        candidatesRetainedAfterRejoin: 4,
        candidatesRetainedAfterReranker: 5,
        candidatesSentToReranker: 10,
        digestHits: 2,
        embeddingBatchSizeDistribution: { "1": 7 },
        packedEvidenceItems: 5,
        packedEvidenceTokens: 2_300,
        plannerFallbackUsed: false,
        queryVariantCounts: { CONTROL_NORMALIZED: 1, EXACT_NORMALIZED: 1 },
        rawChunkExpansions: 8,
        rawRoundExpansions: 0,
        rerankerFallbackUsed: true,
        safetyFindingCounts: { JSON_WEB_TOKEN: 1 },
        safetyMetricsState: "QUERY_ONLY_BASELINE",
        selectedSourceChats: 3,
        temporalFilteredCandidateCount: 0,
        temporalParserConfidence: null,
        temporalParserState: "NOT_AVAILABLE",
        temporalParserType: null,
        temporalUnrestrictedCandidateCount: 0,
        uniqueEvidenceRootsAfterFusion: 7,
        uniqueEvidenceRootsBeforeFusion: 9,
        utilityCallCounts: { MEMORY_CONTROL: 1, MEMORY_RERANK: 1 },
        utilityFailureReasonCounts: { memory_relevance_unavailable: 1 },
        version: "memory-retrieval-component-metrics-v1"
      },
      hardCapTokens: 5_000,
      itemCount: 5,
      omissionCounts: { history_limit: 2, unsafe: "secret text" },
      packedTokens: 2_300,
      plan: {
        aggregationRequested: true,
        mode: "PAST_CHAT_SEARCH",
        normalizedQuery: "private query"
      },
      providerTokenLimit: 48_000,
      reason: "no_relevant_memory",
      relevanceAcceptedCount: 5,
      relevanceCandidateCount: 10,
      relevanceDecisionCounts: { NOT_RELEVANT: 5, SUPPORTING_CONTEXT: 5 },
      relevanceDecisions: [{ text: "private candidate" }],
      relevanceRejoinedCount: 5,
      targetTokens: 4_000
    })).toEqual({
      aggregationBoundaryCount: 1,
      aggregationGroupCounts: { BOUNDARY: 1, MEMBER: 4 },
      aggregationGuideFormat: "DETAILED",
      aggregationMemberCount: 4,
      aggregationOperation: "COUNT",
      aggregationRequested: true,
      aggregationResolution: "RESOLVED",
      aggregationState: "READY",
      budgetProfile: "COMPLEX",
      candidateCountsByLane: { FACT_EXACT: 4, HISTORY_RECALL_VECTOR: 6 },
      candidatesRetainedAfterRejoin: 4,
      candidatesRetainedAfterReranker: 5,
      candidatesSentToReranker: 10,
      componentMetricsVersion: "memory-retrieval-component-metrics-v1",
      digestHits: 2,
      embeddingBatchSizeDistribution: { "1": 7 },
      hardCapTokens: 5_000,
      itemCount: 5,
      mode: "PAST_CHAT_SEARCH",
      omissionCounts: { history_limit: 2 },
      packedTokens: 2_300,
      plannerFallbackUsed: false,
      providerTokenLimit: 48_000,
      queryVariantCounts: { CONTROL_NORMALIZED: 1, EXACT_NORMALIZED: 1 },
      rawChunkExpansions: 8,
      rawRoundExpansions: 0,
      reason: "no_relevant_memory",
      relevanceAcceptedCount: 5,
      relevanceCandidateCount: 10,
      relevanceDecisionCounts: { NOT_RELEVANT: 5, SUPPORTING_CONTEXT: 5 },
      relevanceRejoinedCount: 5,
      rerankerFallbackUsed: true,
      safetyFindingCounts: { JSON_WEB_TOKEN: 1 },
      safetyMetricsState: "QUERY_ONLY_BASELINE",
      selectedSourceChats: 3,
      targetTokens: 4_000,
      temporalFilteredCandidateCount: 0,
      temporalParserConfidence: null,
      temporalParserState: "NOT_AVAILABLE",
      temporalParserType: null,
      temporalUnrestrictedCandidateCount: 0,
      uniqueEvidenceRootsAfterFusion: 7,
      uniqueEvidenceRootsBeforeFusion: 9,
      utilityCallCounts: { MEMORY_CONTROL: 1, MEMORY_RERANK: 1 },
      utilityFailureReasonCounts: { memory_relevance_unavailable: 1 }
    });
  });

  it("accepts only the acknowledged loopback ports and disposable database identity", () => {
    expect(assertBenchmarkBaseUrl("http://127.0.0.1:3137/", 3137).origin)
      .toBe("http://127.0.0.1:3137");
    expect(() => assertBenchmarkBaseUrl("http://127.0.0.1:3000/", 3000))
      .toThrow("longmemeval_base_url_not_isolated");
    const database = "postgresql://aiqsa_benchmark:" +
      "aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/" +
      "aiqsa_memory_benchmark?schema=public";
    expect(assertBenchmarkDatabaseUrl(database, 55437).pathname)
      .toBe("/aiqsa_memory_benchmark");
    expect(() => assertBenchmarkDatabaseUrl(database.replace("55437", "5432"), 5432))
      .toThrow("longmemeval_database_url_not_isolated");
  });

  it("confines generated artifacts to a child of the ignored results directory", () => {
    expect(resolveBenchmarkOutputDirectory("/repo/benchmarks/longmemeval", "results/run-1"))
      .toBe("/repo/benchmarks/longmemeval/results/run-1");
    expect(() => resolveBenchmarkOutputDirectory(
      "/repo/benchmarks/longmemeval",
      "../../outside"
    )).toThrow("longmemeval_output_directory_not_isolated");
  });
});
