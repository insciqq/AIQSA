import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_SEARCH_INDEX_DEFINITION,
  KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS,
  knowledgeSearchDocumentId,
  knowledgeSearchProjectionFingerprint,
  mergeKnowledgeBm25Variants
} from "./contract";

describe("Knowledge OpenSearch contract", () => {
  it("owns one strict content-free-authority mapping with explicit BM25 settings", () => {
    expect(KNOWLEDGE_SEARCH_INDEX_DEFINITION).toMatchObject({
      mappings: {
        _source: { enabled: false },
        dynamic: "strict",
        properties: {
          body: { analyzer: "standard", type: "text" },
          content_hash: { type: "keyword" },
          heading: { analyzer: "standard", type: "text" },
          index_artifact_id: { type: "keyword" },
          mapping_version: { type: "keyword" },
          owner_user_id: { type: "keyword" },
          passage_id: { type: "keyword" },
          source_version_id: { type: "keyword" },
          table_context: { analyzer: "standard", type: "text" }
        }
      },
      settings: {
        index: {
          max_terms_count: KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS,
          number_of_replicas: 0,
          number_of_shards: 1,
          similarity: { default: { b: 0.75, k1: 1.2, type: "BM25" } }
        }
      }
    });
  });

  it("derives stable document and projection identities", () => {
    expect(knowledgeSearchDocumentId({
      contentHash: "a".repeat(64),
      indexArtifactId: "artifact-1",
      passageId: "passage-1",
      sourceVersionId: "source-version-1"
    })).toBe("artifact-1:passage-1");
    const input = {
      hierarchicalChecksum: "b".repeat(64),
      indexArtifactId: "artifact-1",
      passageCount: 12
    };
    expect(knowledgeSearchProjectionFingerprint(input)).toMatch(/^[0-9a-f]{64}$/u);
    expect(knowledgeSearchProjectionFingerprint(input)).toBe(
      knowledgeSearchProjectionFingerprint(input)
    );
    expect(knowledgeSearchProjectionFingerprint({ ...input, passageCount: 13 })).not.toBe(
      knowledgeSearchProjectionFingerprint(input)
    );
  });

  it("deduplicates query variants and fuses only their bounded ranks", () => {
    const identity = {
      contentHash: "a".repeat(64),
      indexArtifactId: "artifact-1",
      passageId: "passage-1",
      sourceVersionId: "source-version-1"
    };
    const second = {
      contentHash: "b".repeat(64),
      indexArtifactId: "artifact-1",
      passageId: "passage-2",
      sourceVersionId: "source-version-1"
    };
    const merged = mergeKnowledgeBm25Variants([
      [
        { ...identity, rank: 1, score: 8 },
        { ...second, rank: 2, score: 7 }
      ],
      [{ ...identity, rank: 1, score: 4 }]
    ]);
    expect(merged).toEqual([
      { ...identity, rank: 1, score: 2 / 61 },
      { ...second, rank: 2, score: 1 / 62 }
    ]);
  });

  it("rejects malformed rank sequences instead of repairing provider output", () => {
    expect(() => mergeKnowledgeBm25Variants([[{
      contentHash: "a".repeat(64),
      indexArtifactId: "artifact-1",
      passageId: "passage-1",
      rank: 2,
      score: 1,
      sourceVersionId: "source-version-1"
    }]])).toThrow("knowledge_search_variant_hits_invalid");
  });

  it("retains each query's unique candidates until the shared retrieval pool is selected", () => {
    const variant = (prefix: string) => Array.from({ length: 64 }, (_, index) => ({
      contentHash: "a".repeat(64), indexArtifactId: "artifact-1", sourceVersionId: "source-version-1",
      passageId: `${prefix}-${index}`, rank: index + 1, score: 64 - index
    }));
    const first = variant("first");
    const second = variant("second");
    const merged = mergeKnowledgeBm25Variants([first, second]);
    expect(new Set(merged.map(hit => hit.passageId))).toEqual(new Set([...first, ...second].map(hit => hit.passageId)));
    expect(merged.map(hit => hit.rank)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(mergeKnowledgeBm25Variants([first, first])).toHaveLength(64);
  });
});
