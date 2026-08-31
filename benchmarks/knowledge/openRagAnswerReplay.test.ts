import { describe, expect, it, vi } from "vitest";
import type { ProviderExecutionSnapshot } from
  "../../lib/server/providers/runtimeFactory";
import {
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
} from "../../lib/server/knowledge/answerGroundingV5";
import { packKnowledgeEvidenceDispatchManifest } from
  "../../lib/server/knowledge/evidenceDispatchManifest";
import type { OpenRagAnswerCase } from "./openRagAnswerContract";
import {
  createOpenRagAnswerReplaySnapshot,
  decodeOpenRagAnswerReplaySnapshot,
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

function v21Origin() {
  const legacy = origin();
  return Object.freeze({
    ...legacy,
    engine: Object.freeze({
      ...legacy.engine,
      coverageAuditorContractVersion: 3,
      draftContractVersion: 21,
      groundingEvidenceVersion: 19,
      pipelineVersion:
        "knowledge_answer_draft_v21_scope_v3_selector_v18_settlement_v6",
      selectorContractVersion: 18,
      settlementVersion: 6
    })
  });
}

const v21ExecutionPolicy = Object.freeze({
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
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
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

  it("runs the current V21 Draft, blind Scope, Selector path over frozen evidence", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: v21ExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: v21Origin(),
      originalRunId: "run-original-v21",
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
      if (request.name === "knowledge_coverage_scope_v3") {
        return {
          scope: [{
            description: "State the completed-export retention period.",
            evidenceHandles: ["K1"],
            id: "D1",
            requestAnchor: "How long are completed exports retained?"
          }],
          version: 3
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

    expect(executeStructuredOutput.mock.calls.map(([, request]) => request.name)).toEqual([
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v3",
      "knowledge_grounded_selector_v18"
    ]);
    expect(result).toMatchObject({
      contracts: {
        coverageAuditorContractVersion: 3,
        draftContractVersion: 21,
        selectorContractVersion: 18,
        settlementVersion: 6
      },
      coverage: "complete",
      operationCount: 3
    });
    expect(result.finalText).toContain("30 days");
    expect(openRagAnswerReplayMatchesReasoningControl(frozen, "medium")).toBe(true);
    expect(openRagAnswerReplayMatchesReasoningControl(frozen, "low")).toBe(false);
  });

  it("re-asks one structurally invalid blind Scope with unchanged evidence", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: v21ExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: v21Origin(),
      originalRunId: "run-original-v21-audit-repair",
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
      if (request.name === "knowledge_coverage_scope_v3") {
        if (scopeCalls++ === 0) return {};
        return {
          scope: [{
            description: "State the completed-export retention period.",
            evidenceHandles: ["K1"],
            id: "D1",
            requestAnchor: "How long are completed exports retained?"
          }],
          version: 3
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

    expect(result.operationCount).toBe(4);
    const scopeRequests = executeStructuredOutput.mock.calls
      .map(([, request]) => request)
      .filter(({ name }) => name === "knowledge_coverage_scope_v3");
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
      "knowledge_coverage_scope_v3",
      "knowledge_coverage_scope_v3",
      "knowledge_grounded_selector_v18"
    ])).toBe(true);
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_grounded_selector_v18",
      "knowledge_coverage_scope_v3"
    ])).toBe(false);
    expect(isOpenRagAnswerOperationSequence(frozen.contracts, [
      "knowledge_answer_draft_v21",
      "knowledge_coverage_scope_v3",
      "knowledge_coverage_scope_v3",
      "knowledge_grounded_selector_v18",
      "knowledge_grounded_selector_v18",
      "knowledge_answer_draft_supplement_v21"
    ])).toBe(false);
  });

  it("reports the final bounded Scope validation reason without raw output", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: v21ExecutionPolicy,
      forbiddenIdentityFragments: [],
      origin: v21Origin(),
      originalRunId: "run-original-v21-audit-failure",
      reasoningEffort: null,
      request: benchmarkCase.question,
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
      transport: "native_strict"
    });
    await expect(replayOpenRagAnswerSnapshot({
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
    })).rejects.toThrow("open_rag_replay_coverage_scope_shape_invalid");
  });

  it("allows a supported stage override while attesting inherited roles", () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
      executionPolicy: Object.freeze({
        ...v21ExecutionPolicy,
        overriddenRoles: Object.freeze(["selector"] as const),
        selectorReasoningEffort: "high"
      }),
      forbiddenIdentityFragments: [],
      origin: v21Origin(),
      originalRunId: "run-original-v21-override",
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
