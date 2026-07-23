ALTER TABLE "McpRevision"
ADD COLUMN "identityHash" TEXT;

UPDATE "McpRevision"
SET "identityHash" = "draftHash";

ALTER TABLE "McpRevision"
ALTER COLUMN "identityHash" SET NOT NULL;

DROP INDEX "McpRevision_serverId_draftHash_key";

CREATE UNIQUE INDEX "McpRevision_serverId_identityHash_key"
ON "McpRevision"("serverId", "identityHash");

CREATE INDEX "McpRevision_serverId_draftHash_idx"
ON "McpRevision"("serverId", "draftHash");
