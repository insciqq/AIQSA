import { createHash } from "node:crypto";

export const AIQSA_OPENSEARCH_VERSION = "3.8.0" as const;
export const KNOWLEDGE_SEARCH_BACKEND_KIND = "opensearch_bm25_v1" as const;
export const KNOWLEDGE_SEARCH_INDEX_NAME = "aiqsa-knowledge-passages-v1" as const;
export const KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION = 1 as const;
export const KNOWLEDGE_SEARCH_MAPPING_VERSION = 1 as const;
export const KNOWLEDGE_SEARCH_ANALYZER_PROFILE = "standard_v1" as const;
export const KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS = 120_000;
export const KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT = 64;
export const KNOWLEDGE_SEARCH_MAX_QUERY_VARIANTS = 2;
export const KNOWLEDGE_SEARCH_MAX_MERGED_HITS =
  KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT * KNOWLEDGE_SEARCH_MAX_QUERY_VARIANTS;
export const KNOWLEDGE_SEARCH_BULK_MAX_DOCUMENTS = 500;
export const KNOWLEDGE_SEARCH_BULK_MAX_BYTES = 5 * 1024 * 1024;
export const KNOWLEDGE_SEARCH_QUERY_MAX_BYTES = 16 * 1024 * 1024;

export const KNOWLEDGE_SEARCH_FIELD_WEIGHTS = Object.freeze({
  body: 1,
  heading: 0.2,
  tableContext: 0.35
});

export const KNOWLEDGE_SEARCH_INDEX_DEFINITION = Object.freeze({
  mappings: {
    _source: { enabled: false },
    dynamic: "strict",
    properties: {
      body: { analyzer: "standard", type: "text" },
      content_hash: { type: "keyword" },
      heading: { analyzer: "standard", type: "text" },
      index_artifact_id: { type: "keyword" },
      layout_kind: { type: "keyword" },
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
      similarity: {
        default: {
          b: 0.75,
          k1: 1.2,
          type: "BM25"
        }
      }
    }
  }
});

export type KnowledgeSearchDocument = Readonly<{
  body: string;
  contentHash: string;
  heading: string;
  indexArtifactId: string;
  layoutKind: string;
  ownerUserId: string;
  passageId: string;
  sourceVersionId: string;
  tableContext: string;
}>;

export type KnowledgeBm25Identity = Readonly<{
  contentHash: string;
  indexArtifactId: string;
  passageId: string;
  sourceVersionId: string;
}>;

export type KnowledgeBm25VariantHit = KnowledgeBm25Identity & Readonly<{
  rank: number;
  score: number;
}>;

export type KnowledgeBm25Hit = KnowledgeBm25Identity & Readonly<{
  rank: number;
  score: number;
}>;

export function knowledgeSearchDocumentId(input: KnowledgeBm25Identity): string {
  return `${input.indexArtifactId}:${input.passageId}`;
}

export function knowledgeSearchProjectionFingerprint(input: Readonly<{
  hierarchicalChecksum: string;
  indexArtifactId: string;
  passageCount: number;
}>): string {
  return createHash("sha256").update(JSON.stringify({
    backend: KNOWLEDGE_SEARCH_BACKEND_KIND,
    hierarchicalChecksum: input.hierarchicalChecksum,
    indexArtifactId: input.indexArtifactId,
    mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION,
    passageCount: input.passageCount,
    physicalIndexVersion: KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION,
    version: 1
  })).digest("hex");
}

export function mergeKnowledgeBm25Variants(
  variants: readonly (readonly KnowledgeBm25VariantHit[])[]
): readonly KnowledgeBm25Hit[] {
  if (variants.length < 1 || variants.length > KNOWLEDGE_SEARCH_MAX_QUERY_VARIANTS) {
    throw new Error("knowledge_search_query_variants_invalid");
  }
  const merged = new Map<string, {
    identity: KnowledgeBm25Identity;
    score: number;
  }>();
  for (const hits of variants) {
    if (hits.length > KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT) {
      throw new Error("knowledge_search_variant_hits_invalid");
    }
    for (const [index, hit] of hits.entries()) {
      if (hit.rank !== index + 1 || !Number.isFinite(hit.score) || hit.score < 0) {
        throw new Error("knowledge_search_variant_hits_invalid");
      }
      const key = JSON.stringify([
        hit.indexArtifactId,
        hit.passageId,
        hit.sourceVersionId,
        hit.contentHash
      ]);
      const existing = merged.get(key);
      const vote = 1 / (60 + hit.rank);
      if (existing) {
        existing.score += vote;
      } else {
        merged.set(key, {
          identity: {
            contentHash: hit.contentHash,
            indexArtifactId: hit.indexArtifactId,
            passageId: hit.passageId,
            sourceVersionId: hit.sourceVersionId
          },
          score: vote
        });
      }
    }
  }
  return Object.freeze([...merged.values()]
    .sort((left, right) => right.score - left.score ||
      knowledgeSearchDocumentId(left.identity).localeCompare(
        knowledgeSearchDocumentId(right.identity)
      ))
    // Each variant is already bounded. Preserve its candidates until the
    // common lexical/dense/exact pool is selected and reranked; applying one
    // variant's limit here silently discards the other query's evidence.
    .map((entry, index) => Object.freeze({
      ...entry.identity,
      rank: index + 1,
      score: entry.score
    })));
}
