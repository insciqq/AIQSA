BEGIN;
CREATE TYPE "ChatContinuationWorkspaceSeedStatus" AS ENUM ('NO_SOURCE_DISK','CAPTURING','READY','TRANSFERRED','RESTORING','RESTORED','FAILED','ABANDONED');
CREATE TABLE "ChatContinuationWorkspaceSeed" (
  "id" TEXT NOT NULL,
  "continuationId" TEXT,
  "sourceChatId" TEXT,
  "newChatId" TEXT,
  "status" "ChatContinuationWorkspaceSeedStatus" NOT NULL DEFAULT 'CAPTURING',
  "failureCode" VARCHAR(64),
  "storageKey" TEXT,
  "checksum" CHAR(64),
  "byteSize" INTEGER,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" VARCHAR(64),
  "leaseExpiresAt" TIMESTAMP(3),
  "restoreStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatContinuationWorkspaceSeed_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatContinuationWorkspaceSeed_status_shape" CHECK (
    ("status" IN ('READY','TRANSFERRED','RESTORING','RESTORED') AND "storageKey" IS NOT NULL AND "checksum" IS NOT NULL AND "byteSize" IS NOT NULL AND "byteSize" > 0)
    OR ("status" IN ('NO_SOURCE_DISK','CAPTURING','FAILED','ABANDONED'))
  )
);
CREATE UNIQUE INDEX "ChatContinuationWorkspaceSeed_continuationId_key" ON "ChatContinuationWorkspaceSeed"("continuationId");
CREATE UNIQUE INDEX "ChatContinuationWorkspaceSeed_newChatId_key" ON "ChatContinuationWorkspaceSeed"("newChatId");
CREATE INDEX "ChatContinuationWorkspaceSeed_status_leaseExpiresAt_idx" ON "ChatContinuationWorkspaceSeed"("status", "leaseExpiresAt");
CREATE INDEX "ChatContinuationWorkspaceSeed_sourceChatId_status_idx" ON "ChatContinuationWorkspaceSeed"("sourceChatId", "status");
CREATE INDEX "ChatContinuationWorkspaceSeed_newChatId_status_idx" ON "ChatContinuationWorkspaceSeed"("newChatId", "status");
ALTER TABLE "ChatContinuationWorkspaceSeed" ADD CONSTRAINT "ChatContinuationWorkspaceSeed_continuationId_fkey"
  FOREIGN KEY ("continuationId") REFERENCES "ChatContinuation"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE "ChatContinuationWorkspaceSeed" ADD CONSTRAINT "ChatContinuationWorkspaceSeed_sourceChatId_fkey"
  FOREIGN KEY ("sourceChatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
ALTER TABLE "ChatContinuationWorkspaceSeed" ADD CONSTRAINT "ChatContinuationWorkspaceSeed_newChatId_fkey"
  FOREIGN KEY ("newChatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
CREATE FUNCTION abandon_continuation_workspace_seeds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ChatContinuationWorkspaceSeed" SET "status" = 'ABANDONED', "updatedAt" = CURRENT_TIMESTAMP
  WHERE ("sourceChatId" = OLD."id" AND "newChatId" IS NULL) OR "newChatId" = OLD."id";
  INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, "storageKey", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "ChatContinuationWorkspaceSeed"
  WHERE (("sourceChatId" = OLD."id" AND "newChatId" IS NULL) OR "newChatId" = OLD."id") AND "storageKey" IS NOT NULL
  ON CONFLICT ("storageKey") DO NOTHING;
  -- Detach before Chat's cascades run. Otherwise the continuation-delete
  -- trigger can update a seed while its source FK still points at the row
  -- already being deleted, before the queued SET NULL action reaches it.
  UPDATE "ChatContinuationWorkspaceSeed" SET "sourceChatId" = NULL
  WHERE "sourceChatId" = OLD."id";
  RETURN OLD;
END $$;
CREATE TRIGGER "Chat_abandon_continuation_workspace_seeds" BEFORE DELETE ON "Chat"
  FOR EACH ROW EXECUTE FUNCTION abandon_continuation_workspace_seeds();
CREATE FUNCTION abandon_deleted_continuation_workspace_seed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ChatContinuationWorkspaceSeed" SET "status" = 'ABANDONED', "updatedAt" = CURRENT_TIMESTAMP,
    "leaseToken" = NULL, "leaseExpiresAt" = NULL
  WHERE "continuationId" = OLD."id" AND "newChatId" IS NULL;
  INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, "storageKey", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "ChatContinuationWorkspaceSeed"
  WHERE "continuationId" = OLD."id" AND "newChatId" IS NULL AND "storageKey" IS NOT NULL
  ON CONFLICT ("storageKey") DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER "ChatContinuation_abandon_workspace_seed" BEFORE DELETE ON "ChatContinuation"
  FOR EACH ROW EXECUTE FUNCTION abandon_deleted_continuation_workspace_seed();
COMMIT;
