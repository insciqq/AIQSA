import {
  AIQSA_OPENSEARCH_VERSION,
  KNOWLEDGE_SEARCH_ANALYZER_PROFILE,
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION,
  mergeKnowledgeBm25Variants,
  type KnowledgeBm25Hit
} from "../search/opensearch/contract";
import {
  createKnowledgeOpenSearchTransport,
  type AiqsaOpenSearchTransport
} from "../search/opensearch/transport";
import { KNOWLEDGE_RANKING_PROFILE_VERSION } from "./retrievalRanking";

export type KnowledgeLexicalBackendEvidenceV1 = Readonly<{
  analyzerProfile: typeof KNOWLEDGE_SEARCH_ANALYZER_PROFILE;
  backendKind: typeof KNOWLEDGE_SEARCH_BACKEND_KIND;
  candidateCount: number;
  canonicalRejectionCount: 0;
  durationMs: number;
  mappingVersion: typeof KNOWLEDGE_SEARCH_MAPPING_VERSION;
  openSearchVersion: typeof AIQSA_OPENSEARCH_VERSION;
  physicalIndexVersion: typeof KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION;
  projectionCompleteness: "complete";
  queryVariantCount: number;
  rankingProfileVersion: 4 | typeof KNOWLEDGE_RANKING_PROFILE_VERSION;
  requestId: string | null;
  status: "complete";
  timedOut: false;
  version: 1;
}>;

export type KnowledgePassageBm25Search = (input: Readonly<{
  indexArtifactIds: readonly string[];
  ownerUserId: string;
  queryVariants: readonly string[];
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  evidence: KnowledgeLexicalBackendEvidenceV1;
  hits: readonly KnowledgeBm25Hit[];
}>>;

function evidence(input: Readonly<{
  candidateCount: number;
  durationMs: number;
  queryVariantCount: number;
  requestId: string | null;
}>): KnowledgeLexicalBackendEvidenceV1 {
  return Object.freeze({
    analyzerProfile: KNOWLEDGE_SEARCH_ANALYZER_PROFILE,
    backendKind: KNOWLEDGE_SEARCH_BACKEND_KIND,
    candidateCount: input.candidateCount,
    canonicalRejectionCount: 0,
    durationMs: input.durationMs,
    mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION,
    openSearchVersion: AIQSA_OPENSEARCH_VERSION,
    physicalIndexVersion: KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION,
    projectionCompleteness: "complete",
    queryVariantCount: input.queryVariantCount,
    rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
    requestId: input.requestId,
    status: "complete",
    timedOut: false,
    version: 1
  });
}

export function createKnowledgePassageBm25Search(
  search: AiqsaOpenSearchTransport = createKnowledgeOpenSearchTransport()
): KnowledgePassageBm25Search {
  return async (input) => {
    const queryVariants = [...new Set(input.queryVariants.map((query) => query.trim()))]
      .filter(Boolean);
    if (input.indexArtifactIds.length === 0) {
      return Object.freeze({
        evidence: evidence({
          candidateCount: 0,
          durationMs: 0,
          queryVariantCount: queryVariants.length,
          requestId: null
        }),
        hits: Object.freeze([])
      });
    }
    const result = await search.searchKnowledgePassages({
      indexArtifactIds: input.indexArtifactIds,
      ownerUserId: input.ownerUserId,
      queryVariants,
      ...(input.signal ? { signal: input.signal } : {})
    });
    const hits = mergeKnowledgeBm25Variants(result.variants);
    return Object.freeze({
      evidence: evidence({
        candidateCount: hits.length,
        durationMs: result.durationMs,
        queryVariantCount: result.variants.length,
        requestId: result.opaqueId
      }),
      hits
    });
  };
}
