import { describe, expect, it } from "vitest";
import {
  boundKnowledgeCandidates,
  fuseKnowledgeCandidates,
  KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR,
  KNOWLEDGE_METADATA_RELEVANCE_FLOOR,
  KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS,
  KNOWLEDGE_RRF_K,
  KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR,
  rankKnowledgeCandidates,
  type KnowledgeCandidateSignal,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalLane
} from "./retrievalRanking";

function signal(
  lane: KnowledgeRetrievalLane,
  rank: number,
  input: Partial<Pick<KnowledgeCandidateSignal, "rawScore" | "vectorDistance">> = {}
): KnowledgeCandidateSignal {
  return {
    exactKind: lane === "exact" ? "identifier" : null,
    lane,
    rank,
    rawScore: input.rawScore ?? 1,
    vectorDistance: input.vectorDistance ?? (lane === "passage_semantic" ? 0.05 : null),
    vectorMode: lane === "passage_semantic" ? "exact" : null
  };
}

function candidate(input: Readonly<{
  artifactId?: string;
  chunkId: string;
  contentHash?: string;
  bindingOrdinal?: number;
  source?: string;
  sourceId?: string;
  signals?: readonly KnowledgeCandidateSignal[];
}>): KnowledgeRetrievalCandidate {
  const source = input.source ?? input.chunkId;
  return {
    baseName: "Policies",
    bindingOrdinal: input.bindingOrdinal ?? 0,
    chunkId: input.chunkId,
    chunkIndex: Number(input.chunkId.replace(/\D/gu, "")) || 0,
    contentHash: input.contentHash ?? `hash-${input.chunkId}`,
    documentId: input.sourceId ?? `document-${source}`,
    documentVersionId: `version-${source}`,
    documentVersionNumber: 1,
    fileName: `${source}.txt`,
    headingPath: ["Policy"],
    knowledgeBaseId: "base-1",
    layoutKind: "body",
    page: 1,
    sectionId: `section-${input.chunkId}`,
    signals: input.signals ?? [signal("passage_bm25", 1)],
    sourceArtifactId: input.artifactId ?? `artifact-${source}`,
    sourceName: source,
    text: `Evidence ${input.chunkId}`
  };
}

describe("Knowledge retrieval ranking", () => {
  it("bounds dense multi-base pools without allowing one base to consume another's share", () => {
    const candidates = Array.from({ length: 1_200 }, (_, index) => candidate({
      bindingOrdinal: index % 3,
      chunkId: `dense-${index}`,
      signals: [signal("passage_bm25", index + 1)]
    }));
    const bounded = boundKnowledgeCandidates(candidates, 3);
    const counts = [0, 1, 2].map((bindingOrdinal) =>
      bounded.filter((entry) => entry.bindingOrdinal === bindingOrdinal).length);
    expect(bounded).toHaveLength(1_000);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("uses each lane's best signal once in weighted RRF", () => {
    const [fused] = fuseKnowledgeCandidates([candidate({
      chunkId: "c1",
      signals: [signal("passage_bm25", 1), signal("passage_bm25", 2), signal("exact", 3)]
    })]);
    const [single] = fuseKnowledgeCandidates([candidate({
      chunkId: "c2",
      signals: [signal("passage_bm25", 1)]
    })]);
    expect(fused!.fusedScore).toBeGreaterThan(single!.fusedScore);
  });

  it("keeps direct passage evidence above coarse document and section routing hits", () => {
    const ranked = fuseKnowledgeCandidates([
      candidate({
        chunkId: "coarse-parent",
        signals: [signal("document_lexical", 1), signal("section_lexical", 1)]
      }),
      candidate({
        chunkId: "direct-passage",
        signals: [signal("passage_semantic", 40, {
          rawScore: KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR,
          vectorDistance: 1 - KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR
        })]
      })
    ]);

    const strongestCoarseScore = (
      KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.document_lexical +
      KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.section_lexical
    ) / (KNOWLEDGE_RRF_K + 1);
    const weakestRetainedDirectScore =
      KNOWLEDGE_RETRIEVAL_LANE_WEIGHTS.passage_semantic / (KNOWLEDGE_RRF_K + 40);
    expect(weakestRetainedDirectScore).toBeGreaterThan(strongestCoarseScore);
    expect(ranked.map((entry) => entry.chunkId)).toEqual([
      "direct-passage",
      "coarse-parent"
    ]);
  });

  it("drops candidates below every named floor while retaining exact equality", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        candidate({
          chunkId: "weak-lexical",
          signals: [signal("document_lexical", 1, {
            rawScore: KNOWLEDGE_LEXICAL_RELEVANCE_FLOOR - 0.001
          })]
        }),
        candidate({
          chunkId: "weak-metadata",
          signals: [signal("metadata", 1, {
            rawScore: KNOWLEDGE_METADATA_RELEVANCE_FLOOR - 0.001
          })]
        }),
        candidate({
          chunkId: "weak-semantic",
          signals: [signal("passage_semantic", 1, {
            rawScore: KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR - 0.001,
            vectorDistance: 1 - KNOWLEDGE_SEMANTIC_RELEVANCE_FLOOR + 0.001
          })]
        }),
        candidate({
          chunkId: "exact",
          signals: [signal("exact", 40, { rawScore: 0 })]
        })
      ],
      resultLimit: 8
    });
    expect(result.selected.map((entry) => entry.chunkId)).toEqual(["exact"]);
    expect(result.evidence.candidateOrder).toEqual(["exact"]);
  });

  it("retains positive OpenSearch BM25 hits without an absolute score floor", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [candidate({
        chunkId: "bm25-hit",
        signals: [signal("passage_bm25", 1, { rawScore: 0.001 })]
      })],
      resultLimit: 8
    });
    expect(result.selected.map((entry) => entry.chunkId)).toEqual(["bm25-hit"]);
  });

  it("returns an ordinary empty ranking when every generated candidate is irrelevant", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [candidate({
        chunkId: "nearest-but-irrelevant",
        signals: [
          signal("neighbor", 1),
          signal("passage_semantic", 1, { rawScore: 0.2, vectorDistance: 0.8 })
        ]
      })],
      resultLimit: 8
    });
    expect(result.ranked).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(result.evidence.candidateOrder).toEqual([]);
  });

  it("allows one clearly stronger Source to fill every result slot", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        ...Array.from({ length: 8 }, (_, index) => candidate({
          chunkId: `a${index}`,
          source: "a",
          signals: [signal("exact", index + 1)]
        })),
        candidate({ chunkId: "b1", source: "b", signals: [signal("passage_bm25", 1)] })
      ],
      resultLimit: 8
    });
    expect(result.selected).toHaveLength(8);
    expect(result.selected.every((entry) => entry.sourceName === "a")).toBe(true);
  });

  it("interleaves near-equal Sources only inside the soft relevance band", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        candidate({ chunkId: "a1", source: "a", signals: [signal("exact", 1)] }),
        candidate({ chunkId: "a2", source: "a", signals: [signal("exact", 2)] }),
        candidate({ chunkId: "b1", source: "b", signals: [signal("exact", 3)] }),
        candidate({ chunkId: "b2", source: "b", signals: [signal("exact", 4)] })
      ],
      resultLimit: 4
    });

    expect(result.selected.map((entry) => entry.sourceName)).toEqual(["a", "b", "a", "b"]);
  });

  it("shares soft-diversity counts across compatible artifacts without a hard Source cap", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        ...Array.from({ length: 4 }, (_, index) => candidate({
          artifactId: "artifact-a-v1",
          chunkId: `a-v1-${index}`,
          source: "a-v1",
          sourceId: "source-a",
          signals: [signal("exact", index * 2 + 1)]
        })),
        ...Array.from({ length: 4 }, (_, index) => candidate({
          artifactId: "artifact-a-v2",
          chunkId: `a-v2-${index}`,
          source: "a-v2",
          sourceId: "source-a",
          signals: [signal("exact", index * 2 + 2)]
        })),
        candidate({
          artifactId: "artifact-b",
          chunkId: "b-1",
          source: "b",
          sourceId: "source-b",
          signals: [signal("passage_bm25", 1)]
        })
      ],
      resultLimit: 8
    });

    expect(result.selected).toHaveLength(8);
    expect(result.selected.every((entry) => entry.documentId === "source-a")).toBe(true);
    expect(new Set(result.selected
      .filter((entry) => entry.documentId === "source-a")
      .map((entry) => entry.sourceArtifactId))).toEqual(new Set([
      "artifact-a-v1",
      "artifact-a-v2"
    ]));
  });

  it("retains distinct equal-text occurrences and excludes neighbor-only rows", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        ...Array.from({ length: 8 }, (_, index) => candidate({
          chunkId: `a${index}`,
          contentHash: index === 7 ? "hash-a6" : `hash-a${index}`,
          source: "a",
          signals: [signal("passage_bm25", index + 1)]
        })),
        candidate({ chunkId: "neighbor", source: "a", signals: [signal("neighbor", 1)] })
      ],
      resultLimit: 8
    });
    expect(result.selected).toHaveLength(8);
    expect(result.selected.filter((entry) => entry.contentHash === "hash-a6")).toHaveLength(2);
    expect(result.selected.some((entry) => entry.chunkId === "neighbor")).toBe(false);
  });
});
