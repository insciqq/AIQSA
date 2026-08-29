-- Automatic-search replay must retain the content-free identity of the
-- OpenSearch execution. Old rows remain unreadable by the V4 decoder when
-- this field is absent; no PostgreSQL lexical recovery path exists.
ALTER TABLE "KnowledgeRun"
  ADD COLUMN "lexicalBackendEvidence" JSONB;

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_lexical_backend_operation_check" CHECK (
    "lexicalBackendEvidence" IS NULL
    OR (
      operation = 'automatic_search'
      AND jsonb_typeof("lexicalBackendEvidence") = 'object'
      AND pg_column_size("lexicalBackendEvidence") <= 8192
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_lexical_backend_operation_check";
