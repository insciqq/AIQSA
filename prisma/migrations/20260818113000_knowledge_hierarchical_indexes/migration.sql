CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "KnowledgeHierarchicalIndexState" AS ENUM ('building', 'ready', 'failed');
CREATE TYPE "KnowledgeExactEntryKind" AS ENUM (
  'date', 'filename', 'heading', 'identifier', 'number', 'tag', 'title'
);

CREATE TABLE "KnowledgeHierarchicalIndexArtifact" (
  "id" TEXT NOT NULL,
  "sourceArtifactId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "derivationMode" VARCHAR(32) NOT NULL,
  "state" "KnowledgeHierarchicalIndexState" NOT NULL DEFAULT 'building',
  "checksum" CHAR(64),
  "documentCount" INTEGER NOT NULL DEFAULT 0,
  "sectionCount" INTEGER NOT NULL DEFAULT 0,
  "passageCount" INTEGER NOT NULL DEFAULT 0,
  "exactEntryCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" VARCHAR(64),
  "readyAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeHierarchicalIndexArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeHierarchicalIndexArtifact_shape_check" CHECK (
    "schemaVersion" > 0
    AND "derivationMode" IN ('normalized_v2', 'legacy_chunks')
    AND "documentCount" >= 0
    AND "sectionCount" >= 0
    AND "passageCount" >= 0
    AND "exactEntryCount" >= 0
    AND ("checksum" IS NULL OR btrim("checksum") ~ '^[0-9a-f]{64}$')
    AND (
      "state" = 'building'::"KnowledgeHierarchicalIndexState"
        AND "checksum" IS NULL
        AND "readyAt" IS NULL
        AND "lastErrorCode" IS NULL
      OR "state" = 'ready'::"KnowledgeHierarchicalIndexState"
        AND "checksum" IS NOT NULL
        AND "readyAt" IS NOT NULL
        AND "lastErrorCode" IS NULL
        AND "documentCount" = 1
        AND "sectionCount" >= 1
        AND "passageCount" >= 1
        AND "exactEntryCount" >= 1
      OR "state" = 'failed'::"KnowledgeHierarchicalIndexState"
        AND "checksum" IS NULL
        AND "readyAt" IS NULL
        AND "lastErrorCode" IS NOT NULL
    )
  )
);

CREATE TABLE "KnowledgeArtifactDocumentIndex" (
  "indexArtifactId" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "title" TEXT,
  "description" TEXT NOT NULL DEFAULT '',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tagsText" TEXT NOT NULL DEFAULT '',
  "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "languageConfig" VARCHAR(16) NOT NULL,
  "documentType" VARCHAR(255) NOT NULL,
  "pageCount" INTEGER NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "outline" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "outlineText" TEXT NOT NULL DEFAULT '',
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "keywordsText" TEXT NOT NULL DEFAULT '',
  "entities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "entitiesText" TEXT NOT NULL DEFAULT '',
  "metadataText" TEXT NOT NULL DEFAULT '',
  "contentHash" CHAR(64) NOT NULL,
  "simpleSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' || coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig,
      coalesce("tagsText", '') || ' ' || coalesce("outlineText", '') || ' ' ||
      coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig,
      coalesce("description", '') || ' ' || coalesce("summary", '')), 'C')
  ) STORED,
  "englishSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' || coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig,
      coalesce("tagsText", '') || ' ' || coalesce("outlineText", '') || ' ' ||
      coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", '')), 'B') ||
    setweight(to_tsvector('english'::regconfig,
      coalesce("description", '') || ' ' || coalesce("summary", '')), 'C')
  ) STORED,
  "russianSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' || coalesce("title", '')), 'A') ||
    setweight(to_tsvector('russian'::regconfig,
      coalesce("tagsText", '') || ' ' || coalesce("outlineText", '') || ' ' ||
      coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", '')), 'B') ||
    setweight(to_tsvector('russian'::regconfig,
      coalesce("description", '') || ' ' || coalesce("summary", '')), 'C')
  ) STORED,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeArtifactDocumentIndex_pkey" PRIMARY KEY ("indexArtifactId"),
  CONSTRAINT "KnowledgeArtifactDocumentIndex_shape_check" CHECK (
    btrim("sourceName") <> ''
    AND btrim("fileName") <> ''
    AND "pageCount" >= 1
    AND "languageConfig" IN ('english', 'mixed', 'russian', 'unknown')
    AND cardinality("tags") <= 64
    AND cardinality("languages") <= 16
    AND cardinality("outline") <= 512
    AND cardinality("keywords") <= 64
    AND cardinality("entities") <= 64
    AND char_length("summary") <= 4000
    AND char_length("metadataText") <= 16384
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "KnowledgeArtifactSectionIndex" (
  "id" TEXT NOT NULL,
  "indexArtifactId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "headingText" TEXT NOT NULL DEFAULT '',
  "page" INTEGER NOT NULL,
  "pageEnd" INTEGER NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "keywordsText" TEXT NOT NULL DEFAULT '',
  "entities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "entitiesText" TEXT NOT NULL DEFAULT '',
  "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "languageConfig" VARCHAR(16) NOT NULL,
  "passageStart" INTEGER NOT NULL,
  "passageEnd" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "documentTitle" TEXT NOT NULL DEFAULT '',
  "sourceDescription" TEXT NOT NULL DEFAULT '',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tagsText" TEXT NOT NULL DEFAULT '',
  "contentHash" CHAR(64) NOT NULL,
  "simpleSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("documentTitle", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig,
      coalesce("headingText", '') || ' ' || coalesce("tagsText", '') || ' ' ||
      coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce("sourceDescription", '')), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce("summary", '')), 'D')
  ) STORED,
  "englishSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("documentTitle", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig,
      coalesce("headingText", '') || ' ' || coalesce("tagsText", '') || ' ' ||
      coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce("sourceDescription", '')), 'C') ||
    setweight(to_tsvector('english'::regconfig, coalesce("summary", '')), 'D')
  ) STORED,
  "russianSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("documentTitle", '')), 'A') ||
    setweight(to_tsvector('russian'::regconfig,
      coalesce("headingText", '') || ' ' || coalesce("tagsText", '') || ' ' ||
      coalesce("keywordsText", '') || ' ' || coalesce("entitiesText", '')), 'B') ||
    setweight(to_tsvector('russian'::regconfig, coalesce("sourceDescription", '')), 'C') ||
    setweight(to_tsvector('russian'::regconfig, coalesce("summary", '')), 'D')
  ) STORED,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeArtifactSectionIndex_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeArtifactSectionIndex_shape_check" CHECK (
    "ordinal" >= 0
    AND btrim("label") <> ''
    AND "page" >= 1
    AND "pageEnd" >= "page"
    AND "passageStart" >= 0
    AND "passageEnd" >= "passageStart"
    AND "languageConfig" IN ('english', 'mixed', 'russian', 'unknown')
    AND cardinality("headingPath") <= 16
    AND cardinality("keywords") <= 64
    AND cardinality("entities") <= 64
    AND cardinality("languages") <= 16
    AND cardinality("tags") <= 64
    AND char_length("summary") <= 4000
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "KnowledgeArtifactPassageIndex" (
  "id" TEXT NOT NULL,
  "indexArtifactId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "page" INTEGER NOT NULL,
  "pageEnd" INTEGER NOT NULL,
  "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "headingText" TEXT NOT NULL DEFAULT '',
  "text" TEXT NOT NULL,
  "contextPrefix" TEXT NOT NULL DEFAULT '',
  "fileName" TEXT NOT NULL,
  "sourceName" TEXT NOT NULL,
  "documentTitle" TEXT NOT NULL DEFAULT '',
  "sourceDescription" TEXT NOT NULL DEFAULT '',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tagsText" TEXT NOT NULL DEFAULT '',
  "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "languageConfig" VARCHAR(16) NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "embeddingTextHash" CHAR(64) NOT NULL,
  "sourceBlockStart" INTEGER NOT NULL,
  "sourceBlockEnd" INTEGER NOT NULL,
  "sourceBlockIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tokenCount" INTEGER NOT NULL,
  "simpleSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' ||
      coalesce("documentTitle", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig,
      coalesce("headingText", '') || ' ' || coalesce("tagsText", '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig,
      coalesce("contextPrefix", '') || ' ' || coalesce("sourceDescription", '')), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce("text", '')), 'D')
  ) STORED,
  "englishSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' ||
      coalesce("documentTitle", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig,
      coalesce("headingText", '') || ' ' || coalesce("tagsText", '')), 'B') ||
    setweight(to_tsvector('english'::regconfig,
      coalesce("contextPrefix", '') || ' ' || coalesce("sourceDescription", '')), 'C') ||
    setweight(to_tsvector('english'::regconfig, coalesce("text", '')), 'D')
  ) STORED,
  "russianSearchVector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian'::regconfig,
      coalesce("fileName", '') || ' ' || coalesce("sourceName", '') || ' ' ||
      coalesce("documentTitle", '')), 'A') ||
    setweight(to_tsvector('russian'::regconfig,
      coalesce("headingText", '') || ' ' || coalesce("tagsText", '')), 'B') ||
    setweight(to_tsvector('russian'::regconfig,
      coalesce("contextPrefix", '') || ' ' || coalesce("sourceDescription", '')), 'C') ||
    setweight(to_tsvector('russian'::regconfig, coalesce("text", '')), 'D')
  ) STORED,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeArtifactPassageIndex_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeArtifactPassageIndex_shape_check" CHECK (
    "ordinal" >= 0
    AND "page" >= 1
    AND "pageEnd" >= "page"
    AND btrim("text") <> ''
    AND char_length("contextPrefix") <= 1024
    AND "languageConfig" IN ('english', 'mixed', 'russian', 'unknown')
    AND cardinality("headingPath") <= 16
    AND cardinality("tags") <= 64
    AND cardinality("languages") <= 16
    AND "sourceBlockStart" >= 0
    AND "sourceBlockEnd" >= "sourceBlockStart"
    AND "tokenCount" >= 1
    AND btrim("contentHash") ~ '^[0-9a-f]{64}$'
    AND btrim("embeddingTextHash") ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "KnowledgeArtifactExactEntry" (
  "id" TEXT NOT NULL,
  "indexArtifactId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "kind" "KnowledgeExactEntryKind" NOT NULL,
  "value" TEXT NOT NULL,
  "normalizedValue" TEXT NOT NULL,
  "valueHash" CHAR(64) NOT NULL,
  "sectionId" TEXT,
  "passageId" TEXT,
  "page" INTEGER,
  "pageEnd" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeArtifactExactEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeArtifactExactEntry_shape_check" CHECK (
    "ordinal" >= 0
    AND btrim("value") <> ''
    AND btrim("normalizedValue") <> ''
    AND char_length("value") <= 512
    AND char_length("normalizedValue") <= 512
    AND btrim("valueHash") ~ '^[0-9a-f]{64}$'
    AND (("page" IS NULL AND "pageEnd" IS NULL)
      OR ("page" >= 1 AND "pageEnd" >= "page"))
    AND ("kind" NOT IN ('date', 'identifier', 'number') OR "passageId" IS NOT NULL)
    AND ("kind" <> 'heading' OR "sectionId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "KHI_source_artifact_version_key"
  ON "KnowledgeHierarchicalIndexArtifact"("sourceArtifactId", "schemaVersion");
CREATE INDEX "KHI_source_version_artifact_idx"
  ON "KnowledgeHierarchicalIndexArtifact"("sourceVersionId", "sourceArtifactId");
CREATE INDEX "KHI_state_version_created_idx"
  ON "KnowledgeHierarchicalIndexArtifact"("state", "schemaVersion", "createdAt");

CREATE UNIQUE INDEX "KASI_artifact_ordinal_key"
  ON "KnowledgeArtifactSectionIndex"("indexArtifactId", "ordinal");
CREATE UNIQUE INDEX "KASI_artifact_id_key"
  ON "KnowledgeArtifactSectionIndex"("indexArtifactId", "id");
CREATE INDEX "KASI_artifact_page_ordinal_idx"
  ON "KnowledgeArtifactSectionIndex"("indexArtifactId", "page", "ordinal");

CREATE UNIQUE INDEX "KAPI_artifact_ordinal_key"
  ON "KnowledgeArtifactPassageIndex"("indexArtifactId", "ordinal");
CREATE UNIQUE INDEX "KAPI_artifact_id_key"
  ON "KnowledgeArtifactPassageIndex"("indexArtifactId", "id");
CREATE INDEX "KAPI_section_ordinal_idx"
  ON "KnowledgeArtifactPassageIndex"("sectionId", "ordinal");
CREATE INDEX "KAPI_artifact_content_hash_idx"
  ON "KnowledgeArtifactPassageIndex"("indexArtifactId", "contentHash");
CREATE INDEX "KAPI_artifact_embedding_hash_idx"
  ON "KnowledgeArtifactPassageIndex"("indexArtifactId", "embeddingTextHash");

CREATE UNIQUE INDEX "KAEI_artifact_ordinal_key"
  ON "KnowledgeArtifactExactEntry"("indexArtifactId", "ordinal");
CREATE INDEX "KAEI_artifact_kind_value_idx"
  ON "KnowledgeArtifactExactEntry"("indexArtifactId", "kind", "normalizedValue");
CREATE INDEX "KAEI_passage_idx" ON "KnowledgeArtifactExactEntry"("passageId");
CREATE INDEX "KAEI_section_idx" ON "KnowledgeArtifactExactEntry"("sectionId");
CREATE INDEX "KAEI_normalized_value_trgm_idx"
  ON "KnowledgeArtifactExactEntry" USING gin ("normalizedValue" gin_trgm_ops);

CREATE INDEX "KADI_simple_fts_idx"
  ON "KnowledgeArtifactDocumentIndex" USING gin ("simpleSearchVector");
CREATE INDEX "KADI_english_fts_idx"
  ON "KnowledgeArtifactDocumentIndex" USING gin ("englishSearchVector");
CREATE INDEX "KADI_russian_fts_idx"
  ON "KnowledgeArtifactDocumentIndex" USING gin ("russianSearchVector");
CREATE INDEX "KASI_simple_fts_idx"
  ON "KnowledgeArtifactSectionIndex" USING gin ("simpleSearchVector");
CREATE INDEX "KASI_english_fts_idx"
  ON "KnowledgeArtifactSectionIndex" USING gin ("englishSearchVector");
CREATE INDEX "KASI_russian_fts_idx"
  ON "KnowledgeArtifactSectionIndex" USING gin ("russianSearchVector");
CREATE INDEX "KAPI_simple_fts_idx"
  ON "KnowledgeArtifactPassageIndex" USING gin ("simpleSearchVector");
CREATE INDEX "KAPI_english_fts_idx"
  ON "KnowledgeArtifactPassageIndex" USING gin ("englishSearchVector");
CREATE INDEX "KAPI_russian_fts_idx"
  ON "KnowledgeArtifactPassageIndex" USING gin ("russianSearchVector");

ALTER TABLE "KnowledgeHierarchicalIndexArtifact"
  ADD CONSTRAINT "KHI_source_artifact_fkey"
  FOREIGN KEY ("sourceVersionId", "sourceArtifactId")
  REFERENCES "KnowledgeSourceIndexArtifact"("sourceVersionId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeArtifactDocumentIndex"
  ADD CONSTRAINT "KADI_index_artifact_fkey"
  FOREIGN KEY ("indexArtifactId") REFERENCES "KnowledgeHierarchicalIndexArtifact"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeArtifactSectionIndex"
  ADD CONSTRAINT "KASI_index_artifact_fkey"
  FOREIGN KEY ("indexArtifactId") REFERENCES "KnowledgeHierarchicalIndexArtifact"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeArtifactPassageIndex"
  ADD CONSTRAINT "KAPI_index_artifact_fkey"
  FOREIGN KEY ("indexArtifactId") REFERENCES "KnowledgeHierarchicalIndexArtifact"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeArtifactPassageIndex"
  ADD CONSTRAINT "KnowledgeArtifactPassageIndex_section_fkey"
  FOREIGN KEY ("indexArtifactId", "sectionId")
  REFERENCES "KnowledgeArtifactSectionIndex"("indexArtifactId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeArtifactExactEntry"
  ADD CONSTRAINT "KAEI_index_artifact_fkey"
  FOREIGN KEY ("indexArtifactId") REFERENCES "KnowledgeHierarchicalIndexArtifact"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeArtifactExactEntry"
  ADD CONSTRAINT "KnowledgeArtifactExactEntry_section_fkey"
  FOREIGN KEY ("indexArtifactId", "sectionId")
  REFERENCES "KnowledgeArtifactSectionIndex"("indexArtifactId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeArtifactExactEntry"
  ADD CONSTRAINT "KnowledgeArtifactExactEntry_passage_fkey"
  FOREIGN KEY ("indexArtifactId", "passageId")
  REFERENCES "KnowledgeArtifactPassageIndex"("indexArtifactId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "preventReadyKnowledgeHierarchicalIndexMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD."state" = 'ready' THEN
    RAISE EXCEPTION 'knowledge_hierarchical_index_ready_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "KnowledgeHierarchicalIndexArtifact_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeHierarchicalIndexArtifact"
FOR EACH ROW EXECUTE FUNCTION "preventReadyKnowledgeHierarchicalIndexMutation"();

CREATE FUNCTION "preventReadyKnowledgeHierarchicalChildMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_id TEXT;
  artifact_state "KnowledgeHierarchicalIndexState";
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  artifact_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."indexArtifactId" ELSE NEW."indexArtifactId" END;
  SELECT "state" INTO artifact_state
  FROM "KnowledgeHierarchicalIndexArtifact"
  WHERE "id" = artifact_id;
  IF artifact_state = 'ready' THEN
    RAISE EXCEPTION 'knowledge_hierarchical_index_child_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "KnowledgeArtifactDocumentIndex_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeArtifactDocumentIndex"
FOR EACH ROW EXECUTE FUNCTION "preventReadyKnowledgeHierarchicalChildMutation"();
CREATE TRIGGER "KnowledgeArtifactSectionIndex_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeArtifactSectionIndex"
FOR EACH ROW EXECUTE FUNCTION "preventReadyKnowledgeHierarchicalChildMutation"();
CREATE TRIGGER "KnowledgeArtifactPassageIndex_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeArtifactPassageIndex"
FOR EACH ROW EXECUTE FUNCTION "preventReadyKnowledgeHierarchicalChildMutation"();
CREATE TRIGGER "KnowledgeArtifactExactEntry_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeArtifactExactEntry"
FOR EACH ROW EXECUTE FUNCTION "preventReadyKnowledgeHierarchicalChildMutation"();
