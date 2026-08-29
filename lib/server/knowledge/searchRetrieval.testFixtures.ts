import {
  AIQSA_OPENSEARCH_VERSION,
  KNOWLEDGE_SEARCH_ANALYZER_PROFILE,
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION
} from "../search/opensearch/contract";
import { KNOWLEDGE_RANKING_PROFILE_VERSION } from "./retrievalRanking";
import type { KnowledgeLexicalBackendEvidenceV1 } from "./searchRetrieval";

export function knowledgeLexicalBackendEvidenceFixture(
  overrides: Partial<KnowledgeLexicalBackendEvidenceV1> = {}
): KnowledgeLexicalBackendEvidenceV1 {
  return {
    analyzerProfile: KNOWLEDGE_SEARCH_ANALYZER_PROFILE,
    backendKind: KNOWLEDGE_SEARCH_BACKEND_KIND,
    candidateCount: 1,
    canonicalRejectionCount: 0,
    durationMs: 2,
    mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION,
    openSearchVersion: AIQSA_OPENSEARCH_VERSION,
    physicalIndexVersion: KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION,
    projectionCompleteness: "complete",
    queryVariantCount: 1,
    rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
    requestId: "opensearch-request-1",
    status: "complete",
    timedOut: false,
    version: 1,
    ...overrides
  };
}
