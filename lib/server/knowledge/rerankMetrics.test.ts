import { describe, expect, it } from "vitest";
import { aggregateKnowledgeRerankMetrics } from "./rerankMetrics";
import {
  KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
  type KnowledgeRerankerBindingEvidenceV2
} from "./rerankEvidence";

function evidence(
  overrides: Partial<KnowledgeRerankerBindingEvidenceV2>
): KnowledgeRerankerBindingEvidenceV2 {
  return {
    adapterVersion: "openrouter-rerank-v1",
    candidateFormatterVersion: 1,
    connectionSnapshotId: "connection#v1",
    credentialSnapshotRef: "credential-version",
    durationMs: 100,
    fallbackReason: null,
    inputCandidateCount: 10,
    orderedCandidateChunkIds: [],
    outputOrder: [],
    policyVersion: 1,
    provider: "openrouter",
    providerModelId: "deployment-1",
    providerRequestId: null,
    rankingProfileVersion: 4,
    relevanceScores: [],
    status: "complete",
    timedOut: false,
    upstreamModelId: "qwen/qwen3-reranker-8b",
    usage: { searchUnits: null, totalTokens: null },
    version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
    ...overrides
  };
}

function scoredComplete(durationMs: number, inputCandidateCount: number) {
  return evidence({
    durationMs,
    inputCandidateCount,
    orderedCandidateChunkIds: Array.from({ length: inputCandidateCount },
      (_, index) => `chunk-${index}`),
    outputOrder: Array.from({ length: inputCandidateCount }, (_, index) => `chunk-${index}`),
    relevanceScores: Array.from({ length: inputCandidateCount }, () => 0.5),
    usage: { searchUnits: 1, totalTokens: 100 }
  });
}

describe("Knowledge rerank operational metrics", () => {
  it("returns an empty content-free aggregate for no evidence", () => {
    expect(aggregateKnowledgeRerankMetrics([])).toEqual({
      averageInputCandidates: null,
      calls: 0,
      complete: 0,
      disabled: 0,
      fallback: 0,
      malformedResponse: 0,
      operations: 0,
      p50DurationMs: null,
      p95DurationMs: null,
      partial: 0,
      timeout: 0,
      totalSearchUnits: 0,
      totalTokens: 0
    });
  });

  it("classifies statuses, counts attempted calls, and aggregates durations and usage", () => {
    const metrics = aggregateKnowledgeRerankMetrics([
      scoredComplete(100, 96),
      scoredComplete(300, 48),
      // Deterministic single-candidate skip: complete without a call.
      evidence({
        inputCandidateCount: 1,
        orderedCandidateChunkIds: ["chunk-a"],
        outputOrder: ["chunk-a"],
        relevanceScores: [null]
      }),
      evidence({
        fallbackReason: "rerank_request_timed_out",
        status: "degraded",
        timedOut: true
      }),
      evidence({ fallbackReason: "rerank_response_invalid", status: "degraded" }),
      evidence({ fallbackReason: "reranker_model_unavailable", status: "degraded" }),
      evidence({
        adapterVersion: null,
        candidateFormatterVersion: null,
        connectionSnapshotId: null,
        credentialSnapshotRef: null,
        durationMs: 0,
        inputCandidateCount: 0,
        policyVersion: null,
        provider: null,
        providerModelId: null,
        status: "disabled",
        upstreamModelId: null
      }),
      evidence({
        inputCandidateCount: 4,
        orderedCandidateChunkIds: ["chunk-a", "chunk-b", "chunk-c", "chunk-d"],
        outputOrder: ["chunk-a", "chunk-b", "chunk-c", "chunk-d"],
        relevanceScores: [0.9, 0.8, null, null],
        status: "partial",
        usage: { searchUnits: null, totalTokens: 40 }
      })
    ]);
    expect(metrics).toMatchObject({
      complete: 3,
      disabled: 1,
      fallback: 3,
      malformedResponse: 1,
      operations: 8,
      partial: 1,
      timeout: 1,
      totalSearchUnits: 2,
      totalTokens: 240
    });
    // Attempted calls: two scored completes, one partial, and the two
    // degraded outcomes that reached the provider (timeout + malformed);
    // the unavailable fallback, disabled role, and skip made no request.
    expect(metrics.calls).toBe(5);
    expect(metrics.averageInputCandidates).toBe((96 + 48 + 4 + 10 + 10) / 5);
    expect(metrics.p50DurationMs).toBe(100);
    expect(metrics.p95DurationMs).toBe(300);
  });

  it("computes deterministic percentiles over attempted call durations", () => {
    const metrics = aggregateKnowledgeRerankMetrics(
      [50, 100, 150, 200].map((durationMs) => scoredComplete(durationMs, 10))
    );
    expect(metrics.p50DurationMs).toBe(100);
    expect(metrics.p95DurationMs).toBe(200);
  });
});
