-- Token-expand punctuation-delimited Knowledge metadata before generic FTS.
--
-- PostgreSQL's parser classifies values such as `annual-report_AON-2010.pdf`
-- as one host token. That makes a source identity present on every passage
-- invisible to ordinary queries such as `AON revenue 2010`. Canonical values
-- and exact-entry matching remain unchanged; only the generated generic
-- lexical projection replaces punctuation runs with spaces before tokenizing.
-- Existing index rows are recomputed by the generated-column rebuild, so this
-- correction does not require document parsing, chunking, or embedding again.

DROP INDEX "KADI_simple_fts_idx";
DROP INDEX "KASI_simple_fts_idx";
DROP INDEX "KAPI_simple_fts_idx";

ALTER TABLE "KnowledgeArtifactDocumentIndex"
  DROP COLUMN "simpleSearchVector",
  ADD COLUMN "simpleSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' ||
        coalesce("title", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'A') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("tagsText", '') || ' ' || coalesce("outlineText", '') || ' ' ||
        coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'B') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("description", '') || ' ' || coalesce("summary", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'C')
  ) STORED;

ALTER TABLE "KnowledgeArtifactSectionIndex"
  DROP COLUMN "simpleSearchVector",
  ADD COLUMN "simpleSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("fileName", '') || ' ' || coalesce("documentTitle", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'A') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("headingText", '') || ' ' || coalesce("tagsText", '') || ' ' ||
        coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'B') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(coalesce("sourceDescription", ''), '[[:punct:]]+', ' ', 'g')
    ), 'C') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(coalesce("summary", ''), '[[:punct:]]+', ' ', 'g')
    ), 'D')
  ) STORED;

ALTER TABLE "KnowledgeArtifactPassageIndex"
  DROP COLUMN "simpleSearchVector",
  ADD COLUMN "simpleSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' ||
        coalesce("documentTitle", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'A') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("headingText", '') || ' ' || coalesce("tagsText", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'B') ||
    setweight(to_tsvector('simple'::regconfig,
      regexp_replace(
        coalesce("contextPrefix", '') || ' ' || coalesce("sourceDescription", ''),
        '[[:punct:]]+', ' ', 'g'
      )), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce("text", '')), 'D')
  ) STORED;

CREATE INDEX "KADI_simple_fts_idx"
  ON "KnowledgeArtifactDocumentIndex" USING GIN ("simpleSearchVector");

CREATE INDEX "KASI_simple_fts_idx"
  ON "KnowledgeArtifactSectionIndex" USING GIN ("simpleSearchVector");

CREATE INDEX "KAPI_simple_fts_idx"
  ON "KnowledgeArtifactPassageIndex" USING GIN ("simpleSearchVector");
