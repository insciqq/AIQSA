CREATE TABLE "ArtifactBlob" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArtifactBlob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArtifactBlob_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ArtifactBlob_storageKey_key" ON "ArtifactBlob"("storageKey");
CREATE UNIQUE INDEX "ArtifactBlob_ownerUserId_sha256_key" ON "ArtifactBlob"("ownerUserId", "sha256");

CREATE TABLE "ArtifactVersionBlob" (
    "versionId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "path" VARCHAR(192) NOT NULL,
    CONSTRAINT "ArtifactVersionBlob_pkey" PRIMARY KEY ("versionId", "path"),
    CONSTRAINT "ArtifactVersionBlob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArtifactVersion"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "ArtifactVersionBlob_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "ArtifactBlob"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "ArtifactVersionBlob_blobId_idx" ON "ArtifactVersionBlob"("blobId");

CREATE TABLE "ArtifactRender" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "rendererVersion" INTEGER NOT NULL,
    "renderedStorageKey" VARCHAR(512) NOT NULL,
    "renderedChecksum" CHAR(64) NOT NULL,
    "renderedByteSize" INTEGER NOT NULL,
    "contentType" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArtifactRender_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ArtifactRender_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ArtifactVersion"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ArtifactRender_renderedStorageKey_key" ON "ArtifactRender"("renderedStorageKey");
CREATE UNIQUE INDEX "ArtifactRender_versionId_rendererVersion_key" ON "ArtifactRender"("versionId", "rendererVersion");
