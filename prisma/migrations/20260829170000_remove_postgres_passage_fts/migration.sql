-- Passage lexical retrieval is owned exclusively by the derived OpenSearch
-- projection. PostgreSQL retains document/section routing, exact lookup, and
-- pgvector dense retrieval, but no hidden passage-FTS execution surface.
DROP INDEX "KAPI_simple_fts_idx";

ALTER TABLE "KnowledgeArtifactPassageIndex"
  DROP COLUMN "simpleSearchVector";
