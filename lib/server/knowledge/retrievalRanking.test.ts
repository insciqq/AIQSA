import { describe, expect, it, vi } from "vitest";
import {
  boundKnowledgeCandidates,
  fuseKnowledgeCandidates,
  KNOWLEDGE_MIN_CONFIDENCE,
  rankKnowledgeCandidates,
  type KnowledgeCandidateSignal,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalLane
} from "./retrievalRanking";

function signal(
  lane: KnowledgeRetrievalLane,
  rank: number,
  overrides: Partial<KnowledgeCandidateSignal> = {}
): KnowledgeCandidateSignal {
  return {
    exactKind: lane === "exact" ? "identifier" : null,
    lane,
    rank,
    rawScore: 1,
    vectorDistance: lane === "passage_semantic" ? 0.05 : null,
    vectorMode: lane === "passage_semantic" ? "exact" : null,
    ...overrides
  };
}

function candidate(input: Readonly<{
  chunkId: string;
  contentHash?: string;
  fileName?: string;
  bindingOrdinal?: number;
  signals: readonly KnowledgeCandidateSignal[];
  sourceName?: string;
  text: string;
}>): KnowledgeRetrievalCandidate {
  return {
    baseName: "Policies",
    bindingOrdinal: input.bindingOrdinal ?? 0,
    chunkId: input.chunkId,
    chunkIndex: Number(input.chunkId.replace(/\D/gu, "")) || 0,
    contentHash: input.contentHash ?? `hash-${input.chunkId}`,
    documentId: `document-${input.chunkId}`,
    documentVersionId: `version-${input.chunkId}`,
    documentVersionNumber: 1,
    fileName: input.fileName ?? `${input.chunkId}.txt`,
    headingPath: ["Policy"],
    knowledgeBaseId: "base-1",
    layoutKind: "body",
    page: 1,
    sectionId: `section-${input.chunkId}`,
    signals: input.signals,
    sourceArtifactId: `artifact-${input.chunkId}`,
    sourceName: input.sourceName ?? input.chunkId,
    text: input.text
  };
}

describe("Knowledge retrieval ranking", () => {
  it("bounds dense multi-base pools without allowing one base to consume another's share", () => {
    const candidates = Array.from({ length: 1_200 }, (_, index) => candidate({
      bindingOrdinal: index % 3,
      chunkId: `dense-${index}`,
      signals: [signal("passage_lexical", index + 1)],
      text: `Dense candidate ${index}`
    }));

    const bounded = boundKnowledgeCandidates(candidates, 3);
    const counts = [0, 1, 2].map((bindingOrdinal) =>
      bounded.filter((entry) => entry.bindingOrdinal === bindingOrdinal).length);
    expect(bounded).toHaveLength(1_000);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("fuses bounded lanes without allowing duplicate signals from one lane to dominate", () => {
    const [fused] = fuseKnowledgeCandidates([candidate({
      chunkId: "c1",
      signals: [signal("passage_lexical", 1), signal("passage_lexical", 2), signal("exact", 3)],
      text: "AX20260842"
    })]);
    const [single] = fuseKnowledgeCandidates([candidate({
      chunkId: "c2",
      signals: [signal("passage_lexical", 1)],
      text: "AX20260842"
    })]);
    expect(fused!.fusedScore).toBeGreaterThan(single!.fusedScore);
    expect(fused!.fusedScore).toBeLessThanOrEqual(1);
  });

  it("ranks English and Russian evidence and rejects a weak vector-only no-answer candidate", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        candidate({
          chunkId: "english",
          signals: [signal("passage_lexical", 1)],
          text: "Atlas retains completed exports for 37 days."
        }),
        candidate({
          chunkId: "russian",
          signals: [signal("passage_lexical", 1)],
          text: "Материалы Береста находятся на хранении сорок пять дней."
        }),
        candidate({
          chunkId: "distractor",
          signals: [signal("passage_semantic", 1, { vectorDistance: 0.646 })],
          text: "Unrelated synthetic benchmark passage."
        })
      ],
      query: "Сколько дней нужно хранить материалы Береста?",
      resultLimit: 8,
      scoreThreshold: 0.01
    });
    expect(result.selected.map((entry) => entry.chunkId)).toEqual(["russian"]);
    expect(result.selected[0]!.confidence).toBeGreaterThanOrEqual(KNOWLEDGE_MIN_CONFIDENCE);
  });

  it("covers every explicitly named comparison target before filling more passages", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        candidate({
          chunkId: "alpha-1",
          signals: [signal("passage_semantic", 1)],
          sourceName: "Alpha plan",
          text: "Alpha cancellation notice is 30 days."
        }),
        candidate({
          chunkId: "alpha-2",
          signals: [signal("passage_semantic", 2)],
          sourceName: "Alpha plan",
          text: "Alpha has another relevant paragraph."
        }),
        candidate({
          chunkId: "beta-1",
          signals: [signal("passage_semantic", 3)],
          sourceName: "Beta plan",
          text: "Beta cancellation notice is 45 days."
        }),
        candidate({
          chunkId: "gamma-1",
          signals: [signal("passage_semantic", 4)],
          sourceName: "Gamma plan",
          text: "Gamma cancellation notice is 60 days."
        })
      ],
      query: "Compare the cancellation notice for Alpha, Beta, and Gamma.",
      resultLimit: 3,
      scoreThreshold: 0.01
    });
    expect(new Set(result.selected.map((entry) => entry.sourceName))).toEqual(
      new Set(["Alpha plan", "Beta plan", "Gamma plan"])
    );
  });

  it("deduplicates repeated content while preserving named comparison coverage", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        candidate({
          chunkId: "copy-1",
          contentHash: "same",
          signals: [signal("passage_lexical", 1)],
          text: "Repeated policy evidence."
        }),
        candidate({
          chunkId: "copy-2",
          contentHash: "same",
          signals: [signal("passage_lexical", 2)],
          text: "Repeated policy evidence."
        })
      ],
      query: "Repeated policy evidence",
      resultLimit: 8,
      scoreThreshold: 0.01
    });
    expect(result.selected).toHaveLength(1);
  });

  it("falls back to deterministic fusion order when the reranker is unavailable", async () => {
    const rerank = vi.fn(async () => {
      throw new Error("sidecar unavailable");
    });
    const candidates = [
      candidate({
        chunkId: "exact",
        signals: [signal("exact", 1), signal("passage_lexical", 1)],
        text: "Policy identifier AX20260842."
      }),
      candidate({
        chunkId: "semantic",
        signals: [signal("passage_semantic", 1)],
        text: "Other policy."
      })
    ];
    const first = await rankKnowledgeCandidates({
      candidates,
      query: "Find AX20260842",
      reranker: { rerank },
      resultLimit: 8,
      scoreThreshold: 0.01
    });
    const second = await rankKnowledgeCandidates({
      candidates,
      query: "Find AX20260842",
      reranker: { rerank },
      resultLimit: 8,
      scoreThreshold: 0.01
    });
    expect(first.evidence.rerankerBinding).toMatchObject({
      failureCode: "knowledge_reranker_unavailable",
      status: "degraded"
    });
    expect(first.evidence.postRerankOrder).toEqual(first.evidence.preRerankOrder);
    expect(first.selected.map((entry) => entry.chunkId)).toEqual(
      second.selected.map((entry) => entry.chunkId)
    );
  });
});
