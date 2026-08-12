BEGIN;

ALTER TABLE "Chat"
  ADD COLUMN "permanentDeletionAt" TIMESTAMP(3),
  ADD COLUMN "permanentDeletionOperationId" TEXT;

ALTER TABLE "MemoryEvent"
  ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);

ALTER TABLE "MemoryDeletionOutbox"
  ADD COLUMN "admissionAuthorizationId" TEXT,
  ADD COLUMN "admittedChatSourceRevision" INTEGER,
  ADD COLUMN "admittedActiveLeafMessageId" TEXT,
  ADD COLUMN "alsoForgetOriginMemories" BOOLEAN;

CREATE UNIQUE INDEX "Chat_permanentDeletionOperationId_key"
  ON "Chat"("permanentDeletionOperationId");
CREATE INDEX "Chat_userId_permanentDeletionAt_idx"
  ON "Chat"("userId", "permanentDeletionAt");
CREATE UNIQUE INDEX "MemoryDeletionOutbox_admissionAuthorizationId_key"
  ON "MemoryDeletionOutbox"("admissionAuthorizationId");
CREATE INDEX "MemoryDeletionOutbox_userId_operation_targetId_createdAt_idx"
  ON "MemoryDeletionOutbox"("userId", "operation", "targetId", "createdAt");

ALTER TABLE "Chat"
  ADD CONSTRAINT "Chat_permanent_deletion_operation_fkey"
    FOREIGN KEY ("userId", "permanentDeletionOperationId")
    REFERENCES "MemoryDeletionOutbox"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "Chat_permanent_deletion_shape_check"
    CHECK (
      num_nonnulls("permanentDeletionAt", "permanentDeletionOperationId") IN (0, 2)
      AND (
        "permanentDeletionAt" IS NULL
        OR (
          "archived" = TRUE
          AND "memoryMode" = 'EXCLUDED'::"MemoryChatMode"
        )
      )
    );

ALTER TABLE "MemoryEvent"
  ADD CONSTRAINT "MemoryEvent_deleted_source_shape_check"
    CHECK ("sourceDeletedAt" IS NULL OR "sourceChatId" IS NULL);

ALTER TABLE "MemoryDeletionOutbox"
  DROP CONSTRAINT "MemoryDeletionOutbox_shape_check",
  ADD CONSTRAINT "MemoryDeletionOutbox_shape_check"
    CHECK (
      "memoryGeneration" >= 0
      AND "attemptCount" >= 0
      AND (
        ("state" = 'RUNNING' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 2 AND "completedAt" IS NULL)
        OR ("state" IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_REQUIRES_ADMIN') AND num_nonnulls("leaseToken", "leaseExpiresAt", "completedAt") = 0)
        OR ("state" = 'SUCCEEDED' AND num_nonnulls("leaseToken", "leaseExpiresAt") = 0 AND "completedAt" IS NOT NULL AND "lastAuditAt" IS NOT NULL)
        OR ("state" = 'CANCELLED' AND num_nonnulls("leaseToken", "leaseExpiresAt", "nextAttemptAt") = 0 AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
      )
      AND (
        (
          "operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
          AND "targetType" = 'CHAT@memory-p8-chat-delete-v1'
          AND "admissionAuthorizationId" IS NOT NULL
          AND "admittedChatSourceRevision" >= 0
          AND "alsoForgetOriginMemories" IS NOT NULL
        )
        OR (
          NOT (
            "operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
            AND "targetType" = 'CHAT@memory-p8-chat-delete-v1'
          )
          AND num_nonnulls(
            "admissionAuthorizationId",
            "admittedChatSourceRevision",
            "admittedActiveLeafMessageId",
            "alsoForgetOriginMemories"
          ) = 0
        )
      )
    );

CREATE FUNCTION aiqsa_permanent_chat_delete_guard()
RETURNS trigger LANGUAGE plpgsql AS $permanent_chat_delete_guard$
BEGIN
  IF OLD."permanentDeletionAt" IS NOT NULL AND (
    NEW."permanentDeletionAt" IS DISTINCT FROM OLD."permanentDeletionAt"
    OR NEW."permanentDeletionOperationId" IS DISTINCT FROM OLD."permanentDeletionOperationId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanent chat deletion fence is immutable';
  END IF;

  IF NEW."permanentDeletionAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "MemoryDeletionOutbox" AS deletion
    WHERE deletion."userId" = NEW."userId"
      AND deletion."id" = NEW."permanentDeletionOperationId"
      AND deletion."operation" = 'SOURCE_PURGE'::"MemoryDeletionOperation"
      AND deletion."targetType" = 'CHAT@memory-p8-chat-delete-v1'
      AND deletion."targetId" = NEW."id"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanent chat deletion fence requires its exact durable operation';
  END IF;
  RETURN NEW;
END
$permanent_chat_delete_guard$;

CREATE TRIGGER "Chat_permanent_deletion_guard"
BEFORE UPDATE ON "Chat"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_delete_guard();

CREATE FUNCTION aiqsa_permanent_chat_child_write_guard()
RETURNS trigger LANGUAGE plpgsql AS $permanent_chat_child_write_guard$
BEGIN
  IF NEW."chatId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Chat"
    WHERE "id" = NEW."chatId" AND "permanentDeletionAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanently deleted chat cannot accept new aggregate children';
  END IF;
  RETURN NEW;
END
$permanent_chat_child_write_guard$;

CREATE TRIGGER "Message_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "Message"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "ModelRun_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "ModelRun"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "Attachment_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "Attachment"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "SharedChatSnapshot_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "SharedChatSnapshot"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryScope_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryScope"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "ChatMemoryCheckpoint_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "ChatMemoryCheckpoint"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryRecallChunk_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryRecallChunk"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryEpisode_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryEpisode"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryCandidate_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryCandidate"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryEvidence_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryEvidence"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryJob_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryJob"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE TRIGGER "MemoryRetrievalAttempt_permanent_chat_write_guard"
BEFORE INSERT OR UPDATE OF "chatId" ON "MemoryRetrievalAttempt"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();

CREATE FUNCTION aiqsa_permanent_chat_source_write_guard()
RETURNS trigger LANGUAGE plpgsql AS $permanent_chat_source_write_guard$
BEGIN
  IF NEW."sourceChatId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Chat"
    WHERE "id" = NEW."sourceChatId" AND "permanentDeletionAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanently deleted chat cannot become a reusable source';
  END IF;
  RETURN NEW;
END
$permanent_chat_source_write_guard$;

CREATE TRIGGER "MemoryEvent_permanent_chat_source_write_guard"
BEFORE INSERT OR UPDATE OF "sourceChatId" ON "MemoryEvent"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_write_guard();

CREATE TRIGGER "MemorySuppression_permanent_chat_source_write_guard"
BEFORE INSERT OR UPDATE OF "sourceChatId" ON "MemorySuppression"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_write_guard();

CREATE TRIGGER "MemoryMutationAuthorization_permanent_chat_source_write_guard"
BEFORE INSERT OR UPDATE OF "sourceChatId" ON "MemoryMutationAuthorization"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_write_guard();

CREATE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard()
RETURNS trigger LANGUAGE plpgsql AS $permanent_chat_source_snapshot_write_guard$
BEGIN
  IF NEW."sourceChatIdSnapshot" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Chat"
    WHERE "id" = NEW."sourceChatIdSnapshot" AND "permanentDeletionAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanently deleted chat cannot enter new source snapshots';
  END IF;
  RETURN NEW;
END
$permanent_chat_source_snapshot_write_guard$;

CREATE TRIGGER "MemoryRetrievalAttemptItem_permanent_source_write_guard"
BEFORE INSERT OR UPDATE OF "sourceChatIdSnapshot" ON "MemoryRetrievalAttemptItem"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard();

CREATE TRIGGER "ModelRunMemoryItem_permanent_source_write_guard"
BEFORE INSERT OR UPDATE OF "sourceChatIdSnapshot" ON "ModelRunMemoryItem"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard();

CREATE TRIGGER "MemoryFeedback_permanent_source_write_guard"
BEFORE INSERT OR UPDATE OF "sourceChatIdSnapshot" ON "MemoryFeedback"
FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_source_snapshot_write_guard();

CREATE FUNCTION aiqsa_memory_deletion_admission_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_deletion_admission_immutable_guard$
BEGIN
  IF (
    NEW."admissionAuthorizationId",
    NEW."admittedChatSourceRevision",
    NEW."admittedActiveLeafMessageId",
    NEW."alsoForgetOriginMemories"
  ) IS DISTINCT FROM (
    OLD."admissionAuthorizationId",
    OLD."admittedChatSourceRevision",
    OLD."admittedActiveLeafMessageId",
    OLD."alsoForgetOriginMemories"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Deletion admission metadata is immutable';
  END IF;
  RETURN NEW;
END
$memory_deletion_admission_immutable_guard$;

CREATE TRIGGER "MemoryDeletionOutbox_admission_immutable_guard"
BEFORE UPDATE ON "MemoryDeletionOutbox"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_deletion_admission_immutable_guard();

CREATE FUNCTION aiqsa_memory_event_deleted_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_event_deleted_source_guard$
BEGIN
  IF OLD."sourceDeletedAt" IS NOT NULL
    AND NEW."sourceDeletedAt" IS DISTINCT FROM OLD."sourceDeletedAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Deleted source lifecycle is immutable';
  END IF;
  IF NEW."sourceDeletedAt" IS NOT NULL
    AND (OLD."sourceChatId" IS NULL OR NEW."sourceChatId" IS NOT NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Deleted source lifecycle requires one-way source detachment';
  END IF;
  RETURN NEW;
END
$memory_event_deleted_source_guard$;

CREATE TRIGGER "MemoryEvent_deleted_source_guard"
BEFORE UPDATE ON "MemoryEvent"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_event_deleted_source_guard();

COMMIT;
