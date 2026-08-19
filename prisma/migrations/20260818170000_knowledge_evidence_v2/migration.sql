ALTER TABLE "KnowledgeRun"
  ADD COLUMN "retrievalSessionId" TEXT;

CREATE TABLE "KnowledgeRetrievalSession" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 2,
  "originalIntent" JSONB NOT NULL,
  "scopeSnapshot" JSONB NOT NULL,
  "strategySnapshot" JSONB NOT NULL,
  "readinessSummary" JSONB NOT NULL,
  "coverageRequirements" JSONB NOT NULL,
  "degradedFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "citationContract" JSONB NOT NULL,
  "nextEvidenceOrdinal" INTEGER NOT NULL DEFAULT 1,
  "acceptedAt" TIMESTAMP(3),
  "receiptHash" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeRetrievalSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeRetrievalSession_modelRunId_key" UNIQUE ("modelRunId"),
  CONSTRAINT "KnowledgeRetrievalSession_shape_check" CHECK (
    "version" = 2
    AND "nextEvidenceOrdinal" BETWEEN 1 AND 2049
    AND (("acceptedAt" IS NULL AND "receiptHash" IS NULL)
      OR ("acceptedAt" IS NOT NULL AND "receiptHash" ~ '^[0-9a-f]{64}$'))
  ),
  CONSTRAINT "KnowledgeRetrievalSession_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "KnowledgeEvidenceItem" (
  "id" TEXT NOT NULL,
  "retrievalSessionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "handle" VARCHAR(8) NOT NULL,
  "evidenceKey" CHAR(64),
  "state" VARCHAR(16) NOT NULL DEFAULT 'available',
  "knowledgeBaseId" TEXT,
  "sourceId" TEXT,
  "sourceVersionId" TEXT,
  "sourceArtifactId" TEXT,
  "documentId" TEXT,
  "documentVersionId" TEXT,
  "sectionId" TEXT,
  "passageId" TEXT,
  "baseName" VARCHAR(1024),
  "sourceName" VARCHAR(1024),
  "fileName" VARCHAR(1024),
  "sourceVersionNumber" INTEGER,
  "excerpt" TEXT,
  "excerptBytes" INTEGER,
  "sourceTextBytes" INTEGER,
  "textTruncated" BOOLEAN,
  "page" INTEGER,
  "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "locator" JSONB,
  "contextBoundaries" JSONB,
  "contentHash" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeEvidenceItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeEvidenceItem_retrievalSessionId_ordinal_key"
    UNIQUE ("retrievalSessionId", "ordinal"),
  CONSTRAINT "KnowledgeEvidenceItem_retrievalSessionId_handle_key"
    UNIQUE ("retrievalSessionId", "handle"),
  CONSTRAINT "KnowledgeEvidenceItem_retrievalSessionId_evidenceKey_key"
    UNIQUE ("retrievalSessionId", "evidenceKey"),
  CONSTRAINT "KnowledgeEvidenceItem_shape_check" CHECK (
    "ordinal" BETWEEN 1 AND 2048
    AND "handle" = ('K' || "ordinal"::text)
    AND (
      ("state" = 'available'
        AND "evidenceKey" ~ '^[0-9a-f]{64}$'
        AND "knowledgeBaseId" IS NOT NULL
        AND "sourceVersionId" IS NOT NULL
        AND "documentVersionId" IS NOT NULL
        AND "passageId" IS NOT NULL
        AND "baseName" IS NOT NULL
        AND "fileName" IS NOT NULL
        AND "sourceVersionNumber" >= 1
        AND "excerpt" IS NOT NULL
        AND "excerptBytes" >= 0
        AND "sourceTextBytes" >= "excerptBytes"
        AND "textTruncated" = ("excerptBytes" < "sourceTextBytes")
        AND "page" >= 1)
      OR
      ("state" = 'deleted'
        AND "evidenceKey" IS NULL
        AND "knowledgeBaseId" IS NULL
        AND "sourceId" IS NULL
        AND "sourceVersionId" IS NULL
        AND "sourceArtifactId" IS NULL
        AND "documentId" IS NULL
        AND "documentVersionId" IS NULL
        AND "sectionId" IS NULL
        AND "passageId" IS NULL
        AND "baseName" IS NULL
        AND "sourceName" IS NULL
        AND "fileName" IS NULL
        AND "sourceVersionNumber" IS NULL
        AND "excerpt" IS NULL
        AND "excerptBytes" IS NULL
        AND "sourceTextBytes" IS NULL
        AND "textTruncated" IS NULL
        AND "page" IS NULL
        AND cardinality("headingPath") = 0
        AND "locator" IS NULL
        AND "contextBoundaries" IS NULL
        AND "contentHash" IS NULL)
    )
  ),
  CONSTRAINT "KnowledgeEvidenceItem_retrievalSessionId_fkey"
    FOREIGN KEY ("retrievalSessionId") REFERENCES "KnowledgeRetrievalSession"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE TABLE "KnowledgeRunEvidence" (
  "knowledgeRunId" TEXT NOT NULL,
  "evidenceItemId" TEXT NOT NULL,
  "resultOrdinal" INTEGER NOT NULL,
  "retrievalProvenance" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeRunEvidence_pkey" PRIMARY KEY ("knowledgeRunId", "evidenceItemId"),
  CONSTRAINT "KnowledgeRunEvidence_knowledgeRunId_resultOrdinal_key" UNIQUE ("knowledgeRunId", "resultOrdinal"),
  CONSTRAINT "KnowledgeRunEvidence_result_ordinal_check" CHECK ("resultOrdinal" BETWEEN 0 AND 7),
  CONSTRAINT "KnowledgeRunEvidence_knowledgeRunId_fkey"
    FOREIGN KEY ("knowledgeRunId") REFERENCES "KnowledgeRun"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "KnowledgeRunEvidence_evidenceItemId_fkey"
    FOREIGN KEY ("evidenceItemId") REFERENCES "KnowledgeEvidenceItem"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE TABLE "KnowledgeGroundingResult" (
  "retrievalSessionId" TEXT NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "originalAnswerHash" CHAR(64) NOT NULL,
  "finalAnswerHash" CHAR(64) NOT NULL,
  "issues" JSONB NOT NULL,
  "repairCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeGroundingResult_pkey" PRIMARY KEY ("retrievalSessionId"),
  CONSTRAINT "KnowledgeGroundingResult_shape_check" CHECK (
    "outcome" IN ('passed', 'repaired', 'no_answer')
    AND "originalAnswerHash" ~ '^[0-9a-f]{64}$'
    AND "finalAnswerHash" ~ '^[0-9a-f]{64}$'
    AND "repairCount" BETWEEN 0 AND 1
  ),
  CONSTRAINT "KnowledgeGroundingResult_retrievalSessionId_fkey"
    FOREIGN KEY ("retrievalSessionId") REFERENCES "KnowledgeRetrievalSession"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "KnowledgeRun_retrievalSessionId_idx" ON "KnowledgeRun"("retrievalSessionId");
CREATE INDEX "KnowledgeEvidenceItem_knowledgeBaseId_idx" ON "KnowledgeEvidenceItem"("knowledgeBaseId");
CREATE INDEX "KnowledgeEvidenceItem_sourceId_sourceVersionId_idx" ON "KnowledgeEvidenceItem"("sourceId", "sourceVersionId");
CREATE INDEX "KnowledgeEvidenceItem_documentVersionId_idx" ON "KnowledgeEvidenceItem"("documentVersionId");
CREATE INDEX "KnowledgeRunEvidence_evidenceItemId_idx" ON "KnowledgeRunEvidence"("evidenceItemId");

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_retrievalSessionId_fkey"
  FOREIGN KEY ("retrievalSessionId") REFERENCES "KnowledgeRetrievalSession"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

-- Accepted evidence is append-closed. The only in-place mutation path is the
-- explicit permanent-purge transaction, which first enables the same
-- transaction-local capability used by the Knowledge deletion subsystem.
-- Deleting an owning run/chat/account aggregate retains its ordinary cascade.
CREATE FUNCTION "guard_accepted_knowledge_session_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."acceptedAt" IS NOT NULL
    AND COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
    AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge evidence session is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeRetrievalSession_accepted_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeRetrievalSession"
FOR EACH ROW
EXECUTE FUNCTION "guard_accepted_knowledge_session_update"();

CREATE FUNCTION "guard_accepted_knowledge_evidence_item_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_id TEXT;
BEGIN
  session_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."retrievalSessionId"
    ELSE NEW."retrievalSessionId"
  END;
  IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
    AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
    AND EXISTS (
      SELECT 1
      FROM "KnowledgeRetrievalSession" AS session
      WHERE session."id" = session_id
        AND session."acceptedAt" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge evidence item is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeEvidenceItem_accepted_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeEvidenceItem"
FOR EACH ROW
EXECUTE FUNCTION "guard_accepted_knowledge_evidence_item_write"();

CREATE FUNCTION "guard_accepted_knowledge_run_evidence_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_id TEXT;
BEGIN
  item_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."evidenceItemId"
    ELSE NEW."evidenceItemId"
  END;
  IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
    AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
    AND EXISTS (
      SELECT 1
      FROM "KnowledgeEvidenceItem" AS item
      INNER JOIN "KnowledgeRetrievalSession" AS session
        ON session."id" = item."retrievalSessionId"
      WHERE item."id" = item_id
        AND session."acceptedAt" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge retrieval provenance is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeRunEvidence_accepted_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeRunEvidence"
FOR EACH ROW
EXECUTE FUNCTION "guard_accepted_knowledge_run_evidence_write"();

CREATE FUNCTION "guard_accepted_knowledge_run_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_id TEXT;
BEGIN
  session_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."retrievalSessionId"
    ELSE NEW."retrievalSessionId"
  END;
  IF session_id IS NOT NULL
    AND COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
    AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
    AND EXISTS (
      SELECT 1
      FROM "KnowledgeRetrievalSession" AS session
      WHERE session."id" = session_id
        AND session."acceptedAt" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge retrieval operation is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeRun_accepted_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeRun"
FOR EACH ROW
EXECUTE FUNCTION "guard_accepted_knowledge_run_write"();

CREATE FUNCTION "guard_accepted_knowledge_grounding_result_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
    AND NOT (TG_OP = 'DELETE' AND pg_trigger_depth() > 1)
    AND EXISTS (
      SELECT 1
      FROM "KnowledgeRetrievalSession" AS session
      WHERE session."id" = OLD."retrievalSessionId"
        AND session."acceptedAt" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'accepted Knowledge grounding result is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeGroundingResult_accepted_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeGroundingResult"
FOR EACH ROW
EXECUTE FUNCTION "guard_accepted_knowledge_grounding_result_write"();
