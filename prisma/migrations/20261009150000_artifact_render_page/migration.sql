-- The render cache keeps each HTML page of a multi-page artifact under
-- (version, renderer version, page), for owner views and publications alike.
-- Every existing row is an entry-page render and keeps the empty page. Writers
-- of the previous release never set a page and look up only their own renderer
-- version. The cache is small derived data, so its index is rebuilt in place.

-- DropIndex
DROP INDEX "ArtifactRender_versionId_rendererVersion_key";

-- AlterTable
ALTER TABLE "ArtifactRender" ADD COLUMN "page" VARCHAR(192) NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactRender_versionId_rendererVersion_page_key" ON "ArtifactRender"("versionId", "rendererVersion", "page");
