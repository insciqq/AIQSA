import { describe, expect, it } from "vitest";
import {
  evaluateKnowledgeRerankerSelectionPolicy,
  KNOWLEDGE_RERANKER_NO_ANSWER_THRESHOLDS,
  KNOWLEDGE_RERANKER_SELECTION_POLICY,
  KNOWLEDGE_RERANKER_SELECTION_POLICY_SHA256,
  type KnowledgeRerankerPolicyCandidateEvidence
} from "./rerankerSelectionPolicy";

function quality(value: number) {
  const slice = {
    meanReciprocalRankAt10: value,
    ndcgAt10: value,
    noAnswerAccuracy: 1,
    recallAt10: value
  };
  return {
    byLanguage: { en: slice, ru: slice },
    overall: slice,
    status: "measured_from_imported_human_labels" as const
  };
}

function candidate(input: Readonly<{
  id: string;
  kind: KnowledgeRerankerPolicyCandidateEvidence["kind"];
  qualityValue: number;
}>): KnowledgeRerankerPolicyCandidateEvidence {
  return {
    authorization: input.kind === "system_model" ? "profile_authorized" : "local",
    costMicrosPerQuery: input.kind === "system_model" ? 500 : 0,
    costStatus: "measured",
    egress: input.kind === "system_model" ? "external" : "none",
    executionStatus: "complete",
    gpu: input.kind === "system_model"
      ? { peakBytes: null, status: "provider_managed" }
      : input.kind === "deterministic"
        ? { peakBytes: 0, status: "not_used" }
        : { peakBytes: 0, status: "not_used" },
    id: input.id,
    kind: input.kind,
    outageStatus: input.kind === "deterministic" ? "not_applicable" : "verified_in_benchmark",
    performance: {
      p95Milliseconds: input.kind === "system_model" ? 400 : 100,
      status: "measured",
      throughputQueriesPerSecond: 5
    },
    quality: quality(input.qualityValue),
    resourceScope: input.kind === "system_model"
      ? "provider_managed"
      : input.kind === "deterministic" ? "shared_process" : "isolated_runner",
    rss: input.kind === "system_model"
      ? { peakBytes: null, status: "provider_managed" }
      : input.kind === "deterministic"
        ? { peakBytes: null, status: "unavailable" }
        : { peakBytes: 512 * 1024 ** 2, status: "measured" }
  };
}

describe("Knowledge reranker frozen selection policy", () => {
  it("pins the calibration grid, held-out policy and content-free digest", () => {
    expect(KNOWLEDGE_RERANKER_NO_ANSWER_THRESHOLDS).toEqual([
      0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
      0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1
    ]);
    expect(KNOWLEDGE_RERANKER_SELECTION_POLICY).toMatchObject({
      calibration: { split: "calibration", tieBreak: "lowest_threshold" },
      evidence: { metricSplit: "held_out" },
      version: "knowledge-reranker-selection-policy-v1"
    });
    expect(KNOWLEDGE_RERANKER_SELECTION_POLICY_SHA256).toBe(
      "95f3b31dd415c604770c9b2cbbdc4329e58c1b6e5785a142a1bb49564eb1477e"
    );
  });

  it("selects by frozen aggregate evidence only after all prerequisites are satisfied", () => {
    const candidates = [
      candidate({ id: "deterministic_heuristic_v1", kind: "deterministic", qualityValue: 0.7 }),
      candidate({ id: "local_multilingual_cross_encoder", kind: "local_cross_encoder", qualityValue: 0.74 }),
      candidate({ id: "system_model_reranker", kind: "system_model", qualityValue: 0.73 }),
      candidate({ id: "hybrid_local_v1", kind: "hybrid", qualityValue: 0.75 })
    ];
    const blocked = evaluateKnowledgeRerankerSelectionPolicy({
      candidates,
      prerequisiteReasonCodes: ["independent_relevance_labels_not_collected"]
    });
    expect(blocked).toMatchObject({
      decision: "not_selected",
      selectedCandidateId: null,
      selectionEligible: false
    });

    const selected = evaluateKnowledgeRerankerSelectionPolicy({ candidates });
    expect(selected).toMatchObject({
      decision: "selected",
      eligibleCandidateIds: [
        "hybrid_local_v1",
        "local_multilingual_cross_encoder",
        "system_model_reranker"
      ],
      reasonCodes: [],
      selectedCandidateId: "hybrid_local_v1",
      selectedCandidateRequiresProfileAuthorization: false,
      selectionEligible: true
    });

    const systemBest = candidates.map((entry) => entry.id === "system_model_reranker"
      ? { ...entry, authorization: "evaluation_only" as const, quality: quality(0.8) }
      : entry);
    expect(evaluateKnowledgeRerankerSelectionPolicy({ candidates: systemBest })).toMatchObject({
      decision: "selected",
      selectedCandidateId: "system_model_reranker",
      selectedCandidateRequiresProfileAuthorization: true,
      selectionEligible: true
    });
  });
});
