-- Knowledge language-neutral generic lexical retrieval (PRD FR-9).
--
-- Removes the per-language English/Russian FTS architecture from the active
-- Knowledge hierarchical index tables: the generated per-language tsvector
-- columns, their GIN indexes, and the ru/en languageConfig routing column
-- with its enumerated CHECK clause. The generic weighted `simple` tsvector
-- stays the single lexical index for every language; the bounded `languages`
-- hint array stays as display/diagnostics metadata only. Pre-release forward
-- migration: no compatibility shim is retained for the dropped columns.

-- KnowledgeArtifactDocumentIndex ------------------------------------------
DROP INDEX "KADI_english_fts_idx";
DROP INDEX "KADI_russian_fts_idx";
ALTER TABLE "KnowledgeArtifactDocumentIndex"
  DROP CONSTRAINT "KnowledgeArtifactDocumentIndex_shape_check";
ALTER TABLE "KnowledgeArtifactDocumentIndex"
  DROP COLUMN "englishSearchVector",
  DROP COLUMN "russianSearchVector",
  DROP COLUMN "languageConfig";
ALTER TABLE "KnowledgeArtifactDocumentIndex"
  ADD CONSTRAINT "KnowledgeArtifactDocumentIndex_shape_check" CHECK (
    btrim("sourceName") <> ''
    AND btrim("fileName") <> ''
    AND "pageCount" >= 1
    AND cardinality("tags") <= 64
    AND cardinality("languages") <= 16
    AND cardinality("outline") <= 512
    AND cardinality("keywords") <= 64
    AND cardinality("entities") <= 64
    AND char_length("summary") <= 4000
    AND char_length("metadataText") <= 16384
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
  );

-- KnowledgeArtifactSectionIndex -------------------------------------------
DROP INDEX "KASI_english_fts_idx";
DROP INDEX "KASI_russian_fts_idx";
ALTER TABLE "KnowledgeArtifactSectionIndex"
  DROP CONSTRAINT "KnowledgeArtifactSectionIndex_shape_check";
ALTER TABLE "KnowledgeArtifactSectionIndex"
  DROP COLUMN "englishSearchVector",
  DROP COLUMN "russianSearchVector",
  DROP COLUMN "languageConfig";
ALTER TABLE "KnowledgeArtifactSectionIndex"
  ADD CONSTRAINT "KnowledgeArtifactSectionIndex_shape_check" CHECK (
    "ordinal" >= 0
    AND btrim("label") <> ''
    AND "page" >= 1
    AND "pageEnd" >= "page"
    AND "passageStart" >= 0
    AND "passageEnd" >= "passageStart"
    AND cardinality("headingPath") <= 16
    AND cardinality("keywords") <= 64
    AND cardinality("entities") <= 64
    AND cardinality("languages") <= 16
    AND cardinality("tags") <= 64
    AND char_length("summary") <= 4000
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
  );

-- KnowledgeArtifactPassageIndex -------------------------------------------
-- The new nullable layoutKind column replaces the English "Evidence layout:"
-- markers previously embedded in the dense embedding text (FR-12); current
-- builds always populate it, while legacy rows (NULL) resolve layout from
-- documentContext or the retired contextPrefix markers at read time.
DROP INDEX "KAPI_english_fts_idx";
DROP INDEX "KAPI_russian_fts_idx";
ALTER TABLE "KnowledgeArtifactPassageIndex"
  DROP CONSTRAINT "KnowledgeArtifactPassageIndex_shape_check";
ALTER TABLE "KnowledgeArtifactPassageIndex"
  DROP COLUMN "englishSearchVector",
  DROP COLUMN "russianSearchVector",
  DROP COLUMN "languageConfig";
ALTER TABLE "KnowledgeArtifactPassageIndex"
  ADD COLUMN "layoutKind" VARCHAR(32);
ALTER TABLE "KnowledgeArtifactPassageIndex"
  ADD CONSTRAINT "KnowledgeArtifactPassageIndex_shape_check" CHECK (
    "ordinal" >= 0
    AND "page" >= 1
    AND "pageEnd" >= "page"
    AND btrim("text") <> ''
    AND char_length("contextPrefix") <= 1024
    AND ("layoutKind" IS NULL OR "layoutKind" IN (
      'body', 'field_ambiguous', 'field_pair',
      'table_ambiguous', 'table_row', 'table_row_projection'
    ))
    AND cardinality("headingPath") <= 16
    AND cardinality("tags") <= 64
    AND cardinality("languages") <= 16
    AND "sourceBlockStart" >= 0
    AND "sourceBlockEnd" >= "sourceBlockStart"
    AND "tokenCount" >= 1
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
    AND btrim("embeddingTextHash") ~ '^[0-9a-f]{64}$'
  );
