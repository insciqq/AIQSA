import { describe, expect, it, vi } from "vitest";
import { brightAnswerDiagnostics, buildBrightAnswerReport } from "./brightAnswerReport";

const trace = {
  status: "complete", error: null, question: "Synthetic question", answer: "No evidence.",
  toolCalls: [{ toolName: "search_knowledge", state: "error", result: {
    content: [{ text: "Knowledge retrieval failed: fixture_failure." }]
  } }], knowledgeRuns: [], knowledgeProviderAttempts: []
};

describe("BRIGHT offline answer report", () => {
  it("counts pre-retrieval tool failure even when the chat completed", () => {
    expect(brightAnswerDiagnostics(trace)).toMatchObject({
      technicalFailure: true, searchToolCalls: 1, failedSearchToolCalls: 1,
      retrievalReceipts: 0, failureCodes: ["fixture_failure"]
    });
    expect(brightAnswerDiagnostics({ ...trace, toolCalls: [] })).toMatchObject({
      technicalFailure: false, searchToolCalls: 0, failureCodes: []
    });
    expect(() => brightAnswerDiagnostics({})).toThrow("trace_invalid");
  });

  it("does not export arbitrary tool error text as a failure code", () => {
    const diagnosed = brightAnswerDiagnostics({ ...trace, toolCalls: [{ toolName: "search_knowledge",
      state: "error", result: { content: [{ text: "An untrusted secret value" }] } }] });
    expect(diagnosed.technicalFailure).toBe(true);
    expect(diagnosed.failureCodes).toEqual([]);
  });

  it("retains the safe failure code from an executor exception", () => {
    expect(brightAnswerDiagnostics({ ...trace, toolCalls: [{
      toolName: "search_knowledge", state: "error",
      result: { content: [{ text: "Knowledge failed: knowledge_retrieval_failed" }] }
    }] })).toMatchObject({
      technicalFailure: true, failedSearchToolCalls: 1,
      failureCodes: ["knowledge_retrieval_failed"]
    });
  });

  it("derives correctness and execution failure separately without dispatch", async () => {
    const files = new Map<string, unknown>([
      ["001/answer.json", trace],
      ["001/judgment.json", { verdict: "fail", grounding: "no_citations", explanation: "Abstention.",
        missingPoints: ["Requested solution"], incorrectClaims: [] }]
    ]);
    const write = vi.fn(async (name: string, value: unknown) => { files.set(name, value); });
    const summary = await buildBrightAnswerReport({ read: async (name) => files.get(name) ?? null, write }, 2);
    expect(summary).toMatchObject({ requested: 2, evaluated: 1, fail: 1, technicalFailureCases: 1,
      searchToolCalls: 1, failedSearchToolCalls: 1, retrievalReceipts: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(files.get("report.json")).toMatchObject({ cases: [
      { ordinal: 1, answer: "No evidence." }, { ordinal: 2, status: "not_observed", judgment: null }
    ] });
  });
});
