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
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
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

describe("OpenRAG frozen-evidence replay", () => {
  it("runs only the V20 answer stages over the immutable dispatch", async () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
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

  it("rejects any snapshot identity or evidence mutation", () => {
    const frozen = createOpenRagAnswerReplaySnapshot({
      answerExecutionSnapshot: snapshot(),
      capturedAt: "2026-08-31T00:00:00.000Z",
      case: benchmarkCase,
      evidence: evidence(),
      evidenceBindings: evidenceBindings(),
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
