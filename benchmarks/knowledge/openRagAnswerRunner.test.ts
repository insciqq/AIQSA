import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenRagAnswerCheckpointHeader,
  OpenRagAnswerOutcome
} from "./openRagAnswerCheckpoint";
import {
  decodeOpenRagAnswerCheckpointHeader,
  decodeOpenRagAnswerOutcome
} from "./openRagAnswerCheckpoint";
import type {
  OpenRagAnswerCase,
  OpenRagAnswerRunManifest
} from "./openRagAnswerContract";
import {
  decodeOpenRagAnswerQuestionBundle,
  decodeOpenRagAnswerRunManifest,
  OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION,
  OPEN_RAG_ANSWER_SELECTION_FINGERPRINT,
  openRagAnswerManifestFingerprint
} from "./openRagAnswerContract";
import {
  applyOpenRagCitationCeiling,
  applyOpenRagCoverageCeiling,
  classifyOpenRagFailure,
  decodeOpenRagJudgmentText
} from "./openRagAnswerEvaluate";
import type { OpenRagAnswerReplaySnapshot } from "./openRagAnswerReplay";
import type {
  OpenRagAnswerCheckpointStore,
  OpenRagAnswerRuntime
} from "./openRagAnswerRunner";
import {
  assertOpenRagPrivatePath,
  assertOpenRagPrivatePathNoSymlinks,
  createOpenRagAnswerCheckpointHeader,
  OpenRagAnswerNonPassError,
  parseOpenRagAnswerCli,
  runOpenRagAnswerBenchmark
} from "./openRagAnswerRunner";

const sha = "a".repeat(64);

function benchmarkCase(ordinal = 1): OpenRagAnswerCase {
  const alias = `doc-${String(ordinal).padStart(3, "0")}`;
  return Object.freeze({
    caseId: `${alias}-q1`,
    documentAlias: alias,
    evaluationMode: "open_rag_reference_answer",
    goldSectionId: 4,
    kind: "fact",
    question: `What is retained for case ${ordinal}?`,
    referenceAnswer: `The retained value is ${ordinal}.`,
    source: "text",
    type: "extractive"
  });
}

function manifest(
  cases: readonly OpenRagAnswerCase[],
  overrides: Partial<OpenRagAnswerRunManifest> = {}
): OpenRagAnswerRunManifest {
  return decodeOpenRagAnswerRunManifest({
    answerControlsFingerprint: "8".repeat(64),
    answerModel: {
      adapterKind: "openai_responses_compatible",
      connectionId: "connection-1",
      executionSnapshotHash: "b".repeat(64),
      providerModelId: "model/luna",
      upstreamModelId: "gpt-5.6-luna"
    },
    baseFingerprint: "c".repeat(64),
    caseIds: cases.map(({ caseId }) => caseId),
    datasetId: "vectara/open_ragbench",
    engine: {
      chunkingProfileVersion: 11,
      coverageAuditorContractVersion: null,
      draftContractVersion: 20,
      evidencePackingVersion: "whole_source_item_rank_interleave_v2",
      groundingEvidenceVersion: 16,
      parserProfileVersion: 13,
      pipelineVersion: "knowledge_answer_v20_v16_v5",
      profileRevisionId: "profile-1",
      profileRevisionNumber: 34,
      rankingProfileVersion: 4,
      reranker: {
        adapterKind: "openai_compatible",
        connectionId: "reranker-connection-1",
        executionSnapshotHash: "9".repeat(64),
        providerModelId: "reranker-deployment-1",
        upstreamModelId: "qwen/qwen3-reranker-8b"
      },
      selectorContractVersion: 16,
      settlementVersion: 5
    },
    judgeContractVersion: 1,
    judgeControlsFingerprint: "7".repeat(64),
    judgeModel: {
      adapterKind: "openai_responses_compatible",
      connectionId: "connection-1",
      executionSnapshotHash: "d".repeat(64),
      providerModelId: "model/sol",
      upstreamModelId: "gpt-5.6-sol"
    },
    judgeRepeat: 1,
    mode: "focused",
    noJudge: false,
    repeat: 1,
    revision: "63f6b052ff83508b08e242db42263ee708815c26",
    runnerContractVersion: OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION,
    schedule: { caseStartIntervalMs: 0, concurrency: 1 },
    schemaVersion: 1,
    scoreable: false,
    selectionFingerprint: OPEN_RAG_ANSWER_SELECTION_FINGERPRINT,
    sourceBindingFingerprint: "e".repeat(64),
    ...overrides
  });
}

function replaySnapshot(caseValue: OpenRagAnswerCase): OpenRagAnswerReplaySnapshot {
  return {
    case: caseValue,
    contracts: {
      coverageAuditorContractVersion: null,
      draftContractVersion: 20,
      selectorContractVersion: 16,
      settlementVersion: 5
    },
    snapshotHash: sha
  } as OpenRagAnswerReplaySnapshot;
}

function runtime(verdict: "fail" | "partial" | "pass" = "pass") {
  const executeAnswer = vi.fn<OpenRagAnswerRuntime["executeAnswer"]>(
    async ({ case: caseValue }) => ({
      acceptedResults: [
        "knowledge_coverage_planner_v20",
        "knowledge_answer_draft_v20",
        "knowledge_grounded_selector_v16"
      ].map((operation) => ({ operation, output: {} })),
      answerRunId: `answer-${caseValue.caseId}`,
      answerText: `The retained value is supported. [K1]`,
      citedEvidence: [{
        handle: "K1",
        locator: "page=1",
        providerEvidence: "The retained value is supported.",
        providerEvidenceTruncated: false,
        sourceLabel: "Source"
      }],
      coverage: verdict === "pass" ? "complete" : "partial",
      facts: {
        auditMissingCount: null,
        draftHadReferenceAxis: verdict === "pass",
        evidenceHadGoldSource: true,
        evidenceHadRelevantContent: true,
        goldCandidateAfterRerank: true,
        goldCandidateBeforeRerank: true,
        parserArtifactReady: true,
        selectorRejectedReferenceAxis: false
      },
      operationCount: 3,
      replaySnapshot: replaySnapshot(caseValue),
      stageRecords: [
        "knowledge_coverage_planner_v20",
        "knowledge_answer_draft_v20",
        "knowledge_grounded_selector_v16"
      ].map((stage, index) => ({
        durationMs: 4,
        providerResponseId: `response-${index + 1}`,
        requestHash: String(index + 1).repeat(64),
        resultHash: String(index + 4).repeat(64),
        stage,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          totalTokens: 15
        }
      }))
    })
  );
  const executeJudge = vi.fn<OpenRagAnswerRuntime["executeJudge"]>(async () => ({
    durationMs: 3,
    providerResponseId: "judge-response-1",
    rawResult: JSON.stringify({
      correctness: verdict === "pass" ? 4 : verdict === "partial" ? 3 : 0,
      explanation: "Evaluator result.",
      grounded: verdict !== "fail",
      reasonCode: verdict === "pass" ? "correct" :
        verdict === "partial" ? "minor_omission" : "wrong_value",
      verdict
    }),
    runId: "judge-run-1",
    usage: {
      inputTokens: 8,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 12
    }
  }));
  return {
    executeAnswer,
    executeJudge,
    executeReplay: vi.fn<OpenRagAnswerRuntime["executeReplay"]>(async ({ snapshot }) =>
      executeAnswer({
        case: snapshot.case,
        goldDocumentId: "document-1",
        repeatOrdinal: 1
      }))
  } satisfies OpenRagAnswerRuntime;
}

function memoryCheckpoint(existing: readonly OpenRagAnswerOutcome[] = []) {
  const outcomes = new Map(existing.map((outcome) => [
    `${outcome.caseId}:${outcome.repeatOrdinal}`,
    outcome
  ]));
  const summaries: Readonly<Record<string, unknown>>[] = [];
  const failures: Readonly<Record<string, unknown>>[] = [];
  const privateRecords: Readonly<Record<string, unknown>>[] = [];
  const initialize = vi.fn(async ({ header }: {
    header: OpenRagAnswerCheckpointHeader;
    resume: boolean;
  }) => header);
  const store: OpenRagAnswerCheckpointStore = {
    initialize,
    async loadOutcome(expected) {
      return outcomes.get(`${expected.caseId}:${expected.repeatOrdinal}`) ?? null;
    },
    async writeFailure(failure) {
      failures.push(failure);
    },
    async writeOutcome({ outcome, privateRecord }) {
      outcomes.set(`${outcome.caseId}:${outcome.repeatOrdinal}`, outcome);
      privateRecords.push(privateRecord);
    },
    async writeSummary(summary) {
      summaries.push(summary);
    }
  };
  return { failures, initialize, outcomes, privateRecords, store, summaries };
}

describe("OpenRAG answer runner contracts", () => {
  it("parses required modes and rejects unsafe combinations", () => {
    expect(parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--case-id", "doc-027-q2", "--repeat", "10"
    ])).toMatchObject({ mode: "focused", preflightOnly: false, repeat: 10, resume: false });
    expect(parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--case-id", "doc-027-q2", "--preflight-only"
    ])).toMatchObject({ mode: "focused", preflightOnly: true });
    expect(parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--full", "--resume", "--output",
      ".aiqsa/openrag/run-1"
    ])).toMatchObject({ mode: "full", resume: true });
    expect(() => parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--full", "--case-id", "doc-027-q2"
    ])).toThrow("open_rag_answer_selection_invalid");
    expect(() => parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--case-id", "doc-027-q2", "--resume",
      "--output", ".aiqsa/openrag/run-1"
    ])).toThrow("open_rag_answer_resume_mode_invalid");
    expect(() => parseOpenRagAnswerCli([
      "--case-id", "doc-027-q2"
    ])).toThrow("open_rag_answer_paid_confirmation_required");
    expect(() => parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--case-id", "doc-027-q2", "--repeat", "1e1"
    ])).toThrow("open_rag_answer_integer_argument_invalid");
    expect(() => parseOpenRagAnswerCli([
      "--confirm-paid", "OPENRAG", "--full", "--full"
    ])).toThrow("open_rag_answer_argument_duplicate");
  });

  it("confines private inputs and outputs to ignored benchmark roots", () => {
    expect(assertOpenRagPrivatePath("/repo", ".aiqsa/openrag/run-1"))
      .toBe("/repo/.aiqsa/openrag/run-1");
    expect(assertOpenRagPrivatePath("/repo", "benchmarks/knowledge/results/run-1"))
      .toBe("/repo/benchmarks/knowledge/results/run-1");
    expect(() => assertOpenRagPrivatePath("/repo", "benchmarks/knowledge/report.json"))
      .toThrow("open_rag_answer_private_path_required");
    expect(() => assertOpenRagPrivatePath("/repo", ".aiqsa"))
      .toThrow("open_rag_answer_private_path_required");
  });

  it("refuses a symlink escape inside an ignored private root", async () => {
    const root = await mkdtemp(join(tmpdir(), "openrag-path-test-"));
    try {
      await mkdir(join(root, ".aiqsa"));
      await symlink(join(root, "tracked"), join(root, ".aiqsa", "escape"));
      await expect(assertOpenRagPrivatePathNoSymlinks(
        root,
        ".aiqsa/escape/result.json"
      )).rejects.toThrow("open_rag_answer_private_path_symlink_forbidden");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("strictly decodes the frozen question bundle", () => {
    const decoded = decodeOpenRagAnswerQuestionBundle({
      documents: {
        "doc-001": {
          cases: [{
            caseId: "doc-001-q1",
            evaluationMode: "open_rag_reference_answer",
            goldSectionId: 4,
            kind: "fact",
            question: "What value is retained?",
            referenceAnswer: "The value is retained.",
            source: "text",
            support: "The value is retained.",
            type: "extractive"
          }],
          txtSha256: sha
        }
      },
      questionPackage: "open-rag-v1",
      version: 2
    });
    expect(decoded.cases[0]?.documentAlias).toBe("doc-001");
    expect(() => decodeOpenRagAnswerQuestionBundle({
      documents: {},
      questionPackage: "open-rag-v1",
      version: 2
    })).toThrow("open_rag_answer_question_bundle_invalid");
  });

  it("rejects checkpoint corruption and manifest substitution", () => {
    const cases = [benchmarkCase()];
    const runManifest = manifest(cases);
    const header = createOpenRagAnswerCheckpointHeader({
      createdAt: "2026-08-31T00:00:00.000Z",
      manifest: runManifest,
      runId: "run-1"
    });
    expect(decodeOpenRagAnswerCheckpointHeader(header)).toEqual(header);
    expect(() => decodeOpenRagAnswerCheckpointHeader({
      ...header,
      manifestFingerprint: "f".repeat(64)
    })).toThrow("open_rag_answer_checkpoint_header_invalid");
    expect(openRagAnswerManifestFingerprint(runManifest)).toBe(
      header.manifestFingerprint
    );
    expect(() => manifest(cases, {
      schedule: { caseStartIntervalMs: 0, concurrency: 2 }
    })).toThrow("open_rag_answer_manifest_invalid");
    expect(() => decodeOpenRagAnswerRunManifest({
      ...runManifest,
      judgeContractVersion: 2
    })).toThrow("open_rag_answer_manifest_invalid");
  });

  it("applies deterministic coverage and failure rules", () => {
    const parsed = decodeOpenRagJudgmentText(
      `\n\`\`\`json\n${JSON.stringify({
        correctness: 4,
        explanation: "Correct.",
        grounded: true,
        reasonCode: "correct",
        verdict: "pass"
      })}\n\`\`\``
    );
    expect(applyOpenRagCoverageCeiling(parsed, "partial").verdict).toBe("partial");
    expect(applyOpenRagCitationCeiling(parsed, 0)).toMatchObject({
      grounded: false,
      reasonCode: "citation_issue",
      verdict: "fail"
    });
    expect(() => decodeOpenRagJudgmentText(JSON.stringify({
      ...parsed,
      verdict: "partial"
    }))).toThrow("open_rag_judge_contract_invalid");
    expect(classifyOpenRagFailure({
      answerCompleted: true,
      answerCoverage: "partial",
      answerStageFailure: null,
      auditMissingCount: null,
      draftHadReferenceAxis: false,
      evidenceHadGoldSource: true,
      evidenceHadRelevantContent: true,
      goldCandidateAfterRerank: true,
      goldCandidateBeforeRerank: true,
      judgment: { ...parsed, reasonCode: "minor_omission", verdict: "partial" },
      parserArtifactReady: true,
      selectorRejectedReferenceAxis: false
    })).toBe("draft_omission");
  });
});

describe("OpenRAG answer fail-fast schedule", () => {
  it("rejects product artifacts beyond the grounding operation bound", async () => {
    const cases = [benchmarkCase(1)];
    const runManifest = manifest(cases);
    const header = createOpenRagAnswerCheckpointHeader({ manifest: runManifest });
    const checkpoint = memoryCheckpoint();
    const fakeRuntime = runtime("pass");
    fakeRuntime.executeAnswer.mockImplementationOnce(async ({ case: caseValue }) => {
      const product = await runtime("pass").executeAnswer({
        case: caseValue,
        goldDocumentId: "document-1",
        repeatOrdinal: 1
      });
      const acceptedResults = Array.from({ length: 7 }, (_, index) => ({
        operation: `operation-${index + 1}`,
        output: {}
      }));
      return {
        ...product,
        acceptedResults,
        operationCount: acceptedResults.length,
        stageRecords: acceptedResults.map(({ operation }) => ({
          durationMs: 1,
          providerResponseId: null,
          requestHash: sha,
          resultHash: sha,
          stage: operation,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 2
          }
        }))
      };
    });

    await expect(runOpenRagAnswerBenchmark({
      cases,
      checkpoint: checkpoint.store,
      goldDocumentIds: { "doc-001": "document-1" },
      header,
      resume: false,
      runtime: fakeRuntime
    })).rejects.toThrow("open_rag_answer_product_artifact_invalid");
    expect(checkpoint.failures).toHaveLength(1);
    expect(checkpoint.outcomes.size).toBe(0);
  });

  it("accepts the six-operation V21 Scope repair and correction sequence", async () => {
    const cases = [benchmarkCase(1)];
    const legacyManifest = manifest(cases);
    const runManifest = manifest(cases, {
      engine: {
        ...legacyManifest.engine,
        coverageAuditorContractVersion: 6,
        draftContractVersion: 21,
        groundingEvidenceVersion: 22,
        pipelineVersion:
          "knowledge_answer_draft_v21_scope_v6_selector_v21_settlement_v6",
        selectorContractVersion: 21,
        settlementVersion: 6
      }
    });
    const header = createOpenRagAnswerCheckpointHeader({ manifest: runManifest });
    const checkpoint = memoryCheckpoint();
    const fakeRuntime = runtime("pass");
    fakeRuntime.executeAnswer.mockImplementationOnce(async ({ case: caseValue }) => {
      const product = await runtime("pass").executeAnswer({
        case: caseValue,
        goldDocumentId: "document-1",
        repeatOrdinal: 1
      });
      const sequence = [
        "knowledge_answer_draft_v21",
        "knowledge_coverage_scope_v6",
        "knowledge_coverage_scope_v6",
        "knowledge_grounded_selector_v21",
        "knowledge_answer_draft_supplement_v21",
        "knowledge_grounded_selector_final_v21"
      ];
      return {
        ...product,
        acceptedResults: sequence.map((operation) => ({ operation, output: {} })),
        operationCount: sequence.length,
        replaySnapshot: {
          ...product.replaySnapshot,
          contracts: {
            coverageAuditorContractVersion: 6,
            draftContractVersion: 21,
            selectorContractVersion: 21,
            settlementVersion: 6
          }
        },
        stageRecords: sequence.map((stage) => ({
          durationMs: 1,
          providerResponseId: null,
          requestHash: sha,
          resultHash: sha,
          stage,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 2
          }
        }))
      };
    });

    const summary = await runOpenRagAnswerBenchmark({
      cases,
      checkpoint: checkpoint.store,
      goldDocumentIds: { "doc-001": "document-1" },
      header,
      resume: false,
      runtime: fakeRuntime
    });

    expect(summary.pass).toBe(1);
    expect(checkpoint.outcomes.get("doc-001-q1:1")?.stageRecords).toHaveLength(6);
  });

  it("does not start a later case after the first non-pass", async () => {
    const cases = [benchmarkCase(1), benchmarkCase(2)];
    const runManifest = manifest(cases);
    const header = createOpenRagAnswerCheckpointHeader({ manifest: runManifest });
    const checkpoint = memoryCheckpoint();
    const fakeRuntime = runtime("partial");
    await expect(runOpenRagAnswerBenchmark({
      cases,
      checkpoint: checkpoint.store,
      goldDocumentIds: { "doc-001": "document-1", "doc-002": "document-2" },
      header,
      resume: false,
      runtime: fakeRuntime
    })).rejects.toBeInstanceOf(OpenRagAnswerNonPassError);
    expect(fakeRuntime.executeAnswer).toHaveBeenCalledOnce();
    expect(checkpoint.outcomes.size).toBe(1);
    expect(checkpoint.summaries).toHaveLength(0);
  });

  it("preserves the private answer replay when the judge fails", async () => {
    const cases = [benchmarkCase(1), benchmarkCase(2)];
    const runManifest = manifest(cases);
    const header = createOpenRagAnswerCheckpointHeader({ manifest: runManifest });
    const checkpoint = memoryCheckpoint();
    const fakeRuntime = runtime("pass");
    fakeRuntime.executeJudge.mockRejectedValueOnce(new Error("judge_unavailable"));

    await expect(runOpenRagAnswerBenchmark({
      cases,
      checkpoint: checkpoint.store,
      goldDocumentIds: { "doc-001": "document-1", "doc-002": "document-2" },
      header,
      resume: false,
      runtime: fakeRuntime
    })).rejects.toThrow("judge_unavailable");
    expect(fakeRuntime.executeAnswer).toHaveBeenCalledOnce();
    expect(checkpoint.failures).toHaveLength(1);
    expect(checkpoint.failures[0]).toMatchObject({
      caseId: "doc-001-q1",
      privateRecord: { replaySnapshot: { snapshotHash: sha } },
      stage: "judge"
    });
  });

  it("settles passes, writes one summary, and skips exact resumed outcomes", async () => {
    const cases = [benchmarkCase(1), benchmarkCase(2)];
    const runManifest = manifest(cases);
    const header = createOpenRagAnswerCheckpointHeader({ manifest: runManifest });
    const firstCheckpoint = memoryCheckpoint();
    const firstRuntime = runtime("pass");
    const summary = await runOpenRagAnswerBenchmark({
      cases,
      checkpoint: firstCheckpoint.store,
      goldDocumentIds: { "doc-001": "document-1", "doc-002": "document-2" },
      header,
      resume: false,
      runtime: firstRuntime
    });
    expect(summary).toMatchObject({ pass: 2, scoreable: false, total: 2 });
    expect(firstCheckpoint.summaries).toHaveLength(1);

    const stored = [...firstCheckpoint.outcomes.values()];
    const firstOutcome = stored[0]!;
    expect(() => decodeOpenRagAnswerOutcome({
      ...firstOutcome,
      operationCount: 4
    }, {
      caseId: firstOutcome.caseId,
      repeatOrdinal: firstOutcome.repeatOrdinal
    })).toThrow("open_rag_answer_checkpoint_outcome_invalid");
    const resumedCheckpoint = memoryCheckpoint(stored.slice(0, 1));
    const resumedRuntime = runtime("pass");
    await runOpenRagAnswerBenchmark({
      cases,
      checkpoint: resumedCheckpoint.store,
      goldDocumentIds: { "doc-001": "document-1", "doc-002": "document-2" },
      header,
      resume: true,
      runtime: resumedRuntime
    });
    expect(resumedRuntime.executeAnswer).toHaveBeenCalledOnce();
    expect(resumedCheckpoint.initialize).toHaveBeenCalledWith({ header, resume: true });
  });

  it("refuses to resume past a settled non-pass", async () => {
    const cases = [benchmarkCase(1), benchmarkCase(2)];
    const runManifest = manifest(cases);
    const header = createOpenRagAnswerCheckpointHeader({ manifest: runManifest });
    const failedRuntime = runtime("fail");
    const failedCheckpoint = memoryCheckpoint();
    await expect(runOpenRagAnswerBenchmark({
      cases,
      checkpoint: failedCheckpoint.store,
      goldDocumentIds: { "doc-001": "document-1", "doc-002": "document-2" },
      header,
      resume: false,
      runtime: failedRuntime
    })).rejects.toBeInstanceOf(OpenRagAnswerNonPassError);
    const resumedRuntime = runtime("pass");
    await expect(runOpenRagAnswerBenchmark({
      cases,
      checkpoint: memoryCheckpoint([...failedCheckpoint.outcomes.values()]).store,
      goldDocumentIds: { "doc-001": "document-1", "doc-002": "document-2" },
      header,
      resume: true,
      runtime: resumedRuntime
    })).rejects.toThrow("open_rag_answer_resume_contains_non_pass");
    expect(resumedRuntime.executeAnswer).not.toHaveBeenCalled();
  });
});
