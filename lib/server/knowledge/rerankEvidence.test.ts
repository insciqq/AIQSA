import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeRerankerBindingEvidenceV2,
  KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
  knowledgeRerankerBilledCall,
  knowledgeRerankerRejectedCall,
  type KnowledgeRerankerBindingEvidenceV2
} from "./rerankEvidence";

function completeEvidence(
  overrides: Partial<KnowledgeRerankerBindingEvidenceV2> = {}
): KnowledgeRerankerBindingEvidenceV2 {
  return {
    adapterVersion: "openrouter-rerank-v1",
    candidateFormatterVersion: 1,
    connectionSnapshotId: "connection-1#v3",
    credentialSnapshotRef: "credential-version-1",
    durationMs: 812,
    fallbackReason: null,
    inputCandidateCount: 3,
    orderedCandidateChunkIds: ["chunk-a", "chunk-b", "chunk-c"],
    outputOrder: ["chunk-b", "chunk-a", "chunk-c"],
    policyVersion: 7,
    provider: "openrouter",
    providerModelId: "deployment-1",
    providerRequestId: "req-1",
    rankingProfileVersion: 4,
    relevanceScores: [0.91, 0.4, 0.05],
    status: "complete",
    timedOut: false,
    upstreamModelId: "qwen/qwen3-reranker-8b",
    usage: { searchUnits: 1, totalTokens: 512 },
    version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
    ...overrides
  };
}

describe("Knowledge reranker binding evidence V2", () => {
  it("round-trips a complete scored execution", () => {
    const evidence = completeEvidence();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(evidence)).toEqual(evidence);
    expect(decodeKnowledgeRerankerBindingEvidenceV2(
      JSON.parse(JSON.stringify(evidence))
    )).toEqual(evidence);
  });

  it("round-trips partial, degraded, and disabled statuses", () => {
    const partial = completeEvidence({
      relevanceScores: [0.91, 0.4, null],
      status: "partial"
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(partial)).toEqual(partial);

    const degraded = completeEvidence({
      fallbackReason: "rerank_request_timed_out",
      outputOrder: [],
      provider: null,
      providerRequestId: null,
      relevanceScores: [],
      status: "degraded",
      timedOut: true,
      usage: { searchUnits: null, totalTokens: null }
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(degraded)).toEqual(degraded);

    const disabled = completeEvidence({
      adapterVersion: null,
      candidateFormatterVersion: null,
      connectionSnapshotId: null,
      credentialSnapshotRef: null,
      durationMs: 0,
      inputCandidateCount: 0,
      orderedCandidateChunkIds: [],
      outputOrder: [],
      policyVersion: null,
      provider: null,
      providerModelId: null,
      providerRequestId: null,
      relevanceScores: [],
      status: "disabled",
      upstreamModelId: null,
      usage: { searchUnits: null, totalTokens: null }
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(disabled)).toEqual(disabled);
  });

  it("accepts the deterministic single-candidate skip as complete without scores", () => {
    const skip = completeEvidence({
      inputCandidateCount: 1,
      orderedCandidateChunkIds: ["chunk-a"],
      outputOrder: ["chunk-a"],
      provider: null,
      providerRequestId: null,
      relevanceScores: [null],
      usage: { searchUnits: null, totalTokens: null }
    });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(skip)).toEqual(skip);
  });

  it.each([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])("decodes only accepted ranking profiles (%s)", (rankingProfileVersion) => {
    const evidence = completeEvidence({ rankingProfileVersion });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(evidence)).toEqual(rankingProfileVersion === 13 ? null : evidence);
  });

  it("is strictly content-free and shape-exact", () => {
    expect(decodeKnowledgeRerankerBindingEvidenceV2(null)).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2({})).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2({
      ...completeEvidence(),
      queryText: "secret question"
    })).toBeNull();
    const { usage: _usage, ...missingUsage } = completeEvidence();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(missingUsage)).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(
      completeEvidence({ version: 1 as never })
    )).toBeNull();
  });

  it("rejects malformed score and order shapes", () => {
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      relevanceScores: [0.91, 0.4, Number.NaN]
    }))).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      outputOrder: ["chunk-b", "chunk-b", "chunk-c"]
    }))).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      outputOrder: ["chunk-b", "chunk-a", "chunk-z"]
    }))).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      orderedCandidateChunkIds: ["chunk-a", "chunk-b"]
    }))).toBeNull();
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      relevanceScores: [0.91, 0.4]
    }))).toBeNull();
  });

  it("round-trips finite scores outside a guessed probability range", () => {
    const evidence = completeEvidence({ relevanceScores: [4.5, -1.25, 0] });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(evidence)).toEqual(evidence);
  });

  it("rejects status combinations that misstate what happened", () => {
    // A complete multi-candidate execution cannot silently omit scores.
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      relevanceScores: [0.91, null, null]
    }))).toBeNull();
    // A partial execution needs at least one score and one omission.
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      status: "partial"
    }))).toBeNull();
    // A degraded execution requires a content-free fallback reason.
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      outputOrder: [],
      relevanceScores: [],
      status: "degraded"
    }))).toBeNull();
    // A pinned execution cannot lose its immutable pin fields.
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      policyVersion: null
    }))).toBeNull();
    // Disabled evidence carries no pins, pool, or provider identity.
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({
      status: "disabled"
    }))).toBeNull();
  });

  it("round-trips a provider call's input tokens and reported cost beside older usage", () => {
    const priced = completeEvidence({ usage: { costUsd: 1e-7, inputTokens: null, searchUnits: null, totalTokens: 2 } });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(JSON.parse(JSON.stringify(priced)))).toEqual(priced);
    const unreported = completeEvidence({ usage: { costUsd: null, inputTokens: 40, searchUnits: 1, totalTokens: 40 } });
    expect(decodeKnowledgeRerankerBindingEvidenceV2(unreported)).toEqual(unreported);
    // Receipts accepted before reranking was accounted keep their exact shape.
    expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence())?.usage).toEqual({ searchUnits: 1, totalTokens: 512 });
    for (const usage of [
      { costUsd: 1e-7, searchUnits: null, totalTokens: 2 },
      { inputTokens: 2, searchUnits: null, totalTokens: 2 },
      { costUsd: -1e-7, inputTokens: null, searchUnits: null, totalTokens: 2 },
      { costUsd: "1e-7", inputTokens: null, searchUnits: null, totalTokens: 2 },
      { costUsd: 1e-7, inputTokens: 1.5, searchUnits: null, totalTokens: 2 },
      { costUsd: 1e-7, inputTokens: null, searchUnits: null, totalTokens: 2, queryText: "secret question" }
    ]) {
      expect(decodeKnowledgeRerankerBindingEvidenceV2(completeEvidence({ usage: usage as never }))).toBeNull();
    }
  });

  it("names the billed reranker call of a scored ranking, under its billing family", () => {
    expect(knowledgeRerankerBilledCall(completeEvidence({
      provider: "VoyageAI by MongoDB",
      usage: { costUsd: 1e-7, inputTokens: null, searchUnits: null, totalTokens: 2 }
    }))).toEqual({ costUsd: 1e-7, inputTokens: null, modelId: "qwen/qwen3-reranker-8b", provider: "openrouter",
      providerModelId: "deployment-1", totalTokens: 2 });
    // A ranking recorded before reranking was accounted reported no cost.
    expect(knowledgeRerankerBilledCall(completeEvidence({ relevanceScores: [0.91, 0.4, null], status: "partial" })))
      .toMatchObject({ costUsd: null, inputTokens: null, totalTokens: 512 });
    const skip = completeEvidence({ inputCandidateCount: 1, orderedCandidateChunkIds: ["chunk-a"], outputOrder: ["chunk-a"],
      provider: null, providerRequestId: null, relevanceScores: [null], usage: { searchUnits: null, totalTokens: null } });
    const degraded = completeEvidence({ fallbackReason: "rerank_provider_server_error", outputOrder: [], provider: null,
      providerRequestId: null, relevanceScores: [], status: "degraded", usage: { searchUnits: null, totalTokens: null } });
    for (const evidence of [skip, degraded]) {
      expect(decodeKnowledgeRerankerBindingEvidenceV2(evidence)).not.toBeNull();
      expect(knowledgeRerankerBilledCall(evidence)).toBeNull();
    }
  });

  it("bills the rejected response a degraded fallback records, never a fallback without one", () => {
    const rejected = completeEvidence({ fallbackReason: "rerank_response_invalid", outputOrder: [], provider: null,
      providerRequestId: null, relevanceScores: [], status: "degraded",
      usage: { costUsd: 0.0000042, inputTokens: null, searchUnits: null, totalTokens: 120 } });
    const stored = decodeKnowledgeRerankerBindingEvidenceV2(JSON.parse(JSON.stringify(rejected)));
    expect(stored).toEqual(rejected);
    expect(knowledgeRerankerBilledCall(stored!)).toEqual({ costUsd: 0.0000042, inputTokens: null,
      modelId: "qwen/qwen3-reranker-8b", provider: "openrouter", providerModelId: "deployment-1", totalTokens: 120 });
    const unpinned = completeEvidence({ ...rejected, adapterVersion: null, candidateFormatterVersion: null,
      connectionSnapshotId: null, credentialSnapshotRef: null, policyVersion: null, providerModelId: null,
      upstreamModelId: null, fallbackReason: "reranker_model_unavailable" });
    expect(knowledgeRerankerBilledCall(unpinned)).toBeNull();
  });

  it("names a rejected response that failed its operation under the pinned deployment", () => {
    // What `RerankAdapterError.usage` carries.
    const reported = { costUsd: 0.000003, inputTokens: 64, searchUnits: null, totalTokens: 64 };
    expect(knowledgeRerankerRejectedCall({ adapterVersion: "openrouter-rerank-v2", provider: "openrouter",
      providerModelId: "deployment-1", upstreamModelId: "qwen/qwen3-reranker-8b" }, reported)).toEqual({
      costUsd: 0.000003, inputTokens: 64, modelId: "qwen/qwen3-reranker-8b", provider: "openrouter",
      providerModelId: "deployment-1", totalTokens: 64 });
    expect(knowledgeRerankerRejectedCall({ adapterVersion: "custom-rerank", provider: "cohere",
      providerModelId: "deployment-2", upstreamModelId: "rerank-v4" }, { inputTokens: null, totalTokens: 8 }))
      .toMatchObject({ costUsd: null, provider: "cohere", totalTokens: 8 });
  });
});
