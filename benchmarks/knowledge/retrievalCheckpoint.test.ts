import { describe, expect, it } from "vitest";
import {
  aggregateKnowledgeRerankAdmissionDiagnostics,
  decodeKnowledgeRetrievalCheckpointFile,
  decodeKnowledgeRetrievalCheckpointHeader,
  decodeKnowledgeRetrievalCheckpointOutcome,
  KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
} from "./retrievalCheckpoint";

const fingerprint = "a".repeat(64);
const query = Object.freeze({
  officialId: "convfinqa_17",
  relevant: Object.freeze({ convfinqa_ctx_896: 1 }),
  text: "private query text"
});

function outcomeFixture(): Record<string, unknown> {
  return {
    candidatesAfterRerank: 16,
    candidatesBeforeRerank: 96,
    embeddingUsage: { costMicros: null, requests: 0, tokens: 12 },
    queryId: query.officialId,
    rankedDocumentIds: ["convfinqa_ctx_896", "convfinqa_ctx_1"],
    relevant: query.relevant,
    rerankApplied: true,
    rerankFallback: false,
    rerankerDiagnostic: {
      fallbackReason: null,
      omittedCandidateCount: 0,
      omittedRejectedCandidateCount: 0,
      status: "complete",
      timedOut: false
    },
    rerankerUsage: { costMicros: null, requests: 1, tokens: 42_000 },
    rerankMs: 3_200,
    retrievalMs: 17_400
  };
}

describe("retrieval checkpoint contract", () => {
  it("decodes the exact content-free header and schedule", () => {
    expect(decodeKnowledgeRetrievalCheckpointHeader({
      manifestFingerprint: fingerprint,
      queryCount: 3_453,
      querySetContentSha256: "c".repeat(64),
      runId: "t2ragbench-convfinqa-C-2026-08-29T01-00-00-000Z",
      schedule: {
        concurrency: 1,
        queryStartIntervalMs: 30_000,
        rateLimitCooldownMs: 120_000
      },
      schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
    })).toMatchObject({ queryCount: 3_453 });
    expect(() => decodeKnowledgeRetrievalCheckpointHeader({
      manifestFingerprint: fingerprint,
      queryCount: 3_453,
      querySetContentSha256: "c".repeat(64),
      runId: "run",
      schedule: { concurrency: 0, queryStartIntervalMs: 0, rateLimitCooldownMs: 0 },
      schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
    })).toThrow("knowledge_benchmark_retrieval_checkpoint_header_invalid");
  });

  it("round-trips a query outcome without query or document text", () => {
    const decoded = decodeKnowledgeRetrievalCheckpointOutcome(
      outcomeFixture(),
      query
    );
    expect(decoded.queryId).toBe(query.officialId);
    expect(JSON.stringify(decoded)).not.toContain(query.text);
    expect(decodeKnowledgeRetrievalCheckpointFile({
      manifestFingerprint: fingerprint,
      outcome: decoded,
      schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
    }, fingerprint, query)).toEqual(decoded);
  });

  it("aggregates content-free omitted-candidate admission diagnostics", () => {
    const first = decodeKnowledgeRetrievalCheckpointOutcome({
      ...outcomeFixture(),
      rerankerDiagnostic: {
        fallbackReason: null,
        omittedCandidateCount: 3,
        omittedRejectedCandidateCount: 2,
        status: "partial",
        timedOut: false
      }
    }, query);
    const second = {
      ...first,
      queryId: "convfinqa_18",
      rerankerDiagnostic: {
        ...first.rerankerDiagnostic,
        omittedCandidateCount: 1,
        omittedRejectedCandidateCount: 0
      }
    };
    expect(aggregateKnowledgeRerankAdmissionDiagnostics([first, second])).toEqual({
      omittedCandidateCount: 4,
      omittedRejectedCandidateCount: 2,
      queriesWithOmittedCandidates: 2,
      queriesWithOmittedRejections: 1
    });
  });

  it("refuses mismatched provenance, relevance, diagnostics, and extra keys", () => {
    expect(() => decodeKnowledgeRetrievalCheckpointFile({
      manifestFingerprint: "b".repeat(64),
      outcome: outcomeFixture(),
      schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
    }, fingerprint, query)).toThrow(
      "knowledge_benchmark_retrieval_checkpoint_file_invalid"
    );
    expect(() => decodeKnowledgeRetrievalCheckpointOutcome({
      ...outcomeFixture(),
      relevant: { other: 1 }
    }, query)).toThrow("knowledge_benchmark_retrieval_checkpoint_outcome_invalid");
    expect(() => decodeKnowledgeRetrievalCheckpointOutcome({
      ...outcomeFixture(),
      rerankFallback: true
    }, query)).toThrow("knowledge_benchmark_retrieval_checkpoint_outcome_invalid");
    expect(() => decodeKnowledgeRetrievalCheckpointOutcome({
      ...outcomeFixture(),
      rerankerDiagnostic: {
        fallbackReason: null,
        omittedCandidateCount: 1,
        omittedRejectedCandidateCount: 2,
        status: "partial",
        timedOut: false
      }
    }, query)).toThrow("knowledge_benchmark_retrieval_checkpoint_outcome_invalid");
    expect(() => decodeKnowledgeRetrievalCheckpointOutcome({
      ...outcomeFixture(),
      extra: true
    }, query)).toThrow("knowledge_benchmark_retrieval_checkpoint_outcome_invalid");
  });
});
