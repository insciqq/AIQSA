import { describe, expect, it } from "vitest";
import {
  assertKnowledgeProfileBenchmarkGates,
  runKnowledgeProfileBenchmark
} from "./profileBenchmark";
import type { KnowledgeSemanticRerankerExecutor } from "./rerankerCandidates";
import { createKnowledgeRerankerCorpusManifest } from "./rerankerCorpus";

describe("Knowledge profile benchmark", () => {
  it("passes only the hermetic contract while keeping quality and selection ineligible", async () => {
    const report = await assertKnowledgeProfileBenchmarkGates();

    expect(report).toMatchObject({
      aggregateOnly: true,
      contractValid: true,
      embedding: {
        approval: "test_double_only",
        executionClass: "test_double",
        qualityGateEligible: false
      },
      humanReview: {
        adjudicationComplete: false,
        disagreement: {
          reason: "independent_relevance_labels_not_imported",
          status: "unavailable"
        },
        independentAnnotatorCount: 0,
        labelsStatus: "not_imported"
      },
      qualityGatePassed: false,
      selection: {
        decision: "not_selected",
        policyVersion: "knowledge-reranker-selection-policy-v1",
        selectedCandidateId: null,
        selectedCandidateRequiresProfileAuthorization: false,
        selectionEligible: false
      },
      version: "knowledge-profile-benchmark-v3"
    });
    expect(report.corpus).toMatchObject({
      documentCount: 50,
      familyLeakage: false,
      queryCount: 24
    });
    expect(report.candidates).toHaveLength(4);
    expect(report.candidates.map((candidate) => [
      candidate.identity.id,
      candidate.executionStatus
    ])).toEqual([
      ["deterministic_heuristic_v1", "complete"],
      ["local_multilingual_cross_encoder", "unavailable"],
      ["system_model_reranker", "unavailable"],
      ["hybrid_local_v1", "unavailable"]
    ]);
    expect(report.candidates.every((candidate) =>
      candidate.quality.status === "unavailable")).toBe(true);
    expect(report.selection.reasonCodes).toEqual(expect.arrayContaining([
      "approved_real_embedding_not_executed",
      "independent_relevance_labels_not_collected",
      "adjudication_not_completed",
      "required_candidate_execution_incomplete",
      "outage_evidence_incomplete",
      "resource_or_cost_evidence_incomplete"
    ]));
    expect(report.selection.policySha256).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(report);
    const corpus = createKnowledgeRerankerCorpusManifest();
    expect(corpus.documents.flatMap((document) => document.passages)
      .some((passage) => serialized.includes(passage.text))).toBe(false);
    expect(corpus.queries.some((query) => serialized.includes(query.text))).toBe(false);
  });

  it("aggregates isolated local and provider-managed resources plus outage fallback evidence", async () => {
    const semantic = (
      kind: "local" | "system"
    ): KnowledgeSemanticRerankerExecutor => ({
      identity: {
        authorization: "evaluation_only",
        backend: `${kind}-contract-runner`,
        egress: kind === "local" ? "none" : "external",
        hardware: kind === "local" ? "cpu" : "provider_managed",
        modelId: `${kind}-contract-model`,
        provider: kind,
        resources: kind === "local"
          ? { cpuLogicalCores: 4, gpuDevice: null, scope: "isolated_runner" }
          : { cpuLogicalCores: null, gpuDevice: null, scope: "provider_managed" },
        revision: "frozen-test-revision"
      },
      async rerank(input) {
        return {
          costMicros: kind === "local" ? 0 : 100,
          inputTokens: 100,
          resourceUsage: kind === "local"
            ? { peakGpuMemoryBytes: null, peakRssBytes: 256 * 1024 ** 2 }
            : null,
          scores: input.passages.map((passage, index) => ({
            passageId: passage.id,
            score: (input.passages.length - index) / input.passages.length
          }))
        };
      }
    });

    const report = await runKnowledgeProfileBenchmark({
      localCrossEncoder: semantic("local"),
      systemModel: semantic("system")
    });
    expect(report.candidates.map((candidate) => candidate.executionStatus))
      .toEqual(["complete", "complete", "complete", "complete"]);
    expect(report.candidates.slice(1).every((candidate) =>
      candidate.outage.status === "verified_in_benchmark" &&
      candidate.outage.technicalLeakageObserved === false)).toBe(true);
    expect(report.candidates[1]).toMatchObject({
      gpu: { peakBytes: 0, status: "not_used" },
      rss: { peakBytes: 256 * 1024 ** 2, status: "measured" }
    });
    expect(report.candidates[2]).toMatchObject({
      gpu: { peakBytes: null, status: "provider_managed" },
      rss: { peakBytes: null, status: "provider_managed" }
    });
    expect(report.selection.reasonCodes).not.toEqual(expect.arrayContaining([
      "required_candidate_execution_incomplete",
      "outage_evidence_incomplete",
      "resource_or_cost_evidence_incomplete"
    ]));
    expect(report.selection.selectionEligible).toBe(false);
  });

  it("normalizes candidate outages while preserving deterministic fallback evidence", async () => {
    const failedLocal: KnowledgeSemanticRerankerExecutor = {
      identity: {
        authorization: "evaluation_only",
        backend: "local-contract-runner",
        egress: "none",
        hardware: "cpu",
        modelId: "local-contract-model",
        provider: "local",
        revision: "frozen-test-revision"
      },
      async rerank() {
        throw new Error("private runner transport detail");
      }
    };
    const report = await runKnowledgeProfileBenchmark({ localCrossEncoder: failedLocal });
    expect(report.candidates[1]).toMatchObject({
      executionStatus: "failed",
      failureCode: "candidate_execution_failed",
      outage: {
        status: "verified_in_benchmark",
        technicalLeakageObserved: false
      }
    });
    expect(report.candidates[3]).toMatchObject({
      executionStatus: "failed",
      failureCode: "candidate_execution_failed",
      outage: { status: "verified_in_benchmark" }
    });
    expect(JSON.stringify(report)).not.toContain("private runner transport detail");
    expect(report.selection.selectionEligible).toBe(false);
  });
});
