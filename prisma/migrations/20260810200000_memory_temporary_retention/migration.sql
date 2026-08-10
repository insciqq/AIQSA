-- Admit Temporary only while a chat is still empty, bind its one durable
-- deletion obligation, and prevent bypassing that obligation on hard delete.
BEGIN;

CREATE OR REPLACE FUNCTION aiqsa_chat_memory_mode_guard() RETURNS trigger
LANGUAGE plpgsql AS $chat_memory_mode_guard$
BEGIN
  IF NEW."memoryMode" IS DISTINCT FROM OLD."memoryMode"
     AND (OLD."memoryMode" = 'TEMPORARY' OR NEW."memoryMode" = 'TEMPORARY') THEN
    IF OLD."memoryMode" <> 'NORMAL'
       OR NEW."memoryMode" <> 'TEMPORARY'
       OR OLD."activeLeafMessageId" IS NOT NULL
       OR OLD."archived"
       OR NEW."temporaryRetentionPolicyVersion" <> 'temporary-24h-v1'
       OR NEW."temporaryRetentionDeadline" IS NULL
       OR EXISTS (SELECT 1 FROM "Message" WHERE "chatId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "ModelRun" WHERE "chatId" = OLD."id") THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Temporary chat mode is immutable after first-send admission';
    END IF;
  END IF;

  IF OLD."memoryMode" = 'TEMPORARY'
     AND NEW."temporaryRetentionPolicyVersion"
         IS DISTINCT FROM OLD."temporaryRetentionPolicyVersion" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary retention policy is immutable after admission';
  END IF;

  RETURN NEW;
END
$chat_memory_mode_guard$;

-- The mode was feature-dark before this migration, but schema-level fixtures or
-- operator-owned rows may already exist. Adopt them into the reviewed deletion
-- contract instead of leaving an immutable Temporary row without a worker
-- obligation.
INSERT INTO "MemoryDeletionOutbox" (
  "id", "userId", "operation", "targetType", "targetId", "memoryGeneration",
  "state", "nextAttemptAt", "updatedAt"
)
SELECT
  md5('aiqsa-temporary-retention:' || chat."userId" || ':' || chat."id")::uuid::text,
  chat."userId", 'TEMPORARY_DELETE', 'TEMPORARY_CHAT@temporary-24h-v1', chat."id",
  0, 'PENDING', chat."temporaryRetentionDeadline", CURRENT_TIMESTAMP
FROM "Chat" AS chat
WHERE chat."memoryMode" = 'TEMPORARY'
  AND NOT EXISTS (
    SELECT 1
    FROM "MemoryDeletionOutbox" AS deletion
    WHERE deletion."userId" = chat."userId"
      AND deletion."operation" = 'TEMPORARY_DELETE'
      AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
      AND deletion."targetId" = chat."id"
      AND deletion."memoryGeneration" = 0
  );

UPDATE "MemoryDeletionOutbox" AS deletion
SET "completedAt" = NULL,
    "errorCode" = NULL,
    "leaseExpiresAt" = NULL,
    "leaseToken" = NULL,
    "nextAttemptAt" = chat."temporaryRetentionDeadline",
    "state" = 'PENDING',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Chat" AS chat
WHERE chat."memoryMode" = 'TEMPORARY'
  AND deletion."userId" = chat."userId"
  AND deletion."operation" = 'TEMPORARY_DELETE'
  AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
  AND deletion."targetId" = chat."id"
  AND deletion."memoryGeneration" = 0;

CREATE UNIQUE INDEX "MemoryDeletionOutbox_temporary_chat_key"
  ON "MemoryDeletionOutbox"("userId", "operation", "targetType", "targetId")
  WHERE "operation" = 'TEMPORARY_DELETE'
    AND "targetType" = 'TEMPORARY_CHAT@temporary-24h-v1';

CREATE FUNCTION aiqsa_temporary_chat_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $temporary_chat_delete_guard$
BEGIN
  IF OLD."memoryMode" = 'TEMPORARY'
     AND NOT EXISTS (
       SELECT 1
       FROM "MemoryDeletionOutbox" AS deletion
       WHERE deletion."userId" = OLD."userId"
         AND deletion."operation" = 'TEMPORARY_DELETE'
         AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
         AND deletion."targetId" = OLD."id"
         AND deletion."memoryGeneration" = 0
         AND deletion."state" = 'RUNNING'
         AND deletion."leaseToken" IS NOT NULL
         AND deletion."leaseExpiresAt" > CURRENT_TIMESTAMP
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary chat deletion requires its claimed durable obligation';
  END IF;
  RETURN OLD;
END
$temporary_chat_delete_guard$;

CREATE TRIGGER "Chat_temporary_delete_guard"
BEFORE DELETE ON "Chat"
FOR EACH ROW EXECUTE FUNCTION aiqsa_temporary_chat_delete_guard();

CREATE FUNCTION aiqsa_assert_temporary_chat_obligation(
  p_chat_id text,
  p_user_id text
) RETURNS void LANGUAGE plpgsql AS $temporary_chat_obligation$
DECLARE
  is_temporary boolean;
  obligation_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM "Chat" AS chat
    WHERE chat."id" = p_chat_id
      AND chat."userId" = p_user_id
      AND chat."memoryMode" = 'TEMPORARY'
  ) INTO is_temporary;

  IF NOT is_temporary THEN
    RETURN;
  END IF;

  SELECT count(*) INTO obligation_count
  FROM "MemoryDeletionOutbox" AS deletion
  WHERE deletion."userId" = p_user_id
    AND deletion."operation" = 'TEMPORARY_DELETE'
    AND deletion."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1'
    AND deletion."targetId" = p_chat_id
    AND deletion."memoryGeneration" = 0;

  IF obligation_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Temporary chat must have exactly one durable deletion obligation';
  END IF;
END
$temporary_chat_obligation$;

CREATE FUNCTION aiqsa_temporary_chat_obligation_trigger() RETURNS trigger
LANGUAGE plpgsql AS $temporary_chat_obligation_trigger$
DECLARE
  chat_id text;
  owner_id text;
BEGIN
  IF TG_TABLE_NAME = 'Chat' THEN
    IF TG_OP = 'DELETE' THEN
      chat_id := OLD."id";
      owner_id := OLD."userId";
    ELSE
      chat_id := NEW."id";
      owner_id := NEW."userId";
    END IF;
    IF owner_id IS NOT NULL THEN
      PERFORM aiqsa_assert_temporary_chat_obligation(chat_id, owner_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'Message' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      chat_id := OLD."chatId";
      SELECT "userId" INTO owner_id FROM "Chat" WHERE "id" = chat_id;
      IF owner_id IS NOT NULL THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(chat_id, owner_id);
      END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      chat_id := NEW."chatId";
      SELECT "userId" INTO owner_id FROM "Chat" WHERE "id" = chat_id;
      IF owner_id IS NOT NULL THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(chat_id, owner_id);
      END IF;
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      IF OLD."operation" = 'TEMPORARY_DELETE'
         AND OLD."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1' THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(
          OLD."targetId", OLD."userId"
        );
      END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      IF NEW."operation" = 'TEMPORARY_DELETE'
         AND NEW."targetType" = 'TEMPORARY_CHAT@temporary-24h-v1' THEN
        PERFORM aiqsa_assert_temporary_chat_obligation(
          NEW."targetId", NEW."userId"
        );
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$temporary_chat_obligation_trigger$;

CREATE CONSTRAINT TRIGGER "Chat_temporary_obligation_guard"
AFTER INSERT OR UPDATE OR DELETE ON "Chat"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_temporary_chat_obligation_trigger();

CREATE CONSTRAINT TRIGGER "Message_temporary_obligation_guard"
AFTER INSERT OR UPDATE OR DELETE ON "Message"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_temporary_chat_obligation_trigger();

CREATE CONSTRAINT TRIGGER "MemoryDeletionOutbox_temporary_chat_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryDeletionOutbox"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION aiqsa_temporary_chat_obligation_trigger();

-- Rollback guidance: stop app and Memory workers, verify no Temporary
-- chats exist, then drop these triggers/functions/index and restore the prior
-- all-transitions-immutable chat-mode guard. Never remove an outstanding
-- deletion obligation while its Temporary aggregate remains.

COMMIT;
