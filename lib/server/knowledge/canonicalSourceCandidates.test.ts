import { describe, expect, it } from "vitest";
import {
  canonicalizeKnowledgeSourceArtifactCandidates,
  canonicalizeKnowledgeSourceCandidates
} from "./canonicalSourceCandidates";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRetrievalCandidate,
  KnowledgeRetrievalLane
} from "./retrievalRanking";

function signal(lane: KnowledgeRetrievalLane, rank: number): KnowledgeCandidateSignal {
  return {
    exactKind: lane === "exact" ? "identifier" : null,
    lane,
    rank,
    rawScore: 1,
    vectorDistance: lane === "passage_semantic" ? 0.1 : null,
    vectorMode: lane === "passage_semantic" ? "exact" : null
  };
}

function candidate(input: Readonly<{
  artifactId: string;
  baseName: string;
  bindingOrdinal: number;
  chunkId: string;
  knowledgeBaseId: string;
  signals: readonly KnowledgeCandidateSignal[];
  sourceId: string;
  sourceName?: string;
  sourceVersionId: string;
  versionNumber?: number;
}>): KnowledgeRetrievalCandidate {
  return {
    baseName: input.baseName,
    bindingOrdinal: input.bindingOrdinal,
    chunkId: input.chunkId,
    chunkIndex: 0,
    contentHash: "a".repeat(64),
    documentId: input.sourceId,
    documentVersionId: input.sourceVersionId,
    documentVersionNumber: input.versionNumber ?? 1,
    fileName: "shared-name.txt",
    headingPath: ["Policy"],
    knowledgeBaseId: input.knowledgeBaseId,
    layoutKind: "body",
    page: 1,
    sectionId: "section-1",
    signals: input.signals,
    sourceArtifactId: input.artifactId,
    sourceName: input.sourceName ?? "Shared name",
    text: "Canonical source evidence."
  };
}

describe("canonical Source candidates", () => {
  it("collapses duplicate artifact projections before structured or visual analysis", () => {
    const baseB = {
      artifactId: "artifact-x",
      baseName: "Base B",
      bindingOrdinal: 9,
      documentId: "source-x",
      documentVersionId: "version-x",
      knowledgeBaseId: "base-b",
      normalizedTextStorageKey: "normalized/x.json"
    };
    const baseA = {
      ...baseB,
      baseName: "Base A",
      bindingOrdinal: 2,
      knowledgeBaseId: "base-a"
    };

    const result = canonicalizeKnowledgeSourceArtifactCandidates([baseB, baseA]);

    expect(result.candidates).toEqual([baseA]);
    expect(result.sourceProvenance).toEqual([{
      artifactId: "artifact-x",
      bindings: [
        { baseName: "Base A", bindingOrdinal: 2, knowledgeBaseId: "base-a" },
        { baseName: "Base B", bindingOrdinal: 9, knowledgeBaseId: "base-b" }
      ],
      primaryBindingOrdinal: 2,
      sourceId: "source-x",
      sourceVersionId: "version-x"
    }]);
  });

  it("collapses A+B admission without duplicate ranking signals and retains sorted provenance", () => {
    const baseA = candidate({
      artifactId: "artifact-x",
      baseName: "Base A",
      bindingOrdinal: 2,
      chunkId: "chunk-x",
      knowledgeBaseId: "base-a",
      signals: [signal("passage_bm25", 7)],
      sourceId: "source-x",
      sourceVersionId: "version-x"
    });
    const baseB = candidate({
      artifactId: "artifact-x",
      baseName: "Base B",
      bindingOrdinal: 9,
      chunkId: "chunk-x",
      knowledgeBaseId: "base-b",
      signals: [signal("passage_bm25", 1), signal("passage_semantic", 1)],
      sourceId: "source-x",
      sourceVersionId: "version-x"
    });

    const result = canonicalizeKnowledgeSourceCandidates([baseB, baseA]);
    expect(result).toEqual(canonicalizeKnowledgeSourceCandidates([baseA, baseB]));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      baseName: "Base A",
      bindingOrdinal: 2,
      knowledgeBaseId: "base-a",
      signals: [{ lane: "passage_bm25", rank: 7 }]
    });
    expect(result.sourceProvenance).toEqual([{
      artifactId: "artifact-x",
      bindings: [
        { baseName: "Base A", bindingOrdinal: 2, knowledgeBaseId: "base-a" },
        { baseName: "Base B", bindingOrdinal: 9, knowledgeBaseId: "base-b" }
      ],
      primaryBindingOrdinal: 2,
      sourceId: "source-x",
      sourceVersionId: "version-x"
    }]);
  });

  it("does not merge equal display names across different Source versions", () => {
    const result = canonicalizeKnowledgeSourceCandidates([
      candidate({
        artifactId: "artifact-v1",
        baseName: "Base A",
        bindingOrdinal: 0,
        chunkId: "chunk-v1",
        knowledgeBaseId: "base-a",
        signals: [signal("passage_bm25", 1)],
        sourceId: "source-shared",
        sourceVersionId: "version-1"
      }),
      candidate({
        artifactId: "artifact-v2",
        baseName: "Base B",
        bindingOrdinal: 1,
        chunkId: "chunk-v2",
        knowledgeBaseId: "base-b",
        signals: [signal("passage_bm25", 1)],
        sourceId: "source-shared",
        sourceVersionId: "version-2",
        versionNumber: 2
      })
    ]);

    expect(result.candidates.map((entry) => entry.chunkId)).toEqual(["chunk-v1", "chunk-v2"]);
    expect(result.sourceProvenance.map((entry) => entry.sourceVersionId)).toEqual([
      "version-1",
      "version-2"
    ]);
  });
});
