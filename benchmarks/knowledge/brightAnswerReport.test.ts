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

  it("reads the structured search failure without depending on user-facing wording", () => {
    expect(brightAnswerDiagnostics({ ...trace, toolCalls: [{ toolName: "search_knowledge", state: "error",
      result: { content: [{ text: "Search is unavailable." }],
        rawPreview: { knowledgeFailure: { version: 1, code: "opensearch_timeout" } } }
    }] })).toMatchObject({ technicalFailure: true, failureCodes: ["opensearch_timeout"] });
  });

  it.each([
    [{ version: 1, kind: "rejected", reason: "evidence_invalid" }, "evidence_answer_evidence_invalid"],
    [{ version: 1, kind: "failed", reason: "transport" }, "evidence_answer_transport"],
    [{ kind: "draft_malformed", reason: "draft_claim_text_invalid" }, "draft_claim_text_invalid"],
    [{ kind: "draft_malformed" }, "draft_malformed"],
    [{ kind: "coverage_scope_failed", reason: "coverage_scope_anchor_invalid" }, "coverage_scope_anchor_invalid"],
    [{ kind: "coverage_scope_completeness_failed", reason: "coverage_scope_completeness_timeout" }, "coverage_scope_completeness_timeout"],
    [{ kind: "contribution_operation_failed", version: 1, reason: "invalid_output" }, "grounding_operation_invalid_output"],
    [{ kind: "contribution_operation_failed", version: 1, reason: "invalid_output", validationReason: "selector_dimension_invalid" }, "selector_dimension_invalid"]
  ])("counts an accepted failure marker even when the provider transport succeeded: %j", (acceptedResult, code) => {
    expect(brightAnswerDiagnostics({ ...trace, toolCalls: [], knowledgeProviderAttempts: [
      { failureCode: null, acceptedResult }, { failureCode: null, acceptedResult: { kind: "accepted" } }
    ] })).toMatchObject({ technicalFailure: true, failedProviderOperations: 1, failureCodes: [code] });
  });

  it("does not mistake an arbitrary accepted payload for a known failure", () => {
    expect(brightAnswerDiagnostics({ ...trace, toolCalls: [], knowledgeProviderAttempts: [
      { failureCode: null, acceptedResult: { kind: "draft_malformed", reason: "untrusted_private_text" } },
      { failureCode: null, acceptedResult: { kind: "contribution_operation_failed", version: 1, reason: "untrusted_private_text" } },
      { failureCode: null, acceptedResult: { kind: "contribution_operation_failed", version: 1, reason: "invalid_output", validationReason: "untrusted_private_text" } }
    ] })).toMatchObject({ technicalFailure: false, failedProviderOperations: 0, failureCodes: [] });
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

  it("reports the next batch from its original question ordinals", async () => {
    const write = vi.fn(async () => undefined);
    const read = vi.fn(async (name: string) => name === "006/answer.json" ? { ...trace, toolCalls: [] } : null);
    await buildBrightAnswerReport({ read, write }, 5, 5);
    expect(read).toHaveBeenCalledWith("006/answer.json");
    expect(read).not.toHaveBeenCalledWith("001/answer.json");
    expect(write).toHaveBeenCalledWith("report.json", expect.objectContaining({ cases: [
      expect.objectContaining({ ordinal: 6, status: "complete" }),
      ...[7, 8, 9, 10].map((ordinal) => expect.objectContaining({ ordinal, status: "not_observed" }))
    ] }));
    await expect(buildBrightAnswerReport({ read, write }, 5, 115)).rejects.toThrow("count_invalid");
  });
});
