import { describe, expect, it, vi } from "vitest";
import type { ProviderExecutionSnapshot } from
  "../../lib/server/providers/runtimeFactory";
import {
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION
} from "../../lib/server/knowledge/answerGroundingV5";
import { packKnowledgeEvidenceDispatchManifest } from
  "../../lib/server/knowledge/evidenceDispatchManifest";
import {
  decodeOpenRagAnswerEnginePin,
  type OpenRagAnswerCase
} from "./openRagAnswerContract";
import {
  createOpenRagAnswerReplaySnapshot,
  decodeOpenRagAnswerReplaySnapshot,
  getOpenRagAnswerReplayFailureTrace,
  getOpenRagAnswerReplaySnapshotDiagnostic,
  isOpenRagAnswerOperationSequence,
  openRagAnswerReplayMatchesReasoningControl,
  replayOpenRagAnswerSnapshot
} from "./openRagAnswerReplay";

const benchmarkCase: OpenRagAnswerCase = Object.freeze({
  caseId: "doc-001-q1",
  documentAlias: "doc-001",
  evaluationMode: "open_rag_reference_answer",
  goldSectionId: 1,
  kind: "fact",
  question: "How long are completed exports retained?",
  referenceAnswer: "Completed exports are retained for 30 days.",
  source: "text",
  type: "extractive"
});

function snapshot(): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 300_000
    },
    connectionDisplayName: "Connection",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind: "openai_responses_compatible",
      answerSelectable: true,
      capabilities: {
        defaultReasoningEffort: "low",
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
        streaming: true,
        vision: false
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId: "gpt-5.6-luna"
    },
    modelDisplayName: "Luna",
    providerFamily: "openai_compatible",
    providerModelId: "deployment-1",
    version: 1
  };
}

function evidence() {
  return packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "knowledge-call-1:result:1",
      exactExcerpt: "Atlas retains completed exports for 30 days.",
      fileName: "2401.03305v2.pdf",
      handle: "K1",
      locator: "page=1; heading=Retention",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Retention",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>",
    header: '<private_knowledge_evidence version="4">',
    maximumBytes: 32_000,
    maximumTokens: 8_000,
    profileId: "connection:model",
    promptFragmentVersion: 1,
    runtimeVersion: 1
  });
}

function evidenceBindings() {
  return Object.freeze([Object.freeze({
    dispatchEvidenceId: "knowledge-call-1:result:1",
    evidenceItemId: "evidence-item-1",
    handle: "K1",
    sourceArtifactId: "source-artifact-1",
    sourceId: "source-1",
    sourceVersionId: "source-version-1"
  })]);
}

function origin() {
  return Object.freeze({
    baseFingerprint: "a".repeat(64),
    engine: Object.freeze({
      chunkingProfileVersion: 11,
      coverageAuditorContractVersion: null,
      draftContractVersion: 20,
      evidencePackingVersion: "whole_source_item_v1",
      groundingEvidenceVersion: 16,
      parserProfileVersion: 13,
      pipelineVersion: "knowledge_answer_v20_v16_v5",
      profileRevisionId: "profile-1",
      profileRevisionNumber: 34,
      rankingProfileVersion: 4,
      reranker: {
        adapterKind: "openai_compatible",
        connectionId: "reranker-connection-1",
        executionSnapshotHash: "c".repeat(64),
        providerModelId: "reranker-deployment-1",
        upstreamModelId: "reranker-1"
      },
      selectorContractVersion: 16,
      settlementVersion: 5
    }),
    sourceBindingFingerprint: "b".repeat(64)
  });
}

function currentOrigin() {
  const legacy = origin();
  return Object.freeze({
    ...legacy,
    engine: Object.freeze({
      ...legacy.engine,
      coverageAuditorContractVersion: 6,
      draftContractVersion: 21,
      groundingEvidenceVersion: 54,
      pipelineVersion: currentPipelineVersion,
      selectorContractVersion: 21,
      settlementVersion: 6
    })
  });
}

const currentPipelineVersion =
  "knowledge_answer_draft_v21_scope_v6_completeness_v1_selector_v21_targeted_delta_v4_repair_budget_v1_claim_surface_v1_target_groups_v1_claim_markup_boundaries_v1_selector_support_edges_v1_collective_target_support_v1_scope_repair_feedback_v1_target_closure_v1_verified_scope_patch_v1_scope_closure_v1_repair_reserved_correction_v2_source_ordered_context_v1_least_authority_delta_v1_fail_closed_local_provenance_v1_final_delta_repair_v1_supplement_atomization_v1_scope_multi_diagnostic_repair_v1_selector_repair_diagnostic_v1_fail_closed_selector_edges_v2_adaptive_atomic_supplement_budget_v1_query_intent_completeness_v1_query_granularity_epistemic_fidelity_v1_answer_level_compression_v1_request_anchor_ids_v1_scope_set_reduction_v1_scope_recall_map_v1_invalid_provenance_rejection_v2_unsupported_supersession_v1_supplement_exact_duplicate_reduction_v1_draft_coequal_facet_atomization_v1_target_accumulative_reduce_v1_global_scope_closure_v1_non_missing_closure_admission_v1_target_local_supplement_v1_settlement_v6";

const currentExecutionPolicy = Object.freeze({
  auditorReasoningEffort: "medium",
  draftReasoningEffort: "medium",
  egressDestination: "answer_provider",
  overriddenRoles: Object.freeze([]),
  providerBindingKey: "answer",
  selectorReasoningEffort: "medium",
  supplementReasoningEffort: "medium",
  version: 1
} as const);

describe("OpenRAG frozen-evidence replay", () => {
  it("admits bounded append-only pipeline identities beyond generic IDs", () => {
    expect(currentPipelineVersion.length).toBeGreaterThan(512);
    expect(decodeOpenRagAnswerEnginePin(currentOrigin().engine).pipelineVersion)
      .toBe(currentPipelineVersion);
    expect(() => decodeOpenRagAnswerEnginePin({
      ...currentOrigin().engine,
      pipelineVersion: `p${"x".repeat(1024)}`
    })).toThrow("open_rag_answer_engine_pin_invalid");
  });

  it("runs only the V20 answer stages over the immutable dispatch", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: null,
      forbiddenIdentityFragments: ["run-private", "knowledge-call-1:result:1"],
      origin: origin(),
      originalRunId: "run-original",
      reasoningEffort: "low",
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    const executeStructuredOutput = vi.fn(async (_snapshot, request, options) => {
      options.onProviderResponseId?.(`provider-${request.name}`);
      options.onUsage?.({
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15
      });
      if (request.name === "knowledge_coverage_planner_v20") {
        return {
          dimensions: [{
            description: "The requested retention period.",
            id: "D1"
          }],
          version: 1
        };
      }
      if (request.name === "knowledge_answer_draft_v20") {
        return {
          claims: [{
            citationHints: ["K1"],
            text: "Atlas retains completed exports for 30 days."
          }],
          version: 1
        };
      }
      return {
        claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
        coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
        extractIds: [],
        insufficientReason: "not_applicable",
        version: 1
      };
    });

    const result = await replayOpenRagAnswerSnapshot({
      executeStructuredOutput,
      snapshot: frozen
    });

    expect(executeStructuredOutput).toHaveBeenCalledTimes(3);
    expect(executeStructuredOutput.mock.calls.map(([, request]) => request.name)).toEqual([
      "knowledge_coverage_planner_v20",
      "knowledge_answer_draft_v20",
      "knowledge_grounded_selector_v16"
    ]);
    expect(result).toMatchObject({
      contracts: { draftContractVersion: 20, selectorContractVersion: 16 },
      coverage: "complete",
      operationCount: 3
    });
    expect(result.finalText).toContain("30 days");
    expect(result.citedEvidence.map(({ handle }) => handle)).toEqual(["K1"]);
  });

  it("settles a validation-repair selector as the final operation", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: null,
      forbiddenIdentityFragments: [],
      origin: origin(),
      originalRunId: "run-original",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    let selectorOrdinal = 0;
    const result = await replayOpenRagAnswerSnapshot({
      executeStructuredOutput: async (_execution, request) => {
        if (request.name === "knowledge_coverage_planner_v20") {
          return { dimensions: [{ description: "Retention period.", id: "D1" }], version: 1 };
        }
        if (request.name === "knowledge_answer_draft_v20") {
          return {
            claims: [{
              citationHints: ["K1"],
              text: "Atlas retains completed exports for 30 days."
            }],
            version: 1
          };
        }
        selectorOrdinal += 1;
        if (selectorOrdinal === 1) return {};
        return {
          claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
          coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
          extractIds: [],
          insufficientReason: "not_applicable",
          version: 1
        };
      },
      snapshot: frozen
    });

    expect(result.operationCount).toBe(4);
    expect(result.coverage).toBe("complete");
    expect(result.finalText).toContain("30 days");
  });

  it("runs the current V38 snapshot with V21 Draft and Selector", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: currentExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: currentOrigin(),
      originalRunId: "run-original-v24",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    const executeStructuredOutput = vi.fn(async (_execution, request) => {
      if (request.name === "knowledge_answer_draft_v21") {
        return {
          claims: [{
            citationHints: ["K1"],
            text: "Atlas retains completed exports for 30 days."
          }],
          version: 1
        };
      }
      if (request.name === "knowledge_coverage_scope_v6") {
        return {
          evidenceUnits: [{
            findings: [{
              description: "State the completed-export retention period.",
              evidenceAtomIds: ["A1"],
              requestAnchor: "How long are completed exports retained?"
            }],
            handle: "K1"
          }],
          jointFindings: [],
          unsupportedDimensions: [],
          version: 6
        };
      }
      if (request.name === "knowledge_coverage_scope_completeness_v1") {
        return { additions: [], version: 1 };
      }
      if (request.name === "knowledge_coverage_scope_closure_v2") {
        return { decisions: [{ id: "D1", status: "closed" }], version: 2 };
      }
      return {
        claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
        coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
        extractIds: [],
        insufficientReason: "not_applicable",
        version: 1
      };
    });

    const result = await replayOpenRagAnswerSnapshot({
      executeStructuredOutput,
      snapshot: frozen
    });

    expect(executeStructuredOutput.mock.calls.map(([, request]) => request.name)).toEqual([
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_completeness_v1",
      "knowledge_grounded_selector_v21",
      "knowledge_coverage_scope_closure_v2"
    ]);
    expect(result).toMatchObject({
      contracts: {
        coverageAuditorContractVersion: 6,
        draftContractVersion: 21,
        selectorContractVersion: 21,
        settlementVersion: 6
      },
      coverage: "complete",
      operationCount: 5
    });
    expect(result.rawProviderOutputs.map(({ operation, ordinal }) => ({
      operation,
      ordinal
    }))).toEqual([
      { operation: "knowledge_answer_draft_v21", ordinal: 1 },
      { operation: "knowledge_coverage_scope_v6", ordinal: 2 },
      { operation: "knowledge_coverage_scope_completeness_v1", ordinal: 3 },
      { operation: "knowledge_grounded_selector_v21", ordinal: 4 },
      { operation: "knowledge_coverage_scope_closure_v2", ordinal: 5 }
    ]);
    expect(result.rawProviderOutputs[0]?.output).toMatchObject({
      claims: [{ text: "Atlas retains completed exports for 30 days." }]
    });
    expect(result.finalText).toContain("30 days");
    expect(openRagAnswerReplayMatchesReasoningControl(frozen, "medium")).toBe(true);
    expect(openRagAnswerReplayMatchesReasoningControl(frozen, "low")).toBe(false);
  });

  it("retains a validator-rejected raw Supplement only in replay output", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: currentExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: currentOrigin(),
      originalRunId: "run-original-v38-raw-supplement",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    const rawSupplement = Object.freeze({
      targets: Object.freeze({
        D2: Object.freeze([
          "A bounded candidate survives.",
          "A bounded candidate survives."
        ])
      }),
      version: 2 as const
    });
    const executeStructuredOutput = vi.fn(async (_execution, request) => {
      if (request.name === "knowledge_answer_draft_v21") {
        return {
          claims: [{
            citationHints: ["K1"],
            text: "Atlas retains completed exports for 30 days."
          }],
          version: 1
        };
      }
      if (request.name === "knowledge_coverage_scope_v6") {
        return {
          evidenceUnits: [{
            findings: [{
              description: "State the completed-export retention period.",
              evidenceAtomIds: ["A1"],
              requestAnchor: "How long are completed exports retained?"
            }, {
              description: "State the retention boundary separately.",
              evidenceAtomIds: ["A1"],
              requestAnchor: "completed exports retained"
            }],
            handle: "K1"
          }],
          jointFindings: [],
          unsupportedDimensions: [],
          version: 6
        };
      }
      if (request.name === "knowledge_coverage_scope_completeness_v1") {
        return { additions: [], version: 1 };
      }
      if (request.name === "knowledge_grounded_selector_v21") {
        return {
          claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
          coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }, {
            id: "D2", status: "missing", supportIds: []
          }],
          extractIds: [],
          insufficientReason: "not_applicable",
          version: 1
        };
      }
      if (request.name === "knowledge_coverage_scope_closure_v2") {
        return {
          decisions: [{ id: "D1", status: "closed" }, {
            id: "D2", status: "missing"
          }],
          version: 2
        };
      }
      if (request.name === "knowledge_answer_draft_supplement_v21") {
        return rawSupplement;
      }
      throw new Error("unexpected_replay_operation");
    });

    const result = await replayOpenRagAnswerSnapshot({
      executeStructuredOutput,
      snapshot: frozen
    });

    expect(result).toMatchObject({ coverage: "partial", operationCount: 6 });
    expect(result.acceptedResults.at(-1)).toEqual({
      operation: "knowledge_answer_draft_supplement_v21",
      output: { kind: "draft_malformed", reason: "draft_duplicate_claim" }
    });
    expect(result.rawProviderOutputs.at(-1)).toEqual({
      operation: "knowledge_answer_draft_supplement_v21",
      ordinal: 6,
      output: rawSupplement,
      providerResponseId: null
    });
  });

  it("re-asks one structurally invalid blind Scope with unchanged evidence", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: currentExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: currentOrigin(),
      originalRunId: "run-original-v24-audit-repair",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    let scopeCalls = 0;
    const executeStructuredOutput = vi.fn(async (_execution, request) => {
      if (request.name === "knowledge_answer_draft_v21") {
        return {
          claims: [{
            citationHints: ["K1"],
            text: "Atlas retains completed exports for 30 days."
          }],
          version: 1
        };
      }
      if (request.name === "knowledge_coverage_scope_v6") {
        if (scopeCalls++ === 0) return {};
        return {
          evidenceUnits: [{
            findings: [{
              description: "State the completed-export retention period.",
              evidenceAtomIds: ["A1"],
              requestAnchor: "How long are completed exports retained?"
            }],
            handle: "K1"
          }],
          jointFindings: [],
          unsupportedDimensions: [],
          version: 6
        };
      }
      if (request.name === "knowledge_coverage_scope_completeness_v1") {
        return { additions: [], version: 1 };
      }
      if (request.name === "knowledge_coverage_scope_closure_v2") {
        return { decisions: [{ id: "D1", status: "closed" }], version: 2 };
      }
      return {
        claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
        coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
        extractIds: [],
        insufficientReason: "not_applicable",
        version: 1
      };
    });

    const result = await replayOpenRagAnswerSnapshot({
      executeStructuredOutput,
      snapshot: frozen
    });

    expect(result.operationCount).toBe(6);
    const scopeRequests = executeStructuredOutput.mock.calls
      .map(([, request]) => request)
      .filter(({ name }) => name === "knowledge_coverage_scope_v6");
    expect(scopeRequests).toHaveLength(2);
    expect(JSON.parse(scopeRequests[0]!.userPrompt)).toMatchObject({
      repairReason: null,
      scopePass: "initial"
    });
    expect(JSON.parse(scopeRequests[1]!.userPrompt)).toMatchObject({
      repairReason: "coverage_scope_shape_invalid",
      scopePass: "repair"
    });
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_completeness_v1",
      "knowledge_grounded_selector_v21",
      "knowledge_coverage_scope_closure_v2",
      "knowledge_answer_draft_supplement_v21"
    ])).toBe(true);
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_completeness_v1",
      "knowledge_grounded_selector_v21",
      "knowledge_coverage_scope_closure_v2",
      "knowledge_answer_draft_supplement_v21",
      "knowledge_grounded_selector_final_v21"
    ])).toBe(true);
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_completeness_v1",
      "knowledge_grounded_selector_v21",
      "knowledge_coverage_scope_closure_v2",
      "knowledge_answer_draft_supplement_v21",
      "knowledge_grounded_selector_final_v21",
      "knowledge_grounded_selector_final_v21"
    ])).toBe(true);
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_grounded_selector_v21",
      "knowledge_coverage_scope_v6"
    ])).toBe(false);
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_completeness_v1",
      "knowledge_grounded_selector_v21",
      "knowledge_coverage_scope_closure_v2"
    ])).toBe(true);
  });

  it("reports the bounded Scope reason and retains its raw failure trace privately", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: currentExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: currentOrigin(),
      originalRunId: "run-original-v24-audit-failure",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    let failure: unknown;
    try {
      await replayOpenRagAnswerSnapshot({
        executeStructuredOutput: async (_execution, request) => {
          if (request.name === "knowledge_answer_draft_v21") {
            return {
              claims: [{ citationHints: ["K1"], text: "Retained for 30 days." }],
              version: 1
            };
          }
          return {};
        },
        snapshot: frozen
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "open_rag_replay_coverage_scope_shape_invalid"
    );
    expect(JSON.stringify(failure)).not.toContain("Retained for 30 days");
    const trace = getOpenRagAnswerReplayFailureTrace(failure);
    expect(trace?.acceptedResults.map(({ operation }) => operation)).toEqual([
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v6",
      "knowledge_coverage_scope_v6"
    ]);
    expect(trace?.rawProviderOutputs.map(({ operation, output }) => ({
      operation,
      output
    }))).toEqual([
      {
        operation: "knowledge_answer_draft_v21",
        output: {
          claims: [{ citationHints: ["K1"], text: "Retained for 30 days." }],
          version: 1
        }
      },
      { operation: "knowledge_coverage_scope_v6", output: {} },
      { operation: "knowledge_coverage_scope_v6", output: {} }
    ]);
    expect(trace?.replaySnapshot).toEqual(frozen);
    expect(trace?.stageRecords).toHaveLength(3);
  });

  it("allows a supported stage override while attesting inherited roles", () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: Object.freeze({
        ...currentExecutionPolicy,
        overriddenRoles: Object.freeze(["selector"] as const),
        selectorReasoningEffort: "high"
      }),
      forbiddenIdentityFragments: [],
      origin: currentOrigin(),
      originalRunId: "run-original-v24-override",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });

    expect(openRagAnswerReplayMatchesReasoningControl(frozen, "medium")).toBe(true);
    expect(openRagAnswerReplayMatchesReasoningControl(frozen, "high")).toBe(false);
    expect(openRagAnswerReplayMatchesReasoningControl(Object.freeze({
      ...frozen,
      executionPolicy: Object.freeze({
        ...frozen.executionPolicy!,
        selectorReasoningEffort: "ultra"
      })
    }), "medium")).toBe(false);
  });

  it("freezes a current V36 run that inherits the provider reasoning default", () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-09-01T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: Object.freeze({
        ...currentExecutionPolicy,
        auditorReasoningEffort: null,
        draftReasoningEffort: null,
        selectorReasoningEffort: null,
        supplementReasoningEffort: null
      }),
      forbiddenIdentityFragments: [],
      origin: currentOrigin(),
      originalRunId: "run-original-v24-provider-default",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });

    expect(frozen.executionPolicy).toMatchObject({
      auditorReasoningEffort: null,
      draftReasoningEffort: null,
      selectorReasoningEffort: null,
      supplementReasoningEffort: null
    });
    expect(openRagAnswerReplayMatchesReasoningControl(frozen, null)).toBe(true);
    let routeError: unknown;
    try {
      decodeOpenRagAnswerReplaySnapshot({
        ...frozen,
        routeInstruction: "unattested route"
      });
    } catch (error) {
      routeError = error;
    }
    expect(routeError).toBeInstanceOf(Error);
    expect((routeError as Error).message)
      .toBe("open_rag_answer_replay_snapshot_invalid");
    expect(getOpenRagAnswerReplaySnapshotDiagnostic(routeError))
      .toBe("envelope_route_invalid");
    expect(JSON.stringify(routeError)).not.toContain("envelope_route_invalid");
  });

  it("rejects any snapshot identity or evidence mutation", () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: null,
      forbiddenIdentityFragments: [],
      origin: origin(),
      originalRunId: "run-original",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    expect(decodeOpenRagAnswerReplaySnapshot(frozen)).toEqual(frozen);
    expect(() => decodeOpenRagAnswerReplaySnapshot({
      ...frozen,
      request: "Mutated request"
    })).toThrow("open_rag_answer_replay_snapshot_invalid");
  });
});
