import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeRerankerCandidatePool,
  createKnowledgeRerankerCandidates,
  type KnowledgeRerankerEmbeddingExecutor,
  type KnowledgeSemanticRerankerExecutor
} from "./rerankerCandidates";
import {
  assessKnowledgeRerankerCorpus,
  createKnowledgeRerankerCorpusManifest,
  KNOWLEDGE_RERANKER_FROZEN_CORPUS_SHA256
} from "./rerankerCorpus";
import {
  importKnowledgeRerankerReviewEvidence,
  knowledgeRerankerReviewerSubmissionSha256,
  KNOWLEDGE_RERANKER_ADJUDICATION_FILE,
  KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE,
  KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE,
  KNOWLEDGE_RERANKER_REVIEWER_A_FILE,
  KNOWLEDGE_RERANKER_REVIEWER_B_FILE,
  readKnowledgeRerankerReviewEvidenceDirectory,
  writeKnowledgeRerankerReviewArtifacts
} from "./rerankerReview";

function embeddingTestDouble(): KnowledgeRerankerEmbeddingExecutor {
  return Object.freeze({
    async embed(input) {
      return {
        costMicros: 0,
        inputTokens: null,
        vectors: input.texts.map((text) => {
          const bytes = createHash("sha256").update(text, "utf8").digest();
          return Array.from({ length: 8 }, (_, index) => (bytes[index]! - 127.5) / 127.5);
        })
      };
    },
    identity: {
      approval: "test_double_only",
      authorization: "test_double",
      dimensions: 8,
      egress: "none",
      executionClass: "test_double",
      modelId: "review-infrastructure-vector-double",
      provider: "vitest",
      revision: "1",
      vectorSpaceId: "knowledge-reranker-test-double"
    }
  });
}

async function candidatePool() {
  const corpus = createKnowledgeRerankerCorpusManifest();
  const result = await buildKnowledgeRerankerCandidatePool({
    candidateLimit: 6,
    corpus,
    embedding: embeddingTestDouble()
  });
  return { corpus, result };
}

describe("Knowledge reranker evaluation infrastructure", () => {
  it("freezes a substantive family-separated bilingual corpus", () => {
    const corpus = createKnowledgeRerankerCorpusManifest();
    const assessment = assessKnowledgeRerankerCorpus(corpus);

    expect(corpus.corpusSha256).toBe(KNOWLEDGE_RERANKER_FROZEN_CORPUS_SHA256);
    expect(assessment).toMatchObject({
      benchmarkQualityEligible: false,
      documentCount: 50,
      familyLeakage: false,
      humanLabels: "not_collected",
      queryCount: 24
    });
    expect(Object.values(assessment.splitCounts).every((split) =>
      split.documents > 0 && split.englishQueries > 0 && split.russianQueries > 0
    )).toBe(true);
    expect(corpus.documents.every((document) =>
      document.passages.every((passage) => passage.text.length >= 180) &&
      document.contentSafety.privateOperatorDocuments === false &&
      document.contentSafety.privateUserContent === false
    )).toBe(true);
  });

  it("builds one hash-bound pool from embedding similarity without relevance signals", async () => {
    const { corpus, result } = await candidatePool();

    expect(result.pool).toMatchObject({
      candidateLimit: 6,
      corpusSha256: corpus.corpusSha256,
      noRelevanceDerivedSignals: true,
      qualityGateEligible: false,
      samePoolForEveryCandidate: true
    });
    expect(result.pool.queries).toHaveLength(corpus.queries.length);
    expect(result.pool.queries.every((query) =>
      query.candidates.length === 6 &&
      query.candidates.every((candidate, index) => candidate.rank === index + 1)
    )).toBe(true);
    expect(createKnowledgeRerankerCandidates().map((candidate) => [
      candidate.id,
      candidate.availability
    ])).toEqual([
      ["deterministic_heuristic_v1", "available"],
      ["local_multilingual_cross_encoder", "unavailable"],
      ["system_model_reranker", "unavailable"],
      ["hybrid_local_v1", "unavailable"]
    ]);
  });

  it("executes injected local, System Model, and hybrid candidate lanes over identical inputs", async () => {
    const { corpus, result } = await candidatePool();
    const semanticExecutor = (
      kind: "local" | "system"
    ): KnowledgeSemanticRerankerExecutor => ({
      identity: {
        authorization: "evaluation_only",
        backend: "vitest-contract-double",
        egress: kind === "local" ? "none" : "external",
        hardware: kind === "local" ? "cpu" : "provider_managed",
        modelId: `${kind}-reranker-contract-double`,
        provider: "vitest",
        revision: "1"
      },
      async rerank(input) {
        return {
          costMicros: 0,
          inputTokens: null,
          scores: input.passages.map((passage, index) => ({
            passageId: passage.id,
            score: (input.passages.length - index) / input.passages.length
          }))
        };
      }
    });
    const poolQuery = result.pool.queries[0]!;
    const query = corpus.queries.find((entry) => entry.id === poolQuery.queryId)!;
    const passages = new Map(corpus.documents.flatMap((document) => document.passages
      .map((passage) => [passage.id, { documentId: document.id, passage }] as const)));
    const scoringInput = {
      passages: poolQuery.candidates.map((candidate) => ({
        ...passages.get(candidate.passageId)!,
        retrievalRank: candidate.rank,
        retrievalSimilarity: candidate.cosineSimilarity
      })),
      query: query.text
    };
    const candidates = createKnowledgeRerankerCandidates({
      localCrossEncoder: semanticExecutor("local"),
      systemModel: semanticExecutor("system")
    });
    expect(candidates.every((candidate) => candidate.availability === "available")).toBe(true);
    const outputs = await Promise.all(candidates.map((candidate) => {
      if (candidate.availability !== "available") throw new Error("candidate_unavailable");
      return candidate.score(scoringInput);
    }));
    expect(outputs.every((output) => output.scores.length === poolQuery.candidates.length))
      .toBe(true);
    expect(outputs.every((output) => new Set(output.scores.map((score) => score.passageId)).size ===
      poolQuery.candidates.length)).toBe(true);
  });

  it("writes a private blind packet and strictly imports two human rounds plus adjudication", async () => {
    const { corpus, result } = await candidatePool();
    const reviewDirectory = await mkdtemp("/tmp/aiqsa-knowledge-reranker-review-");
    await chmod(reviewDirectory, 0o700);
    let counter = 0;
    const randomId = () => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    };
    try {
      const artifacts = await writeKnowledgeRerankerReviewArtifacts({
        corpus,
        pool: result.pool,
        randomId,
        randomIndex: (maximum) => maximum - 1,
        reviewDirectory
      });
      const packetPath = resolve(reviewDirectory, KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE);
      const mappingPath = resolve(reviewDirectory, KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE);
      expect((await stat(packetPath)).mode & 0o777).toBe(0o600);
      expect((await stat(mappingPath)).mode & 0o777).toBe(0o600);
      const packetText = await readFile(packetPath, "utf8");
      expect(packetText).not.toContain("kr-query-");
      expect(packetText).not.toContain("cosineSimilarity");
      expect(packetText).not.toContain("modelId");
      expect(packetText).not.toContain('"split"');

      const decisions = artifacts.packet.queries.map((query) => ({
        answerability: "uncertain" as const,
        candidates: query.candidates.map((candidate) => ({
          relevance: 1,
          reviewItemId: candidate.reviewItemId
        })),
        reviewQueryId: query.reviewQueryId
      }));
      const submission = (id: string) => ({
        artifactType: "knowledge_reranker_reviewer_submission" as const,
        artifactVersion: "knowledge-reranker-review-v1" as const,
        packetSha256: artifacts.packet.packetSha256,
        queries: decisions,
        reviewer: {
          humanAttestation: "independent_human_review" as const,
          id,
          implementationAgent: false as const,
          provenance: "external_human" as const
        }
      });
      const first = submission("human-reviewer-alpha");
      const second = submission("human-reviewer-beta");
      const adjudication = {
        adjudicator: {
          humanAttestation: "independent_human_review" as const,
          id: "human-reviewer-adjudicator",
          implementationAgent: false as const,
          provenance: "external_human" as const
        },
        annotatorSubmissionSha256s: [
          knowledgeRerankerReviewerSubmissionSha256(first),
          knowledgeRerankerReviewerSubmissionSha256(second)
        ] as const,
        artifactType: "knowledge_reranker_adjudication" as const,
        artifactVersion: "knowledge-reranker-review-v1" as const,
        completed: true as const,
        decisions,
        packetSha256: artifacts.packet.packetSha256,
        unresolvedMaterialDisagreements: 0 as const
      };
      const imported = importKnowledgeRerankerReviewEvidence({
        adjudication,
        mapping: artifacts.mapping,
        packet: artifacts.packet,
        submissions: [first, second]
      });
      expect(imported).toMatchObject({
        adjudicationComplete: true,
        candidatePoolSha256: result.pool.poolSha256,
        candidatePoolQualityGateEligible: false,
        independentAnnotatorCount: 2,
        unresolvedMaterialDisagreements: 0
      });
      expect(imported.labels).toHaveLength(corpus.queries.length);
      await Promise.all([
        [KNOWLEDGE_RERANKER_REVIEWER_A_FILE, first],
        [KNOWLEDGE_RERANKER_REVIEWER_B_FILE, second],
        [KNOWLEDGE_RERANKER_ADJUDICATION_FILE, adjudication]
      ].map(([fileName, value]) => writeFile(
        resolve(reviewDirectory, fileName as string),
        `${JSON.stringify(value)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      )));
      await expect(readKnowledgeRerankerReviewEvidenceDirectory(reviewDirectory))
        .resolves.toMatchObject({
          adjudicationComplete: true,
          candidatePoolSha256: result.pool.poolSha256,
          independentAnnotatorCount: 2
        });
      expect(() => importKnowledgeRerankerReviewEvidence({
        adjudication,
        mapping: artifacts.mapping,
        packet: artifacts.packet,
        submissions: [first, first]
      })).toThrow("knowledge_reranker_review_annotators_not_distinct");
      expect(() => importKnowledgeRerankerReviewEvidence({
        adjudication,
        mapping: artifacts.mapping,
        packet: artifacts.packet,
        submissions: [
          first,
          {
            ...second,
            reviewer: { ...second.reviewer, implementationAgent: true }
          }
        ]
      })).toThrow();
      expect(() => importKnowledgeRerankerReviewEvidence({
        adjudication,
        mapping: artifacts.mapping,
        packet: {
          ...artifacts.packet,
          candidatePoolQualityGateEligible: true
        },
        submissions: [first, second]
      })).toThrow("knowledge_reranker_review_artifact_digest_invalid");
    } finally {
      await rm(reviewDirectory, { force: true, recursive: true });
    }
  });
});
