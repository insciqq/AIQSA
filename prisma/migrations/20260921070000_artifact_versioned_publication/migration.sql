-- Additive defaults preserve historical snapshots and rolling old-writer INSERTs.
CREATE TYPE "ArtifactPublicationMode" AS ENUM ('SINGLE', 'VERSION_SET');
ALTER TABLE "ArtifactPublication"
  ADD COLUMN "mode" "ArtifactPublicationMode" NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "defaultVersionId" TEXT,
  ALTER COLUMN "artifactVersionId" DROP NOT NULL,
  ALTER COLUMN "bundleStorageKey" DROP NOT NULL,
  ALTER COLUMN "publicManifest" DROP NOT NULL,
  ALTER COLUMN "title" DROP NOT NULL,
  ALTER COLUMN "kind" DROP NOT NULL,
  ALTER COLUMN "checksum" DROP NOT NULL,
  ALTER COLUMN "byteSize" DROP NOT NULL,
  ADD CONSTRAINT "ArtifactPublication_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "ArtifactPublication_mode_shape_check" CHECK (
    ("mode" = 'SINGLE' AND "defaultVersionId" IS NULL AND "artifactVersionId" IS NOT NULL
      AND "bundleStorageKey" IS NOT NULL AND "publicManifest" IS NOT NULL AND "title" IS NOT NULL
      AND "kind" IS NOT NULL AND "checksum" IS NOT NULL AND "byteSize" IS NOT NULL)
    OR ("mode" = 'VERSION_SET' AND "defaultVersionId" IS NOT NULL AND "artifactVersionId" IS NULL
      AND "bundleStorageKey" IS NULL AND "publicManifest" IS NULL AND "title" IS NULL
      AND "kind" IS NULL AND "checksum" IS NULL AND "byteSize" IS NULL AND "status" <> 'PENDING')
  );
CREATE UNIQUE INDEX "Artifact_ownerUserId_id_key" ON "Artifact"("ownerUserId", "id");
CREATE UNIQUE INDEX "ArtifactPublication_artifactId_id_key" ON "ArtifactPublication"("artifactId", "id");
ALTER TABLE "ArtifactPublication" DROP CONSTRAINT "ArtifactPublication_artifactId_fkey",
  DROP CONSTRAINT "ArtifactPublication_artifactVersionId_fkey",
  ADD CONSTRAINT "ArtifactPublication_ownerUserId_artifactId_fkey"
    FOREIGN KEY ("ownerUserId", "artifactId") REFERENCES "Artifact"("ownerUserId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "ArtifactPublicationVersion" (
  "publicationId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "ArtifactPublicationVersion_pkey" PRIMARY KEY ("publicationId", "versionId"),
  CONSTRAINT "ArtifactPublicationVersion_position_check" CHECK ("position" BETWEEN 0 AND 99),
  CONSTRAINT "ArtifactPublicationVersion_artifactId_publicationId_fkey"
    FOREIGN KEY ("artifactId", "publicationId") REFERENCES "ArtifactPublication"("artifactId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ArtifactPublicationVersion_artifactId_versionId_fkey"
    FOREIGN KEY ("artifactId", "versionId") REFERENCES "ArtifactVersion"("artifactId", "id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX "ArtifactPublicationVersion_publicationId_position_key" ON "ArtifactPublicationVersion"("publicationId", "position");
CREATE INDEX "ArtifactPublicationVersion_artifactId_versionId_idx" ON "ArtifactPublicationVersion"("artifactId", "versionId");
-- Deferred membership permits atomic set creation/reorder and parent cascade;
-- every surviving set must remain nonempty with its default in that exact set.
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_id_defaultVersionId_fkey"
  FOREIGN KEY ("id", "defaultVersionId") REFERENCES "ArtifactPublicationVersion"("publicationId", "versionId")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION validate_artifact_publication_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ArtifactPublicationVersion" m
    JOIN "ArtifactPublication" p ON p.id = m."publicationId"
    JOIN "ArtifactVersion" v ON v.id = m."versionId"
    WHERE m."publicationId" = NEW."publicationId" AND m."versionId" = NEW."versionId"
      AND (p.mode <> 'VERSION_SET' OR v.status <> 'READY')
  ) THEN RAISE EXCEPTION 'artifact_publication_member_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "ArtifactPublicationVersion_ready_set_check"
AFTER INSERT OR UPDATE ON "ArtifactPublicationVersion" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_artifact_publication_member();
