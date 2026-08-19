ALTER TABLE "KnowledgeDocumentVersion"
  ADD COLUMN "ingestWarningCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "KnowledgeSourceIndexArtifact"
  ADD COLUMN "warningCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "KnowledgeDocumentVersion"
  ADD CONSTRAINT "KnowledgeDocumentVersion_warning_codes_check" CHECK (
    cardinality("ingestWarningCodes") <= 10
    AND "ingestWarningCodes" <@ ARRAY[
      'embedded_object_unsupported',
      'low_ocr_confidence',
      'low_page_coverage',
      'low_text_density',
      'parser_fallback_failed',
      'partial_parse',
      'repeated_header_footer',
      'table_extraction_degraded',
      'truncated_oversized_section',
      'unreadable_pages'
    ]::TEXT[]
  );

ALTER TABLE "KnowledgeSourceIndexArtifact"
  ADD CONSTRAINT "KnowledgeSourceIndexArtifact_warning_codes_check" CHECK (
    cardinality("warningCodes") <= 10
    AND "warningCodes" <@ ARRAY[
      'embedded_object_unsupported',
      'low_ocr_confidence',
      'low_page_coverage',
      'low_text_density',
      'parser_fallback_failed',
      'partial_parse',
      'repeated_header_footer',
      'table_extraction_degraded',
      'truncated_oversized_section',
      'unreadable_pages'
    ]::TEXT[]
  );

DROP INDEX "KnowledgeChunk_searchVector_gin_idx";
ALTER TABLE "KnowledgeChunk" DROP COLUMN "searchVector";

ALTER TABLE "KnowledgeChunk"
  ADD COLUMN "pageEnd" INTEGER,
  ADD COLUMN "contextPrefix" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contentHash" CHAR(64),
  ADD COLUMN "embeddingTextHash" CHAR(64),
  ADD COLUMN "sourceBlockStart" INTEGER,
  ADD COLUMN "sourceBlockEnd" INTEGER,
  ADD COLUMN "sourceBlockIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "tokenCount" INTEGER;

UPDATE "KnowledgeChunk"
SET
  "pageEnd" = "page",
  "contentHash" = md5("text") || md5('content:' || "text"),
  "embeddingTextHash" = md5("text") || md5('embedding:' || "text"),
  "sourceBlockStart" = "chunkIndex",
  "sourceBlockEnd" = "chunkIndex",
  "tokenCount" = GREATEST(1, cardinality(regexp_split_to_array(btrim("text"), E'\\s+')));

ALTER TABLE "KnowledgeChunk"
  ALTER COLUMN "pageEnd" SET NOT NULL,
  ALTER COLUMN "contentHash" SET NOT NULL,
  ALTER COLUMN "embeddingTextHash" SET NOT NULL,
  ALTER COLUMN "sourceBlockStart" SET NOT NULL,
  ALTER COLUMN "sourceBlockEnd" SET NOT NULL,
  ALTER COLUMN "tokenCount" SET NOT NULL,
  ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple'::regconfig,
      CASE
        WHEN "contextPrefix" = '' THEN "text"
        ELSE "contextPrefix" || E'\n\n' || "text"
      END
    )
  ) STORED,
  ADD CONSTRAINT "KnowledgeChunk_v2_shape_check" CHECK (
    "page" >= 1
    AND "pageEnd" >= "page"
    AND "sourceBlockStart" >= 0
    AND "sourceBlockEnd" >= "sourceBlockStart"
    AND "tokenCount" >= 1
    AND char_length("contextPrefix") <= 1024
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
    AND btrim("embeddingTextHash") ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX "KnowledgeChunk_searchVector_gin_idx"
  ON "KnowledgeChunk" USING gin ("searchVector");
CREATE INDEX "KnowledgeChunk_indexGenerationId_embeddingTextHash_idx"
  ON "KnowledgeChunk"("indexGenerationId", "embeddingTextHash");
