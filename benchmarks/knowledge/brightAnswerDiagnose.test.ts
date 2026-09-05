import { describe, expect, it, vi } from "vitest";
import { buildBrightStageReport, compareBrightDiagnosticManifests, diagnoseBrightAnswerTrace } from "./brightAnswerDiagnose";

const at = (second: number) => new Date(second * 1000).toISOString();
function trace() {
  return { status: "complete", error: null, question: "PRIVATE_QUESTION", answer: "PRIVATE_ANSWER", createdAt: at(0), updatedAt: at(10),
    toolCalls: [0, 1, 2].map(index => ({ toolName: "search_knowledge", state: "complete", startedAt: at(1 + index), completedAt: at(2 + index),
      arguments: { query: index ? "  PRIVATE_QUERY  " : "PRIVATE_QUERY", sourceAliases: index === 2 ? ["S1"] : [] } })),
    knowledgeRuns: [{ candidateCount: 12, outcome: "complete", results: [{ handle: "K1" }, { handle: "K2" }], durationMs: 500,
      lexicalBackendEvidence: { durationMs: 40 }, readReceipt: { rerankerBinding: { durationMs: 100 } }, embeddingUsage: [{ durationMs: 50 }] },
      { candidateCount: 0, outcome: "no_relevant_evidence", results: [], durationMs: 10 }],
    knowledgeRetrievalSession: { degradedFlags: ["PRIVATE_FLAG"] },
    knowledgeDispatchManifests: [null, at(5)].map(dispatchedAt => ({ providerAttempt: { dispatchedAt, purpose: "knowledge_evidence_compose_v2" },
      totalBytes: 1000, totalTokens: 250, items: [{ handle: "K1", renderedBlock: JSON.stringify({ text: "PRIVATE_EVIDENCE", expandedContextState: "omitted" }) }],
      exclusions: [{ handle: "K2", reason: "budget" }] })),
    knowledgeProviderAttempts: [{ purpose: "knowledge_evidence_review_v2", dispatchedAt: at(6), settledAt: at(9),
      acceptedResult: { version: 2, coverage: "partial", blocks: [{ verdict: "supported" }, { verdict: "unsupported" }],
        requirements: [{ status: "answered" }, { status: "needs_correction" }, { status: "missing_evidence" }], followUps: [{ query: "PRIVATE_QUERY" }] } }]
  };
}

describe("content-free stage diagnosis", () => {
  it("separates search scope, lost primaries, review gaps and overlapping durations without claiming relevance", () => {
    const report = diagnoseBrightAnswerTrace(trace());
    expect(report).toMatchObject({ technical: { technicalFailure: false }, degradedFlagCount: 1,
      retrieval: { candidateCounts: [12, 0], resultCounts: [2, 0], emptySearches: 1, broadSearches: 2, scopedSearches: 1, repeatedQueries: 1 },
      packing: { distinctReturnedPrimaries: 2, returnedPrimariesAbsentFromFinalContext: 1,
        compositions: [{ items: 1, bytes: 1000, tokens: 250, budgetExclusions: 1, expansionsIncluded: 0, expansionsOmitted: 1 }] },
      reviews: [{ coverage: "partial", supportedBlocks: 1, rejectedBlocks: 1, followUps: 1,
        requirements: { total: 3, answered: 1, needsCorrection: 1, missingEvidence: 1 } }],
      timing: { observedRunMs: 10000, beforeFirstSearchMs: 1000,
        searchWall: { measured: 3, totalMs: 3000 }, retrievalService: { totalMs: 510 },
        rerankService: { measured: 1, unavailable: 1, totalMs: 100 }, embeddingService: { measured: 1, unavailable: 1, totalMs: 50 },
        answerOperations: { totalMs: 3000 } },
      packingReplay: { status: "unavailable", reason: "missing_replay_context" } });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(report.unavailableAttribution).toContain("semantic_premise_coverage");
  });

  it("does not invent zero latency or a successful run when records are missing", () => {
    const empty = { ...trace(), createdAt: null, updatedAt: null, toolCalls: [], knowledgeRuns: [], knowledgeDispatchManifests: [], knowledgeProviderAttempts: [] };
    expect(diagnoseBrightAnswerTrace(empty)).toMatchObject({ timing: { observedRunMs: null, beforeFirstSearchMs: null,
      retrievalService: { measured: 0, unavailable: 0, totalMs: null } } });
    expect(() => diagnoseBrightAnswerTrace({ ...empty, toolCalls: [null] })).toThrow("trace_invalid");
    expect(() => diagnoseBrightAnswerTrace({ ...empty, toolCalls: Array.from({ length: 33 }, () => ({})) })).toThrow("trace_invalid");
  });

  it("keeps unobserved, judged and technically failed cases separate without reading references", async () => {
    const files = new Map<string, unknown>([
      ["006/answer-trace.json", { ...trace(), status: "error", error: "knowledge_answer_failed" }],
      ["007/answer.json", trace()], ["007/judgment.json", { verdict: "partial", grounding: "supported", explanation: "PRIVATE_REASON",
        missingPoints: ["PRIVATE_GAP"], incorrectClaims: [] }]
    ]);
    const read = vi.fn(async (name: string) => files.get(name) ?? null);
    const report = await buildBrightStageReport({ read }, 3, 5);
    expect(report.summary).toMatchObject({ requested: 3, observed: 2, evaluated: 1, partial: 1, pass: 0,
      technicalFailureCases: 1, degradedCases: 2, replayUnavailableCases: 2 });
    expect(report.cases[2]).toMatchObject({ ordinal: 8, observed: false, judgment: null, stages: null });
    expect(read.mock.calls.some(([name]) => name.includes("evaluation"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    await expect(buildBrightStageReport({ read }, 5, 115)).rejects.toThrow("count_invalid");
  });

  it("marks different models, query sets and budgets as confounded comparisons", () => {
    const baseline = { codeFingerprint: "old", model: { id: "model" }, queryOffset: 0, budget: 16 };
    expect(compareBrightDiagnosticManifests({ ...baseline, codeFingerprint: "new" }, baseline)).toEqual({
      comparableControls: true, codeChanged: true, changedFields: ["codeFingerprint"] });
    for (const change of [{ model: { id: "other" } }, { queryOffset: 5 }, { budget: 32 }]) {
      expect(compareBrightDiagnosticManifests({ ...baseline, ...change }, baseline).comparableControls).toBe(false);
    }
  });
});
