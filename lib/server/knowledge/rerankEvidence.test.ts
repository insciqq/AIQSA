import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeRerankerBindingEvidenceV2,
  KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
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
    rankingProfileVersion: 2,
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
});
