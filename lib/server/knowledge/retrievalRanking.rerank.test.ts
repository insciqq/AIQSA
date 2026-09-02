import { describe, expect, it } from "vitest";
import {
  fuseKnowledgeCandidates,
  KNOWLEDGE_BROAD_RERANK_INPUT_MAX,
  KNOWLEDGE_LANE_CANDIDATE_LIMIT,
  KNOWLEDGE_RANKING_PROFILE_VERSION,
  KNOWLEDGE_SCOPED_RERANK_INPUT_MAX,
  orderRerankedKnowledgeCandidates,
  selectKnowledgePreRerankPool,
  selectRerankedKnowledgeCandidates,
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
  bindingOrdinal?: number;
  chunkId: string;
  contentHash?: string;
  signals?: readonly KnowledgeCandidateSignal[];
  source?: string;
  text?: string;
}>): KnowledgeRetrievalCandidate {
  const source = input.source ?? input.chunkId;
  return {
    baseName: "Policies",
    bindingOrdinal: input.bindingOrdinal ?? 0,
    chunkId: input.chunkId,
    chunkIndex: 0,
    contentHash: input.contentHash ?? `hash-${input.chunkId}`,
    documentId: `document-${source}`,
    documentVersionId: `version-${source}`,
    documentVersionNumber: 1,
    fileName: `${source}.txt`,
    headingPath: ["Policy"],
    knowledgeBaseId: "base-1",
    layoutKind: "body",
    page: 1,
    sectionId: null,
    signals: input.signals ?? [signal("passage_bm25", 1)],
    sourceArtifactId: `artifact-${source}`,
    sourceName: source,
    text: input.text ?? `Evidence ${input.chunkId}`
  };
}

describe("Knowledge ranking profile v4", () => {
  it("versions the widened candidate and rerank pool constants", () => {
    expect(KNOWLEDGE_RANKING_PROFILE_VERSION).toBe(4);
    expect(KNOWLEDGE_LANE_CANDIDATE_LIMIT).toBe(64);
    expect(KNOWLEDGE_BROAD_RERANK_INPUT_MAX).toBe(96);
    expect(KNOWLEDGE_SCOPED_RERANK_INPUT_MAX).toBe(48);
  });
});

describe("Pre-rerank pool selection", () => {
  it("caps the merged pool and keeps every exact candidate regardless of dense strength", () => {
    const strong = Array.from({ length: 120 }, (_, index) => candidate({
      chunkId: `dense-${String(index).padStart(3, "0")}`,
      signals: [signal("passage_semantic", index + 1, { rawScore: 0.9, vectorDistance: 0.1 })]
    }));
    const weakExact = candidate({
      chunkId: "weak-exact",
      signals: [signal("exact", 500, { rawScore: 0.001 })]
    });
    const pool = selectKnowledgePreRerankPool({
      bindingOrdinals: [0],
      candidates: [...strong, weakExact],
      maximum: KNOWLEDGE_BROAD_RERANK_INPUT_MAX
    });
    expect(pool).toHaveLength(KNOWLEDGE_BROAD_RERANK_INPUT_MAX);
    expect(pool.some((entry) => entry.chunkId === "weak-exact")).toBe(true);
  });

  it("respects the scoped forty-eight cap", () => {
    const pool = selectKnowledgePreRerankPool({
      bindingOrdinals: [0],
      candidates: Array.from({ length: 90 }, (_, index) => candidate({
        chunkId: `chunk-${String(index).padStart(2, "0")}`,
        signals: [signal("passage_bm25", index + 1)]
      })),
      maximum: KNOWLEDGE_SCOPED_RERANK_INPUT_MAX
    });
    expect(pool).toHaveLength(KNOWLEDGE_SCOPED_RERANK_INPUT_MAX);
  });

  it("balances the capped pool across accepted bindings", () => {
    // Binding 0 dominates the RRF order; binding 1 still receives its share.
    const dominant = Array.from({ length: 96 }, (_, index) => candidate({
      bindingOrdinal: 0,
      chunkId: `dominant-${String(index).padStart(2, "0")}`,
      signals: [signal("passage_bm25", index + 1)]
    }));
    const minority = Array.from({ length: 60 }, (_, index) => candidate({
      bindingOrdinal: 1,
      chunkId: `minority-${String(index).padStart(2, "0")}`,
      signals: [signal("passage_bm25", index + 40)]
    }));
    const pool = selectKnowledgePreRerankPool({
      bindingOrdinals: [0, 1],
      candidates: [...dominant, ...minority],
      maximum: 96
    });
    const minorityCount = pool.filter((entry) => entry.bindingOrdinal === 1).length;
    expect(pool).toHaveLength(96);
    expect(minorityCount).toBeGreaterThanOrEqual(48);
  });

  it("deduplicates canonical content before the provider sees the pool", () => {
    const pool = selectKnowledgePreRerankPool({
      bindingOrdinals: [0],
      candidates: [
        candidate({ chunkId: "chunk-a", contentHash: "same".repeat(16) }),
        candidate({
          chunkId: "chunk-b",
          contentHash: "same".repeat(16),
          signals: [signal("passage_bm25", 9)]
        }),
        candidate({ chunkId: "chunk-c", contentHash: "diff".repeat(16) })
      ],
      maximum: 96
    });
    expect(pool.map((entry) => entry.chunkId).sort()).toEqual(["chunk-a", "chunk-c"]);
  });

  it("keeps an exact-bearing representative when duplicate content has stronger dense evidence", () => {
    const contentHash = "same".repeat(16);
    const pool = selectKnowledgePreRerankPool({
      bindingOrdinals: [0],
      candidates: [
        candidate({
          chunkId: "dense-duplicate",
          contentHash,
          signals: [
            signal("passage_bm25", 1),
            signal("passage_semantic", 1, { rawScore: 0.99, vectorDistance: 0.01 }),
            signal("metadata", 1)
          ]
        }),
        candidate({
          chunkId: "exact-duplicate",
          contentHash,
          signals: [signal("exact", 500, { rawScore: 0.001 })]
        })
      ],
      maximum: 96
    });
    expect(pool.map((entry) => entry.chunkId)).toEqual(["exact-duplicate"]);
  });

  it("returns the weighted RRF pre-order", () => {
    const first = candidate({ chunkId: "chunk-1", signals: [signal("exact", 1)] });
    const second = candidate({ chunkId: "chunk-2", signals: [signal("passage_bm25", 1)] });
    const third = candidate({ chunkId: "chunk-3", signals: [signal("passage_bm25", 5)] });
    const pool = selectKnowledgePreRerankPool({
      bindingOrdinals: [0],
      candidates: [third, first, second],
      maximum: 96
    });
    expect(pool.map((entry) => entry.chunkId))
      .toEqual(fuseKnowledgeCandidates([third, first, second]).map((entry) => entry.chunkId));
  });
});

describe("Post-rerank final ranking", () => {
  it("ranks by rerank score, then exact signal, then fused RRF, then chunk id", () => {
    const pool = fuseKnowledgeCandidates([
      candidate({ chunkId: "chunk-a", signals: [signal("passage_bm25", 1)] }),
      candidate({ chunkId: "chunk-b", signals: [signal("exact", 4)] }),
      candidate({ chunkId: "chunk-c", signals: [signal("passage_bm25", 2)] }),
      candidate({ chunkId: "chunk-d", signals: [signal("passage_bm25", 3)] })
    ]);
    const ordered = orderRerankedKnowledgeCandidates({
      pool,
      query: "unmatched",
      rerankScores: new Map([
        ["chunk-a", 0.4],
        ["chunk-b", 0.7],
        ["chunk-c", 0.7],
        ["chunk-d", 0.9]
      ])
    });
    // 0.9 first; the 0.7 tie prefers the exact-signal candidate; 0.4 last.
    expect(ordered.map((entry) => entry.chunkId))
      .toEqual(["chunk-d", "chunk-b", "chunk-c", "chunk-a"]);
    expect(ordered[0]!.rerankScore).toBe(0.9);
  });

  it("appends provider-omitted candidates after scored ones in deterministic RRF order", () => {
    const pool = fuseKnowledgeCandidates([
      candidate({ chunkId: "chunk-a", signals: [signal("passage_bm25", 1)] }),
      candidate({ chunkId: "chunk-b", signals: [signal("passage_bm25", 2)] }),
      candidate({ chunkId: "chunk-c", signals: [signal("passage_bm25", 3)] })
    ]);
    const ordered = orderRerankedKnowledgeCandidates({
      pool,
      query: "unmatched",
      rerankScores: new Map([["chunk-c", 0.1]])
    });
    expect(ordered.map((entry) => entry.chunkId)).toEqual(["chunk-c", "chunk-a", "chunk-b"]);
    expect(ordered.map((entry) => entry.rerankScore)).toEqual([0.1, null, null]);
  });

  it("rejects ineligible omissions before they can displace eligible evidence", () => {
    const pool = fuseKnowledgeCandidates([
      candidate({
        chunkId: "chunk-scored",
        signals: [signal("passage_semantic", 3, { rawScore: 0.1, vectorDistance: 0.9 })]
      }),
      candidate({
        chunkId: "chunk-rejected",
        signals: [signal("passage_semantic", 1, { rawScore: 0.1, vectorDistance: 0.9 })]
      }),
      candidate({
        chunkId: "chunk-eligible",
        signals: [
          signal("passage_bm25", 60, { rawScore: 0.2 }),
          signal("passage_semantic", 2, { rawScore: 0.1, vectorDistance: 0.9 })
        ]
      })
    ]);
    const ordered = orderRerankedKnowledgeCandidates({
      pool,
      query: "unmatched",
      rerankScores: new Map([["chunk-scored", -0.5]])
    });
    const selected = selectRerankedKnowledgeCandidates({
      candidates: ordered,
      resultLimit: 2
    });
    expect(ordered.map((entry) => entry.chunkId))
      .toEqual(["chunk-scored", "chunk-eligible"]);
    expect(ordered[0]!.signals).toHaveLength(1);
    expect(ordered[0]!.signals[0]!.lane).toBe("passage_semantic");
    expect(ordered[1]!.signals.map((entry) => entry.lane)).toEqual(["passage_bm25"]);
    expect(selected.map((entry) => entry.chunkId))
      .toEqual(["chunk-scored", "chunk-eligible"]);
  });

  it("keeps eligible BM25 and exact omissions after every scored candidate", () => {
    const pool = fuseKnowledgeCandidates([
      candidate({
        chunkId: "chunk-scored-low",
        signals: [signal("passage_semantic", 1, { rawScore: 0.1, vectorDistance: 0.9 })]
      }),
      candidate({ chunkId: "chunk-bm25", signals: [signal("passage_bm25", 1)] }),
      candidate({ chunkId: "chunk-exact", signals: [signal("exact", 50)] })
    ]);
    const ordered = orderRerankedKnowledgeCandidates({
      pool,
      query: "unmatched",
      rerankScores: new Map([["chunk-scored-low", -10]])
    });
    expect(ordered.map((entry) => entry.chunkId))
      .toEqual(["chunk-scored-low", "chunk-exact", "chunk-bm25"]);
    expect(ordered.map((entry) => entry.rerankScore)).toEqual([-10, null, null]);
  });

  it("applies content deduplication and the final result limit after reranking", () => {
    const pool = fuseKnowledgeCandidates(Array.from({ length: 20 }, (_, index) => candidate({
      chunkId: `chunk-${String(index).padStart(2, "0")}`,
      contentHash: index < 2 ? "dup".repeat(16) + "00" : `hash-${index}`,
      signals: [signal("passage_bm25", index + 1)]
    })));
    const ordered = orderRerankedKnowledgeCandidates({
      pool,
      query: "unmatched",
      rerankScores: new Map(pool.map((entry, index) => [entry.chunkId, 1 - index * 0.01]))
    });
    const selected = selectRerankedKnowledgeCandidates({
      candidates: ordered,
      resultLimit: 16
    });
    expect(selected).toHaveLength(16);
    expect(selected.filter((entry) => entry.contentHash.startsWith("dup"))).toHaveLength(1);
  });

  it("applies soft Source diversity only inside the narrow score band", () => {
    const sameSource = (chunkId: string) => ({
      ...candidate({ chunkId, source: "shared" }),
      chunkId
    });
    const pool = fuseKnowledgeCandidates([
      sameSource("chunk-a"),
      sameSource("chunk-b"),
      candidate({ chunkId: "chunk-near", source: "other" }),
      candidate({ chunkId: "chunk-far", source: "third" })
    ]);
    const withinBand = selectRerankedKnowledgeCandidates({
      candidates: orderRerankedKnowledgeCandidates({
        pool,
        query: "unmatched",
        rerankScores: new Map([
          ["chunk-a", 0.9],
          ["chunk-b", 0.89],
          ["chunk-near", 0.87],
          ["chunk-far", 0.2]
        ])
      }),
      resultLimit: 3
    });
    // The close alternative Source is promoted over the second same-Source hit.
    expect(withinBand.map((entry) => entry.chunkId))
      .toEqual(["chunk-a", "chunk-near", "chunk-b"]);

    const outsideBand = selectRerankedKnowledgeCandidates({
      candidates: orderRerankedKnowledgeCandidates({
        pool,
        query: "unmatched",
        rerankScores: new Map([
          ["chunk-a", 0.9],
          ["chunk-b", 0.88],
          ["chunk-near", 0.5],
          ["chunk-far", 0.2]
        ])
      }),
      resultLimit: 3
    });
    // A clearly weaker passage is never lifted above a stronger one.
    expect(outsideBand.map((entry) => entry.chunkId))
      .toEqual(["chunk-a", "chunk-b", "chunk-near"]);
  });

  it("never promotes an unscored candidate above a scored one", () => {
    const pool = fuseKnowledgeCandidates([
      candidate({ chunkId: "chunk-a", source: "shared" }),
      candidate({ chunkId: "chunk-b", source: "shared" }),
      candidate({ chunkId: "chunk-c", source: "other" })
    ]);
    const selected = selectRerankedKnowledgeCandidates({
      candidates: orderRerankedKnowledgeCandidates({
        pool,
        query: "unmatched",
        rerankScores: new Map([["chunk-a", 0.9], ["chunk-b", 0.89]])
      }),
      resultLimit: 2
    });
    expect(selected.map((entry) => entry.chunkId)).toEqual(["chunk-a", "chunk-b"]);
  });

  it("retains rare language-neutral query coverage after learned reranking", () => {
    const distractors = Array.from({ length: 20 }, (_, index) => candidate({
      chunkId: `generic-${String(index).padStart(2, "0")}`,
      source: `generic-${index}`,
      text: "rollout overview"
    }));
    const relevant = candidate({
      chunkId: "orion-evidence",
      source: "Orion",
      text: "rollout phase 2027 2026"
    });
    const pool = fuseKnowledgeCandidates([...distractors, relevant]);
    const rerankScores = new Map(pool.map((entry, index) => [
      entry.chunkId,
      entry.chunkId === relevant.chunkId ? 0.01 : 1 - index * 0.01
    ]));
    const ordered = orderRerankedKnowledgeCandidates({
      pool,
      query: "Orion rollout phase 2027 2026",
      rerankScores
    });
    const selected = selectRerankedKnowledgeCandidates({
      candidates: ordered,
      resultLimit: 16
    });
    expect(selected.map((entry) => entry.chunkId)).toContain("orion-evidence");
    expect(selected.find((entry) => entry.chunkId === "orion-evidence")?.rerankScore)
      .toBe(0.01);
  });
});
