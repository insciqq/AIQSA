CREATE TYPE "ArtifactKind" AS ENUM ('html', 'slides', 'game', 'svg', 'chart', 'image');
CREATE TYPE "ArtifactVersionStatus" AS ENUM ('PENDING', 'READY', 'FAILED');
CREATE TYPE "ArtifactPublicationStatus" AS ENUM ('PENDING', 'READY', 'REVOKED');

CREATE TABLE "Artifact" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "sourceChatId" TEXT,
  "title" VARCHAR(240) NOT NULL,
  "kind" "ArtifactKind" NOT NULL,
  "currentVersionId" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtifactVersion" (
  "id" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "kind" "ArtifactKind" NOT NULL,
  "entrypoint" VARCHAR(192),
  "manifest" JSONB NOT NULL,
  "bundleStorageKey" VARCHAR(512) NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "status" "ArtifactVersionStatus" NOT NULL DEFAULT 'PENDING',
  "sourceModelRunId" TEXT,
  "sourceToolCallId" TEXT,
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  CONSTRAINT "ArtifactVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ArtifactPublication" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "artifactVersionId" TEXT NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "bundleStorageKey" VARCHAR(512) NOT NULL,
  "publicManifest" JSONB NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "kind" "ArtifactKind" NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "status" "ArtifactPublicationStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArtifactPublication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArtifactVersion_bundleStorageKey_key" ON "ArtifactVersion"("bundleStorageKey");
CREATE UNIQUE INDEX "ArtifactVersion_sourceToolCallId_key" ON "ArtifactVersion"("sourceToolCallId");
CREATE UNIQUE INDEX "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");
CREATE UNIQUE INDEX "ArtifactVersion_artifactId_id_key" ON "ArtifactVersion"("artifactId", "id");
CREATE UNIQUE INDEX "ArtifactPublication_tokenHash_key" ON "ArtifactPublication"("tokenHash");
CREATE UNIQUE INDEX "ArtifactPublication_bundleStorageKey_key" ON "ArtifactPublication"("bundleStorageKey");
CREATE INDEX "Artifact_ownerUserId_updatedAt_idx" ON "Artifact"("ownerUserId", "updatedAt");
CREATE INDEX "Artifact_ownerUserId_archivedAt_updatedAt_idx" ON "Artifact"("ownerUserId", "archivedAt", "updatedAt");
CREATE INDEX "Artifact_sourceChatId_idx" ON "Artifact"("sourceChatId");
CREATE INDEX "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");
CREATE INDEX "ArtifactVersion_sourceModelRunId_idx" ON "ArtifactVersion"("sourceModelRunId");
CREATE INDEX "ArtifactVersion_sourceModelRunId_sourceToolCallId_idx" ON "ArtifactVersion"("sourceModelRunId", "sourceToolCallId");
CREATE INDEX "ArtifactVersion_status_createdAt_idx" ON "ArtifactVersion"("status", "createdAt");
CREATE INDEX "ArtifactPublication_ownerUserId_createdAt_idx" ON "ArtifactPublication"("ownerUserId", "createdAt");
CREATE INDEX "ArtifactPublication_artifactId_createdAt_idx" ON "ArtifactPublication"("artifactId", "createdAt");
CREATE INDEX "ArtifactPublication_artifactVersionId_idx" ON "ArtifactPublication"("artifactVersionId");
CREATE INDEX "ArtifactPublication_status_expiresAt_idx" ON "ArtifactPublication"("status", "expiresAt");

ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ArtifactVersion" ADD CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_version_artifact_match_fkey"
  FOREIGN KEY ("artifactId", "artifactVersionId") REFERENCES "ArtifactVersion"("artifactId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
