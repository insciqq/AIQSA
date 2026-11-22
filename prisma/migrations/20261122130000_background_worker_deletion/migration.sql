-- The background worker that replaces the Memory coordinator for chat and account
-- deletion (operator decision 2026-11-22: Personal Memory is replaced). Deletion
-- obligations stay on the rows they concern: a Temporary chat's retention deadline
-- and a chat's permanent-deletion fence. This migration adds the worker's content-free
-- bookkeeping and heartbeat, and releases the chat guards from Memory's deletion
-- outbox, so the fence and a Temporary chat no longer need an outbox row.
--
-- Rollout: every change only adds a table or relaxes a guard. The previous release's
-- writers still create outbox rows and fence chats exactly as before, which every
-- relaxed rule still accepts, so they stay safe while Compose replaces containers.

-- CreateTable
CREATE TABLE "BackgroundWorkerHeartbeat" (
    "id" VARCHAR(64) NOT NULL,
    "instanceId" VARCHAR(128) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BackgroundWorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundWorkItem" (
    "duty" VARCHAR(64) NOT NULL,
    "itemId" VARCHAR(256) NOT NULL,
    "userId" TEXT NOT NULL,
    "leaseToken" VARCHAR(64),
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundWorkItem_pkey" PRIMARY KEY ("duty", "itemId"),
    CONSTRAINT "BackgroundWorkItem_shape_check" CHECK (
      "duty" ~ '^[a-z][a-z0-9_]{0,63}$'
      AND "attemptCount" >= 0
      AND num_nonnulls("leaseToken", "leaseExpiresAt") IN (0, 2)
      AND ("completedAt" IS NULL OR num_nonnulls("leaseToken", "nextAttemptAt") = 0)
      AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z][a-z0-9_]{0,63}$')
    )
);

-- CreateIndex
CREATE INDEX "BackgroundWorkItem_userId_idx" ON "BackgroundWorkItem"("userId");

-- CreateIndex
CREATE INDEX "BackgroundWorkItem_duty_completedAt_idx" ON "BackgroundWorkItem"("duty", "completedAt");

-- AddForeignKey
ALTER TABLE "BackgroundWorkItem" ADD CONSTRAINT "BackgroundWorkItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The permanent-deletion fence no longer names a Memory outbox row:
-- `permanentDeletionOperationId` becomes the deletion's own opaque id. A fence the
-- previous release set keeps the outbox id it has; nothing reads it as a reference.
ALTER TABLE "Chat" DROP CONSTRAINT "Chat_permanent_deletion_operation_fkey";

-- A fenced chat stays archived, but no longer has to become Excluded: changing the
-- mode would trip the old Memory history guards of a chat whose history is indexed,
-- and the fence alone already keeps the chat out of every list, search and new write.
ALTER TABLE "Chat" DROP CONSTRAINT "Chat_permanent_deletion_shape_check";
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_permanent_deletion_shape_check" CHECK (
  num_nonnulls("permanentDeletionAt", "permanentDeletionOperationId") IN (0, 2)
  AND ("permanentDeletionAt" IS NULL OR "archived" = true)
);

-- The fence stays immutable once set; it no longer requires an outbox row.
CREATE OR REPLACE FUNCTION public.aiqsa_permanent_chat_delete_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."permanentDeletionAt" IS NOT NULL AND (
    NEW."permanentDeletionAt" IS DISTINCT FROM OLD."permanentDeletionAt"
    OR NEW."permanentDeletionOperationId" IS DISTINCT FROM OLD."permanentDeletionOperationId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Permanent chat deletion fence is immutable';
  END IF;
  RETURN NEW;
END
$function$;

-- A Temporary chat no longer needs exactly one outbox obligation: its deadline is
-- the obligation, and the background worker finds due chats by it.
DROP TRIGGER "Chat_temporary_obligation_guard" ON "Chat";
DROP TRIGGER "Message_temporary_obligation_guard" ON "Message";
DROP TRIGGER "MemoryDeletionOutbox_temporary_chat_guard" ON "MemoryDeletionOutbox";
DROP FUNCTION public.aiqsa_temporary_chat_obligation_trigger();
DROP FUNCTION public.aiqsa_assert_temporary_chat_obligation(text, text);

-- A Temporary chat is deleted once its retention deadline has passed (the background
-- worker), or, as before, under a claimed outbox row (the previous release's worker,
-- and fixtures that still claim one; the outbox branch goes with the outbox table).
-- Deadlines are UTC timestamps without a zone.
CREATE OR REPLACE FUNCTION public.aiqsa_temporary_chat_delete_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."memoryMode" = 'TEMPORARY'
     AND NOT (
       OLD."temporaryRetentionDeadline" IS NOT NULL
       AND OLD."temporaryRetentionDeadline" <= (clock_timestamp() AT TIME ZONE 'UTC')
     )
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
      MESSAGE = 'Temporary chat is deleted only after its retention deadline';
  END IF;
  RETURN OLD;
END
$function$;
