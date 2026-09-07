import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { brightAnswerHash as hash } from "./brightAnswerHarness";
import {
  buildOpenRagDiagnostic, compareOpenRagDiagnosticManifests, compareOpenRagDiagnostics,
  diagnoseOpenRagAnswers, openRagDiagnosticManifest
} from "./openRagAnswerDiagnose";

const at = (second: number) => new Date(second * 1000).toISOString();
function manifest(caseIds = ["doc-001-q1"]) {
  return { schemaVersion: 1, protocol: "aiqsa_current_openrag_answer", caseIds, casesFingerprint: hash(caseIds),
    codeFingerprint: hash("code"), fullSlice: false, answerModel: { id: "model" }, judgeModel: { id: "judge" },
    answerControls: {}, judgeControls: {}, engine: { version: 11 }, policies: {}, schema: {}, corpus: { profile: 13 }, judgeContractVersion: 1 };
}
function fixture(input: { verdict?: "pass" | "partial" | "fail"; question?: string; chunk?: string; ordinal?: number; caseId?: string } = {}) {
  const verdict = input.verdict ?? "pass", question = input.question ?? "PRIVATE_QUESTION", ordinal = input.ordinal ?? 1;
  const review = { version: 2, coverage: "complete", blocks: [{ verdict: "supported", evidenceHandles: ["K1"] }],
    requirements: [{ status: "answered" }], followUps: [], analysisComplete: true };
  const trace = { status: "complete", question, answer: "PRIVATE_ANSWER", createdAt: at(0), updatedAt: at(5), error: null,
    toolCalls: [{ toolName: "search_knowledge", state: "complete", startedAt: at(1), completedAt: at(2),
      arguments: { query: "PRIVATE_QUERY", sourceAliases: [] } }],
    knowledgeRuns: [{ candidateCount: 2, outcome: "complete", results: [{ handle: "K1", sourceArtifactId: "PRIVATE_ARTIFACT",
      documentVersionId: "PRIVATE_VERSION", chunkId: input.chunk ?? "PRIVATE_CHUNK", includedText: "PRIVATE_EVIDENCE" }] }],
    knowledgeDispatchManifests: [{ providerAttempt: { ordinal: 1, purpose: "knowledge_evidence_compose_v2", dispatchedAt: at(3) }, messageText: "PRIVATE_CONTEXT",
      items: [{ handle: "K1", exactExcerpt: "PRIVATE_EVIDENCE", renderedBlock: JSON.stringify({ exactExcerpt: "PRIVATE_EVIDENCE" }) }], exclusions: [] }],
    knowledgeProviderAttempts: [{ purpose: "knowledge_evidence_review_v2", requestHash: hash("request"), resultHash: hash(review),
      acceptedResult: review, dispatchedAt: at(4), settledAt: at(5) },
      { ordinal: 1, purpose: "knowledge_evidence_compose_v2", requestHash: hash("compose-request"), resultHash: hash("draft"),
        acceptedRequest: { userPrompt: JSON.stringify({ evidenceManifest: "PRIVATE_CONTEXT" }) }, dispatchedAt: at(3), settledAt: at(4) }],
    knowledgeRetrievalSession: { degradedFlags: [], groundingResult: {
      finalAnswerHash: createHash("sha256").update("PRIVATE_ANSWER").digest("hex"), evidence: {
        version: 58, groundingStatus: "verified", requestCoverage: "complete",
        finalAnswerHash: createHash("sha256").update("PRIVATE_ANSWER").digest("hex"),
        operations: [{ purpose: "knowledge_evidence_compose_v2", acceptedRequestHash: hash("compose-request"), acceptedResultHash: hash("draft") },
          { purpose: "knowledge_evidence_review_v2", acceptedRequestHash: hash("request"), acceptedResultHash: hash(review) }]
      } } }
  };
  const prefix = String(ordinal).padStart(3, "0");
  const files = new Map<string, unknown>([
    [`${prefix}/answer.json`, trace],
    [`${prefix}/answer-request.json`, { content: { blocks: [{ type: "text", text: question }] } }],
    [`${prefix}/outcome.json`, { caseId: input.caseId ?? "doc-001-q1", ordinal, answerStatus: "complete", verdict, coverage: "complete" }],
    [`${prefix}/judgment.json`, { judgment: { verdict, correctness: verdict === "pass" ? 4 : verdict === "partial" ? 2 : 0,
      reasonCode: verdict === "pass" ? "correct" : "wrong_value", grounded: true, explanation: "PRIVATE_EXPLANATION" } }]
  ]);
  const read = vi.fn(async (name: string) => files.get(name) ?? null);
  return { trace, files, read };
}

describe("offline OpenRAG diagnosis", () => {
  it("reuses saved evidence and flags reviewer/judge disagreement without reading references or exposing content", async () => {
    const saved = fixture({ verdict: "fail" });
    const { report } = await buildOpenRagDiagnostic(saved, manifest());
    expect(report.summary).toMatchObject({ requested: 1, evaluated: 1, fail: 1, reviewerJudgeDisagreements: 1,
      technicalFailureCases: 0, degradedCases: 0, replayUnavailable: 1 });
    expect(report.cases[0]).toMatchObject({ publication: { coverage: "complete", requirements: { answered: 1, needsCorrection: 0 } } });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(saved.read.mock.calls.some(([name]) => name.includes("evaluation"))).toBe(false);
  });

  it("matches cases by identity when order changes and compares actual evidence rather than handles", async () => {
    const old = fixture({ ordinal: 1, verdict: "pass" });
    const moved = fixture({ ordinal: 2, verdict: "partial", chunk: "PRIVATE_OTHER_CHUNK" });
    const baseline = await buildOpenRagDiagnostic(old, manifest());
    const current = await buildOpenRagDiagnostic(moved, manifest(["doc-002-q1", "doc-001-q1"]));
    const comparison = compareOpenRagDiagnostics(current, baseline);
    expect(comparison.summary).toMatchObject({ paired: 1, regressed: 1, unavailable: 1 });
    expect(comparison.pairs[1]).toMatchObject({ ordinal: 2, baselineOrdinal: 1, sameQuestion: true,
      returned: { shared: 0, added: 1, removed: 1 }, finalContext: { shared: 0, added: 1, removed: 1 } });
    expect(JSON.stringify(comparison)).not.toContain("PRIVATE");
  });

  it("does not count changed questions or unfinished cases as score improvements", async () => {
    const baseline = await buildOpenRagDiagnostic(fixture({ verdict: "fail" }), manifest());
    const changed = await buildOpenRagDiagnostic(fixture({ question: "A different PRIVATE_QUESTION" }), manifest());
    expect(compareOpenRagDiagnostics(changed, baseline).summary).toMatchObject({ improved: 0, unavailable: 1, questionChanges: 1 });
    const pending = fixture();
    pending.files.delete("001/outcome.json");
    const current = await buildOpenRagDiagnostic(pending, manifest());
    expect(compareOpenRagDiagnostics(current, baseline).summary).toMatchObject({ improved: 0, unavailable: 1 });
  });

  it("checks model, profile and unknown controls independently of the changed engine", () => {
    const prior = manifest();
    expect(compareOpenRagDiagnosticManifests({ ...prior, codeFingerprint: hash("new"), engine: { version: 12 } }, prior))
      .toMatchObject({ controlsMatch: true, codeChanged: true, engineChanged: true });
    for (const change of [{ answerModel: { id: "other" } }, { corpus: { profile: 14 } }, { futureBudget: 100 }]) {
      expect(compareOpenRagDiagnosticManifests({ ...prior, ...change }, prior).controlsMatch).toBe(false);
    }
    expect(() => openRagDiagnosticManifest({ ...prior, caseIds: ["doc-001-q1", "doc-001-q1"] })).toThrow("manifest_invalid");
  });

  it("uses the receipt-selected review even if a later discarded review claims a different result", async () => {
    const saved = fixture();
    const later = { version: 2, coverage: "none", requirements: [{ status: "missing_evidence" }], blocks: [], followUps: [], analysisComplete: true };
    saved.trace.knowledgeProviderAttempts.push({ ...saved.trace.knowledgeProviderAttempts[0]!,
      requestHash: hash("later"), resultHash: hash(later), acceptedResult: later, settledAt: at(6) });
    const { report } = await buildOpenRagDiagnostic(saved, manifest());
    expect(report.cases[0]?.publication?.coverage).toBe("complete");
    expect(report.cases[0]?.stages?.reviews.at(-1)?.coverage).toBe("none");
  });

  it("compares the published context even when a later discarded composition used different text", async () => {
    const original = fixture();
    const changed = fixture();
    const first = changed.trace.knowledgeDispatchManifests[0]!;
    changed.trace.knowledgeDispatchManifests.push({ ...first, messageText: "PRIVATE_DISCARDED_CONTEXT",
      providerAttempt: { ...first.providerAttempt, ordinal: 3, dispatchedAt: at(6) },
      items: [{ ...first.items[0]!, exactExcerpt: "PRIVATE_DISCARDED_EXCERPT",
        renderedBlock: JSON.stringify({ exactExcerpt: "PRIVATE_DISCARDED_EXCERPT" }) }] });
    const baseline = await buildOpenRagDiagnostic(original, manifest());
    const current = await buildOpenRagDiagnostic(changed, manifest());
    expect(compareOpenRagDiagnostics(current, baseline).pairs[0]?.finalContext)
      .toMatchObject({ shared: 1, added: 0, removed: 0, changedText: 0, orderChanged: false });
    changed.trace.knowledgeDispatchManifests[0]!.messageText = "PRIVATE_MISMATCH";
    await expect(buildOpenRagDiagnostic(changed, manifest())).rejects.toThrow("publication_composition_invalid");
  });

  it("rejects mismatched request, outcome and publication bindings", async () => {
    const request = fixture();
    request.files.set("001/answer-request.json", { content: { blocks: [{ text: "other" }] } });
    await expect(buildOpenRagDiagnostic(request, manifest())).rejects.toThrow("question_binding_invalid");
    const outcome = fixture();
    outcome.files.set("001/outcome.json", { caseId: "doc-002-q1", ordinal: 1 });
    await expect(buildOpenRagDiagnostic(outcome, manifest())).rejects.toThrow("case_binding_invalid");
    const published = fixture();
    published.trace.knowledgeRetrievalSession.groundingResult.evidence.finalAnswerHash = hash("other");
    await expect(buildOpenRagDiagnostic(published, manifest())).rejects.toThrow("publication_invalid");
    const review = fixture();
    review.trace.knowledgeProviderAttempts[0]!.resultHash = hash("other");
    await expect(buildOpenRagDiagnostic(review, manifest())).rejects.toThrow("publication_review_invalid");
  });

  it("keeps absent and failed answers separate from judged failures", async () => {
    const absent = await buildOpenRagDiagnostic({ read: async () => null }, manifest());
    expect(absent.report.summary).toMatchObject({ observed: 0, evaluated: 0, fail: 0 });
    const failed = fixture();
    failed.trace.status = "error";
    failed.files.delete("001/judgment.json");
    failed.files.set("001/outcome.json", { caseId: "doc-001-q1", ordinal: 1, answerStatus: "error", verdict: null, coverage: null });
    const result = await buildOpenRagDiagnostic(failed, manifest());
    expect(result.report.summary).toMatchObject({ settled: 1, evaluated: 0, fail: 0, technicalFailureCases: 1 });
  });

  it("rejects overlapping input/output directories and paid or duplicate options before any store is opened", async () => {
    await expect(diagnoseOpenRagAnswers(["--input", "results/run", "--output", "results/run/report"]))
      .rejects.toThrow("overlapping_paths");
    await expect(diagnoseOpenRagAnswers(["--input", "results/run", "--output", "results/run"]))
      .rejects.toThrow("overlapping_paths");
    await expect(diagnoseOpenRagAnswers(["--input", "results/run", "--input", "results/other", "--output", "results/report"]))
      .rejects.toThrow("arguments_invalid");
    await expect(diagnoseOpenRagAnswers(["--confirm-paid", "OPENRAG"])).rejects.toThrow("arguments_invalid");
  });
});
