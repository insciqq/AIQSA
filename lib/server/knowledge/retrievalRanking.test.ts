import { describe, expect, it } from "vitest";
import {
  boundKnowledgeCandidates,
  fuseKnowledgeCandidates,
  rankKnowledgeCandidates,
  type KnowledgeCandidateSignal,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalLane
} from "./retrievalRanking";

function signal(lane: KnowledgeRetrievalLane, rank: number): KnowledgeCandidateSignal {
  return {
    exactKind: lane === "exact" ? "identifier" : null,
    lane,
    rank,
    rawScore: 1,
    vectorDistance: lane === "passage_semantic" ? 0.05 : null,
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
    signals: input.signals ?? [signal("passage_lexical", 1)],
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
      signals: [signal("passage_lexical", index + 1)]
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
      signals: [signal("passage_lexical", 1), signal("passage_lexical", 2), signal("exact", 3)]
    })]);
    const [single] = fuseKnowledgeCandidates([candidate({
      chunkId: "c2",
      signals: [signal("passage_lexical", 1)]
    })]);
    expect(fused!.fusedScore).toBeGreaterThan(single!.fusedScore);
  });

  it("never drops a non-empty candidate pool because of a confidence threshold", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [candidate({
        chunkId: "weak",
        signals: [signal("neighbor", 999), signal("passage_semantic", 999)]
      })],
      resultLimit: 8
    });
    expect(result.selected.map((entry) => entry.chunkId)).toEqual(["weak"]);
    expect(result.evidence.candidateOrder).toEqual(["weak"]);
  });

  it("takes the best item from up to four Sources before global fill", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        candidate({ chunkId: "a1", source: "a", signals: [signal("exact", 1)] }),
        candidate({ chunkId: "a2", source: "a", signals: [signal("exact", 2)] }),
        candidate({ chunkId: "b1", source: "b", signals: [signal("passage_lexical", 1)] }),
        candidate({ chunkId: "c1", source: "c", signals: [signal("passage_lexical", 2)] }),
        candidate({ chunkId: "d1", source: "d", signals: [signal("passage_lexical", 3)] }),
        candidate({ chunkId: "e1", source: "e", signals: [signal("passage_lexical", 4)] })
      ],
      resultLimit: 5
    });
    expect(result.selected.slice(0, 4).map((entry) => entry.sourceName)).toEqual([
      "a", "b", "c", "d"
    ]);
  });

  it("caps each Source at three primary chunks when multiple Sources exist", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        ...Array.from({ length: 7 }, (_, index) => candidate({
          chunkId: `a${index}`,
          source: "a",
          signals: [signal("exact", index + 1)]
        })),
        candidate({ chunkId: "b1", source: "b", signals: [signal("passage_lexical", 1)] })
      ],
      resultLimit: 8
    });
    expect(result.selected.filter((entry) => entry.sourceName === "a")).toHaveLength(3);
    expect(result.selected.filter((entry) => entry.sourceName === "b")).toHaveLength(1);
  });

  it("shares one diversity slot and primary cap across compatible artifacts of one Source", async () => {
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
          signals: [signal("passage_lexical", 1)]
        })
      ],
      resultLimit: 8
    });

    expect(result.selected.slice(0, 2).map((entry) => entry.documentId)).toEqual([
      "source-a",
      "source-b"
    ]);
    expect(result.selected.filter((entry) => entry.documentId === "source-a")).toHaveLength(3);
    expect(new Set(result.selected
      .filter((entry) => entry.documentId === "source-a")
      .map((entry) => entry.sourceArtifactId))).toEqual(new Set([
      "artifact-a-v1",
      "artifact-a-v2"
    ]));
  });

  it("uses all slots for one Source, deduplicates content, and excludes neighbor-only rows", async () => {
    const result = await rankKnowledgeCandidates({
      candidates: [
        ...Array.from({ length: 8 }, (_, index) => candidate({
          chunkId: `a${index}`,
          contentHash: index === 7 ? "hash-a6" : `hash-a${index}`,
          source: "a",
          signals: [signal("passage_lexical", index + 1)]
        })),
        candidate({ chunkId: "neighbor", source: "a", signals: [signal("neighbor", 1)] })
      ],
      resultLimit: 8
    });
    expect(result.selected).toHaveLength(7);
    expect(result.selected.some((entry) => entry.chunkId === "neighbor")).toBe(false);
  });
});
