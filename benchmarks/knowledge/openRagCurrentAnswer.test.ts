import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../../lib/server/knowledge/evidenceAnswerSnapshotV2";
import type { BrightAnswerTrace } from "./brightAnswerTrace";
import type { OpenRagAnswerCase } from "./openRagAnswerContract";
import { boundedOpenRagCitedEvidence } from "./openRagAnswerEvaluate";
import { assertOpenRagCurrentSchema, currentOpenRagEvaluationInput, parseOpenRagCurrentCli, runOpenRagCurrentCases } from "./openRagCurrentAnswer";

function question(index = 1): OpenRagAnswerCase {
  const documentAlias = `doc-${String(index).padStart(3, "0")}`;
  return { caseId: `${documentAlias}-q1`, documentAlias, question: `Synthetic question ${index}?`,
    referenceAnswer: "EVALUATOR_ONLY_REFERENCE", evaluationMode: "open_rag_reference_answer",
    goldSectionId: 0, kind: "fact", source: "text", type: "extractive" };
}

function trace(coverage: "complete" | "partial" | "none" = "complete"): BrightAnswerTrace {
  const answer = coverage === "none" ? "Insufficient evidence." : "A supported value. [K1]";
  const finalAnswerHash = createHash("sha256").update(answer).digest("hex");
  const outcome = coverage === "none" ? "insufficient_evidence" : "answered";
  return { id: "run", status: "complete", error: null, answer, inputTokens: 10, outputTokens: 5,
    toolCalls: [], knowledgeRuns: [], knowledgeProviderAttempts: [],
    knowledgeRetrievalSession: { degradedFlags: [], evidenceItems: [], groundingResult: {
      outcome, finalAnswerHash, evidence: { version: 60, contracts: KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2,
        finalAnswerHash, requestCoverage: coverage, groundingStatus: "verified", outcome }
    } },
    knowledgeDispatchManifests: [{ providerAttempt: { dispatchedAt: "2026-01-01T00:00:00Z" }, items: [
      { handle: "K1", renderedBlock: JSON.stringify({ handle: "K1", sourceLabel: "Neutral source", locator: "Page 1", exactExcerpt: "A supported value." }) },
      { handle: "K2", renderedBlock: JSON.stringify({ handle: "K2", exactExcerpt: "UNCITED_SOURCE" }) }
    ] }]
  } as unknown as BrightAnswerTrace;
}

function store() {
  const files = new Map<string, unknown>();
  return { files, read: vi.fn(async (name: string) => files.get(name) ?? null),
    write: vi.fn(async (name: string, value: unknown) => { files.set(name, value); }) };
}

const paid = ["--confirm-paid", "OPENRAG", "--baseline", ".aiqsa/baseline/checkpoint.json", "--output", "results/current"];

describe("current OpenRAG measurement", () => {
  it("requires completed migration history and the exact latest migration, and pins historical differences", () => {
    const expected = { "01_initial": "a".repeat(64), "02_current": "b".repeat(64) };
    const rows = Object.entries(expected).map(([name, checksum]) => ({ name, checksum, finished: true }));
    expect(() => assertOpenRagCurrentSchema(expected, rows)).not.toThrow();
    for (const applied of [rows.slice(0, 1), [...rows, rows[0]!],
      [rows[0]!, { ...rows[1]!, finished: false }], [rows[0]!, { ...rows[1]!, checksum: "c".repeat(64) }],
      [rows[0]!, { ...rows[1]!, name: "unknown" }]]) {
      expect(() => assertOpenRagCurrentSchema(expected, applied)).toThrow("schema_mismatch");
    }
    const original = assertOpenRagCurrentSchema(expected, rows);
    const historical = assertOpenRagCurrentSchema(expected, [{ ...rows[0]!, checksum: "c".repeat(64) }, rows[1]!]);
    expect(original.historicalChecksumDifferences).toBe(0);
    expect(historical.historicalChecksumDifferences).toBe(1);
    expect(historical.sourceFingerprint).toBe(original.sourceFingerprint);
    expect(historical.appliedFingerprint).not.toBe(original.appliedFingerprint);
    expect(assertOpenRagCurrentSchema(expected, [...rows].reverse())).toEqual(original);
  });

  it("requires explicit paid, corpus comparison, bounded batches, and an unambiguous selection", () => {
    expect(parseOpenRagCurrentCli([...paid, "--case-id", "doc-002-q1", "--case-id", "doc-001-q1", "--resume", "--batch-size", "5"]))
      .toMatchObject({ caseIds: ["doc-001-q1", "doc-002-q1"], batchSize: 5, full: false, resume: true });
    expect(parseOpenRagCurrentCli([...paid, "--full", "--preflight-only"]))
      .toMatchObject({ full: true, batchSize: 1, preflightOnly: true });
    for (const args of [[], [...paid], [...paid, "--full", "--case-id", "doc-001-q1"],
      [...paid, "--full", "--batch-size", "6"], [...paid, "--full", "--full"],
      [...paid, "--case-id", "doc-001-q1", "--case-id", "doc-001-q1"]]) {
      expect(() => parseOpenRagCurrentCli(args)).toThrow();
    }
  });

  it("judges only citations actually delivered, with publication coverage from its hashed receipt", () => {
    const input = currentOpenRagEvaluationInput(trace("partial"), question());
    expect(input).toMatchObject({ productCoverage: "partial", citationCount: 1,
      citedEvidence: [{ handle: "K1", locator: "Page 1", sourceLabel: "Neutral source" }] });
    expect(JSON.stringify(input.citedEvidence)).not.toContain("UNCITED_SOURCE");
    const missing = trace();
    missing.knowledgeDispatchManifests[0]!.providerAttempt.dispatchedAt = null;
    expect(() => currentOpenRagEvaluationInput(missing, question())).toThrow("cited_evidence_missing");
    expect(() => currentOpenRagEvaluationInput({ ...trace(), answer: "A changed answer. [K1]" }, question())).toThrow("receipt_invalid");
    const legacy = trace();
    (legacy.knowledgeRetrievalSession!.groundingResult!.evidence as Record<string, unknown>).version = 55;
    expect(() => currentOpenRagEvaluationInput(legacy, question())).toThrow("receipt_invalid");
    const retained = trace();
    const receipt = retained.knowledgeRetrievalSession!.groundingResult!.evidence as Record<string, unknown>;
    receipt.version = 58;
    expect(currentOpenRagEvaluationInput(retained, question()).productCoverage).toBe("complete");
    receipt.contracts = { pipeline: "unrelated_main_protocol" };
    expect(() => currentOpenRagEvaluationInput(retained, question())).toThrow("receipt_invalid");
  });

  it("preserves the historical cited-evidence budget, ordering and head/tail truncation", () => {
    const evidence = boundedOpenRagCitedEvidence("[K2] [K1] [K2]", [
      { handle: "K1", text: "small", locator: null, sourceLabel: null },
      { handle: "K2", text: `HEAD${"m".repeat(15_000)}TAIL`, locator: "Page 2", sourceLabel: "Source" }
    ]);
    expect(evidence.map(item => item.handle)).toEqual(["K2", "K1"]);
    expect(evidence[0]!.providerEvidence).toHaveLength(12_000);
    expect(evidence[0]!.providerEvidence).toMatch(/^HEAD.*\n\.\.\.\[middle omitted by benchmark judge budget\]\.\.\.\n.*TAIL$/u);
    expect(evidence[0]!.providerEvidenceTruncated).toBe(true);
    expect(evidence[1]!.providerEvidenceTruncated).toBe(false);
  });

  it("continues semantic nonpasses, isolates the reference, and resumes without executing settled cases", async () => {
    const checkpoint = store();
    const executeStage = vi.fn(async (_index: number, stage: "answer" | "judge", prompt: string) => {
      if (stage === "answer") {
        expect(prompt).not.toContain("EVALUATOR_ONLY");
        expect(prompt).not.toContain("doc-");
        return trace("partial");
      }
      expect(prompt).toContain("EVALUATOR_ONLY_REFERENCE");
      return { ...trace(), answer: JSON.stringify({ verdict: "pass", correctness: 4, grounded: true,
        reasonCode: "correct", explanation: "Synthetic judgment." }) };
    });
    const input = { cases: [question(1), question(2), question(3)], full: false,
      batchSize: 2, store: checkpoint, executeStage, emit: vi.fn() };
    expect(await runOpenRagCurrentCases(input)).toMatchObject({ complete: false, scoreable: false, total: 2, partial: 2, pass: 0 });
    expect(executeStage).toHaveBeenCalledTimes(4);
    expect(await runOpenRagCurrentCases(input)).toMatchObject({ complete: true, scoreable: false, total: 3, partial: 3 });
    expect(executeStage).toHaveBeenCalledTimes(6);
    await runOpenRagCurrentCases(input);
    expect(executeStage).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(input.emit.mock.calls)).not.toContain("EVALUATOR_ONLY_REFERENCE");
  });

  it("retains technical failures and forbids a full score until all selected questions settle", async () => {
    const checkpoint = store();
    const executeStage = vi.fn(async () => ({ ...trace(), status: "error" as const, answer: "", error: "knowledge_retrieval_failed" }));
    const input = { cases: Array.from({ length: 100 }, (_, i) => question(i + 1)), full: true,
      batchSize: 5, store: checkpoint, executeStage, emit: vi.fn() };
    expect(await runOpenRagCurrentCases(input)).toMatchObject({ complete: false, scoreable: false, total: 5,
      terminalAnswerFailures: 5, technicalFailureCases: 5 });
    expect(executeStage).toHaveBeenCalledTimes(5);
    await expect(runOpenRagCurrentCases({ ...input, cases: [question()] })).rejects.toThrow("cases_invalid");
  });
});
