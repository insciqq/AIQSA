CREATE TYPE "KnowledgeSourceArtifactState" AS ENUM ('pending', 'processing', 'ready', 'failed');

ALTER TABLE "KnowledgeBase"
  ADD COLUMN "sourceRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "KnowledgeBase_sourceRevision_check" CHECK ("sourceRevision" >= 0);

ALTER TABLE "KnowledgeRunBinding"
  ADD COLUMN "knowledgeBaseSnapshotId" TEXT;

CREATE TABLE "KnowledgeSource" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "currentVersionId" TEXT,
  "pendingVersionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeSource_name_check" CHECK (btrim("name") <> ''),
  CONSTRAINT "KnowledgeSource_version_check" CHECK ("version" > 0),
  CONSTRAINT "KnowledgeSource_tags_check" CHECK (array_position("tags", NULL) IS NULL),
  CONSTRAINT "KnowledgeSource_version_pointers_check" CHECK (
    "currentVersionId" IS NULL OR
    "pendingVersionId" IS NULL OR
    "currentVersionId" <> "pendingVersionId"
  )
);

CREATE TABLE "KnowledgeSourceVersion" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "originalStorageKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeSourceVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeSourceVersion_number_check" CHECK ("versionNumber" > 0),
  CONSTRAINT "KnowledgeSourceVersion_fileName_check" CHECK (btrim("fileName") <> ''),
  CONSTRAINT "KnowledgeSourceVersion_mimeType_check" CHECK (btrim("mimeType") <> ''),
  CONSTRAINT "KnowledgeSourceVersion_byteSize_check" CHECK ("byteSize" >= 0),
  CONSTRAINT "KnowledgeSourceVersion_checksum_check" CHECK (
    btrim("checksum") ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "KnowledgeSourceIndexArtifact" (
  "id" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "profileRevisionId" TEXT NOT NULL,
  "state" "KnowledgeSourceArtifactState" NOT NULL DEFAULT 'pending',
  "normalizedTextStorageKey" TEXT,
  "normalizedTextByteSize" INTEGER,
  "normalizedTextChecksum" CHAR(64),
  "pageCount" INTEGER,
  "chunkCount" INTEGER,
  "errorCode" VARCHAR(64),
  "readyAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeSourceIndexArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeSourceIndexArtifact_sizes_check" CHECK (
    ("normalizedTextByteSize" IS NULL OR "normalizedTextByteSize" >= 0) AND
    ("pageCount" IS NULL OR "pageCount" >= 0) AND
    ("chunkCount" IS NULL OR "chunkCount" >= 0)
  ),
  CONSTRAINT "KnowledgeSourceIndexArtifact_checksum_check" CHECK (
    "normalizedTextChecksum" IS NULL OR
    btrim("normalizedTextChecksum") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "KnowledgeSourceIndexArtifact_state_check" CHECK (
    (
      "state" IN ('pending', 'processing') AND
      "errorCode" IS NULL AND
      "readyAt" IS NULL
    ) OR (
      "state" = 'failed' AND
      "errorCode" IS NOT NULL AND
      "readyAt" IS NULL
    ) OR (
      "state" = 'ready' AND
      "errorCode" IS NULL AND
      "readyAt" IS NOT NULL AND
      "normalizedTextStorageKey" IS NOT NULL AND
      "normalizedTextByteSize" IS NOT NULL AND
      "normalizedTextChecksum" IS NOT NULL AND
      "chunkCount" IS NOT NULL
    )
  )
);

CREATE TABLE "KnowledgeBaseSource" (
  "knowledgeBaseId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeBaseSource_pkey" PRIMARY KEY ("knowledgeBaseId", "sourceId")
);

CREATE TABLE "KnowledgeBaseSnapshot" (
  "id" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "profileRevisionId" TEXT NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "sourceCount" INTEGER NOT NULL,
  "readySourceCount" INTEGER NOT NULL,
  "evidenceFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeBaseSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeBaseSnapshot_counts_check" CHECK (
    "sourceRevision" >= 0 AND
    "sourceCount" >= 0 AND
    "readySourceCount" >= 0 AND
    "readySourceCount" <= "sourceCount"
  ),
  CONSTRAINT "KnowledgeBaseSnapshot_fingerprint_check" CHECK (
    btrim("evidenceFingerprint") ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "KnowledgeBaseSnapshotSource" (
  "snapshotId" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeBaseSnapshotSource_pkey" PRIMARY KEY ("snapshotId", "sourceId"),
  CONSTRAINT "KnowledgeBaseSnapshotSource_ordinal_check" CHECK ("ordinal" >= 0)
);

CREATE TABLE "KnowledgeV1DocumentSourceMap" (
  "knowledgeBaseId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeV1DocumentSourceMap_pkey" PRIMARY KEY ("knowledgeBaseId", "documentId")
);

CREATE TABLE "KnowledgeV1DocumentVersionSourceMap" (
  "knowledgeBaseId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeV1DocumentVersionSourceMap_pkey" PRIMARY KEY ("knowledgeBaseId", "documentVersionId")
);

CREATE TABLE "KnowledgeV1GenerationArtifactMap" (
  "knowledgeBaseId" TEXT NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeV1GenerationArtifactMap_pkey" PRIMARY KEY ("indexGenerationId", "documentVersionId")
);

CREATE UNIQUE INDEX "KnowledgeSource_currentVersionId_key"
  ON "KnowledgeSource"("currentVersionId");
CREATE UNIQUE INDEX "KnowledgeSource_pendingVersionId_key"
  ON "KnowledgeSource"("pendingVersionId");
CREATE INDEX "KnowledgeSource_ownerUserId_name_idx"
  ON "KnowledgeSource"("ownerUserId", "name");
CREATE UNIQUE INDEX "KnowledgeSource_id_ownerUserId_key"
  ON "KnowledgeSource"("id", "ownerUserId");
CREATE UNIQUE INDEX "KnowledgeSource_id_currentVersionId_key"
  ON "KnowledgeSource"("id", "currentVersionId");
CREATE UNIQUE INDEX "KnowledgeSource_id_pendingVersionId_key"
  ON "KnowledgeSource"("id", "pendingVersionId");

CREATE INDEX "KnowledgeSourceVersion_originalStorageKey_idx"
  ON "KnowledgeSourceVersion"("originalStorageKey");
CREATE UNIQUE INDEX "KnowledgeSourceVersion_sourceId_versionNumber_key"
  ON "KnowledgeSourceVersion"("sourceId", "versionNumber");
CREATE UNIQUE INDEX "KnowledgeSourceVersion_sourceId_id_key"
  ON "KnowledgeSourceVersion"("sourceId", "id");
CREATE UNIQUE INDEX "KnowledgeSourceVersion_id_ownerUserId_key"
  ON "KnowledgeSourceVersion"("id", "ownerUserId");
CREATE UNIQUE INDEX "KnowledgeSourceVersion_sourceId_id_ownerUserId_key"
  ON "KnowledgeSourceVersion"("sourceId", "id", "ownerUserId");

CREATE INDEX "KnowledgeSourceIndexArtifact_profileRevisionId_state_idx"
  ON "KnowledgeSourceIndexArtifact"("profileRevisionId", "state");
CREATE UNIQUE INDEX "KnowledgeSourceIndexArtifact_sourceVersionId_profileRevisio_key"
  ON "KnowledgeSourceIndexArtifact"("sourceVersionId", "profileRevisionId");
CREATE UNIQUE INDEX "KnowledgeSourceIndexArtifact_sourceVersionId_id_key"
  ON "KnowledgeSourceIndexArtifact"("sourceVersionId", "id");

CREATE INDEX "KnowledgeBaseSource_sourceId_removedAt_idx"
  ON "KnowledgeBaseSource"("sourceId", "removedAt");
CREATE UNIQUE INDEX "KnowledgeBaseSource_knowledgeBaseId_sourceId_ownerUserId_key"
  ON "KnowledgeBaseSource"("knowledgeBaseId", "sourceId", "ownerUserId");

CREATE INDEX "KnowledgeBaseSnapshot_indexGenerationId_idx"
  ON "KnowledgeBaseSnapshot"("indexGenerationId");
CREATE INDEX "KnowledgeBaseSnapshot_profileRevisionId_idx"
  ON "KnowledgeBaseSnapshot"("profileRevisionId");
CREATE UNIQUE INDEX "KnowledgeBaseSnapshot_knowledgeBaseId_id_key"
  ON "KnowledgeBaseSnapshot"("knowledgeBaseId", "id");
CREATE UNIQUE INDEX "KnowledgeBaseSnapshot_knowledgeBaseId_evidenceFingerprint_key"
  ON "KnowledgeBaseSnapshot"("knowledgeBaseId", "evidenceFingerprint");

CREATE INDEX "KnowledgeBaseSnapshotSource_sourceId_sourceVersionId_idx"
  ON "KnowledgeBaseSnapshotSource"("sourceId", "sourceVersionId");
CREATE UNIQUE INDEX "KnowledgeBaseSnapshotSource_snapshotId_ordinal_key"
  ON "KnowledgeBaseSnapshotSource"("snapshotId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeBaseSnapshotSource_snapshotId_artifactId_key"
  ON "KnowledgeBaseSnapshotSource"("snapshotId", "artifactId");

CREATE INDEX "KnowledgeV1DocumentSourceMap_sourceId_idx"
  ON "KnowledgeV1DocumentSourceMap"("sourceId");
CREATE UNIQUE INDEX "KnowledgeV1DocumentSourceMap_documentId_key"
  ON "KnowledgeV1DocumentSourceMap"("documentId");
CREATE UNIQUE INDEX "KnowledgeV1DocumentSourceMap_knowledgeBaseId_documentId_sou_key"
  ON "KnowledgeV1DocumentSourceMap"("knowledgeBaseId", "documentId", "sourceId", "ownerUserId");

CREATE INDEX "KnowledgeV1DocumentVersionSourceMap_sourceId_sourceVersionI_idx"
  ON "KnowledgeV1DocumentVersionSourceMap"("sourceId", "sourceVersionId");
CREATE UNIQUE INDEX "KnowledgeV1DocumentVersionSourceMap_documentVersionId_key"
  ON "KnowledgeV1DocumentVersionSourceMap"("documentVersionId");
CREATE UNIQUE INDEX "KnowledgeV1VersionMap_document_version_key"
  ON "KnowledgeV1DocumentVersionSourceMap"("knowledgeBaseId", "documentId", "documentVersionId");
CREATE UNIQUE INDEX "KnowledgeV1VersionMap_source_version_key"
  ON "KnowledgeV1DocumentVersionSourceMap"("knowledgeBaseId", "documentVersionId", "sourceVersionId");

CREATE INDEX "KnowledgeV1GenerationArtifactMap_artifactId_idx"
  ON "KnowledgeV1GenerationArtifactMap"("artifactId");
CREATE INDEX "KnowledgeV1GenerationArtifactMap_knowledgeBaseId_documentVe_idx"
  ON "KnowledgeV1GenerationArtifactMap"("knowledgeBaseId", "documentVersionId");

CREATE UNIQUE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_documentId_id_key"
  ON "KnowledgeDocumentVersion"("knowledgeBaseId", "documentId", "id");
CREATE INDEX "KnowledgeRunBinding_knowledgeBaseSnapshotId_idx"
  ON "KnowledgeRunBinding"("knowledgeBaseSnapshotId");

ALTER TABLE "KnowledgeSource"
  ADD CONSTRAINT "KnowledgeSource_currentVersion_fkey"
  FOREIGN KEY ("id", "currentVersionId")
  REFERENCES "KnowledgeSourceVersion"("sourceId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeSource"
  ADD CONSTRAINT "KnowledgeSource_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeSource"
  ADD CONSTRAINT "KnowledgeSource_pendingVersion_fkey"
  FOREIGN KEY ("id", "pendingVersionId")
  REFERENCES "KnowledgeSourceVersion"("sourceId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeSourceVersion"
  ADD CONSTRAINT "KnowledgeSourceVersion_source_owner_fkey"
  FOREIGN KEY ("sourceId", "ownerUserId")
  REFERENCES "KnowledgeSource"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeSourceIndexArtifact"
  ADD CONSTRAINT "KnowledgeSourceIndexArtifact_profileRevisionId_fkey"
  FOREIGN KEY ("profileRevisionId") REFERENCES "KnowledgeIndexProfileRevision"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeSourceIndexArtifact"
  ADD CONSTRAINT "KnowledgeSourceIndexArtifact_sourceVersionId_fkey"
  FOREIGN KEY ("sourceVersionId") REFERENCES "KnowledgeSourceVersion"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeBaseSource"
  ADD CONSTRAINT "KnowledgeBaseSource_base_owner_fkey"
  FOREIGN KEY ("knowledgeBaseId", "ownerUserId")
  REFERENCES "KnowledgeBase"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSource"
  ADD CONSTRAINT "KnowledgeBaseSource_source_owner_fkey"
  FOREIGN KEY ("sourceId", "ownerUserId")
  REFERENCES "KnowledgeSource"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeBaseSnapshot"
  ADD CONSTRAINT "KnowledgeBaseSnapshot_generation_fkey"
  FOREIGN KEY ("knowledgeBaseId", "indexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSnapshot"
  ADD CONSTRAINT "KnowledgeBaseSnapshot_base_owner_fkey"
  FOREIGN KEY ("knowledgeBaseId", "ownerUserId")
  REFERENCES "KnowledgeBase"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSnapshot"
  ADD CONSTRAINT "KnowledgeBaseSnapshot_profileRevisionId_fkey"
  FOREIGN KEY ("profileRevisionId") REFERENCES "KnowledgeIndexProfileRevision"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeBaseSnapshotSource"
  ADD CONSTRAINT "KnowledgeBaseSnapshotSource_artifact_fkey"
  FOREIGN KEY ("sourceVersionId", "artifactId")
  REFERENCES "KnowledgeSourceIndexArtifact"("sourceVersionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSnapshotSource"
  ADD CONSTRAINT "KnowledgeBaseSnapshotSource_membership_fkey"
  FOREIGN KEY ("knowledgeBaseId", "sourceId", "ownerUserId")
  REFERENCES "KnowledgeBaseSource"("knowledgeBaseId", "sourceId", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSnapshotSource"
  ADD CONSTRAINT "KnowledgeBaseSnapshotSource_snapshot_fkey"
  FOREIGN KEY ("knowledgeBaseId", "snapshotId")
  REFERENCES "KnowledgeBaseSnapshot"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSnapshotSource"
  ADD CONSTRAINT "KnowledgeBaseSnapshotSource_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeBaseSnapshotSource"
  ADD CONSTRAINT "KnowledgeBaseSnapshotSource_version_owner_fkey"
  FOREIGN KEY ("sourceId", "sourceVersionId", "ownerUserId")
  REFERENCES "KnowledgeSourceVersion"("sourceId", "id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeV1DocumentSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentSourceMap_document_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentId")
  REFERENCES "KnowledgeDocument"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1DocumentSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentSourceMap_membership_fkey"
  FOREIGN KEY ("knowledgeBaseId", "sourceId", "ownerUserId")
  REFERENCES "KnowledgeBaseSource"("knowledgeBaseId", "sourceId", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1DocumentSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentSourceMap_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1DocumentSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentSourceMap_knowledgeBaseId_fkey"
  FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeV1DocumentVersionSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentVersionSourceMap_document_map_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentId", "sourceId", "ownerUserId")
  REFERENCES "KnowledgeV1DocumentSourceMap"("knowledgeBaseId", "documentId", "sourceId", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1DocumentVersionSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentVersionSourceMap_version_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentId", "documentVersionId")
  REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "documentId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1DocumentVersionSourceMap"
  ADD CONSTRAINT "KnowledgeV1DocumentVersionSourceMap_source_version_fkey"
  FOREIGN KEY ("sourceId", "sourceVersionId", "ownerUserId")
  REFERENCES "KnowledgeSourceVersion"("sourceId", "id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeV1GenerationArtifactMap"
  ADD CONSTRAINT "KnowledgeV1GenerationArtifactMap_artifact_fkey"
  FOREIGN KEY ("sourceVersionId", "artifactId")
  REFERENCES "KnowledgeSourceIndexArtifact"("sourceVersionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1GenerationArtifactMap"
  ADD CONSTRAINT "KnowledgeV1GenerationArtifactMap_version_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentVersionId")
  REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1GenerationArtifactMap"
  ADD CONSTRAINT "KnowledgeV1GenerationArtifactMap_generation_fkey"
  FOREIGN KEY ("knowledgeBaseId", "indexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeV1GenerationArtifactMap"
  ADD CONSTRAINT "KnowledgeV1GenerationArtifactMap_version_map_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentVersionId", "sourceVersionId")
  REFERENCES "KnowledgeV1DocumentVersionSourceMap"("knowledgeBaseId", "documentVersionId", "sourceVersionId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeRunBinding"
  ADD CONSTRAINT "KnowledgeRunBinding_snapshot_fkey"
  FOREIGN KEY ("knowledgeBaseId", "knowledgeBaseSnapshotId")
  REFERENCES "KnowledgeBaseSnapshot"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "bumpKnowledgeBaseSourceRevision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "KnowledgeBase"
  SET "sourceRevision" = "sourceRevision" + 1
  WHERE "id" = NEW."knowledgeBaseId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeBaseSource_insert_revision"
AFTER INSERT ON "KnowledgeBaseSource"
FOR EACH ROW EXECUTE FUNCTION "bumpKnowledgeBaseSourceRevision"();

CREATE TRIGGER "KnowledgeBaseSource_membership_revision"
AFTER UPDATE OF "removedAt" ON "KnowledgeBaseSource"
FOR EACH ROW
WHEN (OLD."removedAt" IS DISTINCT FROM NEW."removedAt")
EXECUTE FUNCTION "bumpKnowledgeBaseSourceRevision"();

CREATE FUNCTION "bumpKnowledgeSourceMembershipRevisions"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "KnowledgeBase" AS base
  SET "sourceRevision" = base."sourceRevision" + 1
  FROM "KnowledgeBaseSource" AS membership
  WHERE membership."knowledgeBaseId" = base."id"
    AND membership."sourceId" = NEW."id"
    AND membership."removedAt" IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeSource_currentVersion_revision"
AFTER UPDATE OF "currentVersionId" ON "KnowledgeSource"
FOR EACH ROW
WHEN (OLD."currentVersionId" IS DISTINCT FROM NEW."currentVersionId")
EXECUTE FUNCTION "bumpKnowledgeSourceMembershipRevisions"();

CREATE FUNCTION "preventKnowledgeSourceVersionMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'knowledge_source_version_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "KnowledgeSourceVersion_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeSourceVersion"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeSourceVersionMutation"();

CREATE FUNCTION "preventReadyKnowledgeSourceArtifactMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" = 'ready' THEN
    RAISE EXCEPTION 'knowledge_source_artifact_ready_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeSourceIndexArtifact_ready_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeSourceIndexArtifact"
FOR EACH ROW EXECUTE FUNCTION "preventReadyKnowledgeSourceArtifactMutation"();

CREATE FUNCTION "enforceKnowledgeBaseSourceHistory"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge_base_source_history_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."knowledgeBaseId" <> NEW."knowledgeBaseId" OR
     OLD."sourceId" <> NEW."sourceId" OR
     OLD."ownerUserId" <> NEW."ownerUserId" OR
     OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'knowledge_base_source_identity_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeBaseSource_history"
BEFORE UPDATE OR DELETE ON "KnowledgeBaseSource"
FOR EACH ROW EXECUTE FUNCTION "enforceKnowledgeBaseSourceHistory"();

CREATE FUNCTION "preventKnowledgeV1MappingMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'knowledge_v1_source_mapping_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "KnowledgeV1DocumentSourceMap_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeV1DocumentSourceMap"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeV1MappingMutation"();
CREATE TRIGGER "KnowledgeV1DocumentVersionSourceMap_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeV1DocumentVersionSourceMap"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeV1MappingMutation"();
CREATE TRIGGER "KnowledgeV1GenerationArtifactMap_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeV1GenerationArtifactMap"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeV1MappingMutation"();

CREATE FUNCTION "validateKnowledgeBaseSnapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  base_source_revision INTEGER;
  active_source_count INTEGER;
  generation_profile_revision_id TEXT;
  generation_status "KnowledgeIndexGenerationStatus";
BEGIN
  SELECT
    base."sourceRevision",
    (
      SELECT count(*)::integer
      FROM "KnowledgeBaseSource" AS membership
      WHERE membership."knowledgeBaseId" = base."id"
        AND membership."removedAt" IS NULL
    ),
    generation."profileRevisionId",
    generation."status"
  INTO
    base_source_revision,
    active_source_count,
    generation_profile_revision_id,
    generation_status
  FROM "KnowledgeBase" AS base
  INNER JOIN "KnowledgeIndexGeneration" AS generation
    ON generation."knowledgeBaseId" = base."id"
   AND generation."id" = NEW."indexGenerationId"
  WHERE base."id" = NEW."knowledgeBaseId"
    AND base."ownerUserId" = NEW."ownerUserId";

  IF NOT FOUND OR
     generation_status <> 'active' OR
     generation_profile_revision_id IS NULL OR
     generation_profile_revision_id <> NEW."profileRevisionId" OR
     base_source_revision <> NEW."sourceRevision" OR
     active_source_count <> NEW."sourceCount" THEN
    RAISE EXCEPTION 'knowledge_base_snapshot_evidence_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeBaseSnapshot_evidence"
BEFORE INSERT ON "KnowledgeBaseSnapshot"
FOR EACH ROW EXECUTE FUNCTION "validateKnowledgeBaseSnapshot"();

CREATE FUNCTION "validateKnowledgeBaseSnapshotSource"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_profile_revision_id TEXT;
  snapshot_owner_user_id TEXT;
  membership_removed_at TIMESTAMP(3);
  current_source_version_id TEXT;
  artifact_profile_revision_id TEXT;
  artifact_state "KnowledgeSourceArtifactState";
BEGIN
  SELECT
    snapshot."profileRevisionId",
    snapshot."ownerUserId",
    membership."removedAt",
    source."currentVersionId",
    artifact."profileRevisionId",
    artifact."state"
  INTO
    snapshot_profile_revision_id,
    snapshot_owner_user_id,
    membership_removed_at,
    current_source_version_id,
    artifact_profile_revision_id,
    artifact_state
  FROM "KnowledgeBaseSnapshot" AS snapshot
  INNER JOIN "KnowledgeBaseSource" AS membership
    ON membership."knowledgeBaseId" = NEW."knowledgeBaseId"
   AND membership."sourceId" = NEW."sourceId"
   AND membership."ownerUserId" = NEW."ownerUserId"
  INNER JOIN "KnowledgeSource" AS source
    ON source."id" = membership."sourceId"
   AND source."ownerUserId" = membership."ownerUserId"
  INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
    ON artifact."id" = NEW."artifactId"
   AND artifact."sourceVersionId" = NEW."sourceVersionId"
  WHERE snapshot."id" = NEW."snapshotId"
    AND snapshot."knowledgeBaseId" = NEW."knowledgeBaseId";

  IF NOT FOUND OR
     snapshot_owner_user_id <> NEW."ownerUserId" OR
     membership_removed_at IS NOT NULL OR
     current_source_version_id IS NULL OR
     current_source_version_id <> NEW."sourceVersionId" OR
     artifact_state <> 'ready' OR
     artifact_profile_revision_id <> snapshot_profile_revision_id THEN
    RAISE EXCEPTION 'knowledge_base_snapshot_source_evidence_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeBaseSnapshotSource_evidence"
BEFORE INSERT ON "KnowledgeBaseSnapshotSource"
FOR EACH ROW EXECUTE FUNCTION "validateKnowledgeBaseSnapshotSource"();

CREATE FUNCTION "validateKnowledgeBaseSnapshotReadyCount"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_snapshot_id TEXT;
  expected_ready_count INTEGER;
  actual_ready_count INTEGER;
BEGIN
  target_snapshot_id := CASE
    WHEN TG_TABLE_NAME = 'KnowledgeBaseSnapshot' THEN NEW."id"
    ELSE NEW."snapshotId"
  END;
  SELECT snapshot."readySourceCount"
  INTO expected_ready_count
  FROM "KnowledgeBaseSnapshot" AS snapshot
  WHERE snapshot."id" = target_snapshot_id;
  SELECT count(*)::integer
  INTO actual_ready_count
  FROM "KnowledgeBaseSnapshotSource" AS source
  WHERE source."snapshotId" = target_snapshot_id;
  IF expected_ready_count IS NULL OR expected_ready_count <> actual_ready_count THEN
    RAISE EXCEPTION 'knowledge_base_snapshot_ready_count_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "KnowledgeBaseSnapshot_ready_count"
AFTER INSERT ON "KnowledgeBaseSnapshot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateKnowledgeBaseSnapshotReadyCount"();
CREATE CONSTRAINT TRIGGER "KnowledgeBaseSnapshotSource_ready_count"
AFTER INSERT ON "KnowledgeBaseSnapshotSource"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validateKnowledgeBaseSnapshotReadyCount"();

CREATE FUNCTION "preventKnowledgeBaseSnapshotMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'knowledge_base_snapshot_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "KnowledgeBaseSnapshot_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeBaseSnapshot"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeBaseSnapshotMutation"();
CREATE TRIGGER "KnowledgeBaseSnapshotSource_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeBaseSnapshotSource"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeBaseSnapshotMutation"();
