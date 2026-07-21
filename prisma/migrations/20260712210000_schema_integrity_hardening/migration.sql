-- This migration deliberately does not rewrite ambiguous relationship, grant, or
-- lifecycle data. Existing invalid rows stop deployment with an actionable
-- preflight error so an operator can inspect and repair their source safely.

BEGIN;

DO $migration$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT child."id"
    FROM "Message" child
    JOIN "Message" parent ON parent."id" = child."parentMessageId"
    WHERE child."chatId" <> parent."chatId"
    ORDER BY child."id"
    LIMIT 10
  ) invalid;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'AIQSA schema integrity preflight failed: Message.parentMessageId crosses chat boundaries (sample message ids: %s).',
        invalid_ids
      ),
      HINT = 'Inspect each branch and assign a parent from the same chat, or clear the pointer only after confirming the intended branch root.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id)
  INTO invalid_ids
  FROM (
    SELECT chat."id"
    FROM "Chat" chat
    JOIN "Message" leaf ON leaf."id" = chat."activeLeafMessageId"
    WHERE leaf."chatId" <> chat."id"
    ORDER BY chat."id"
    LIMIT 10
  ) invalid;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'AIQSA schema integrity preflight failed: Chat.activeLeafMessageId crosses chat boundaries (sample chat ids: %s).',
        invalid_ids
      ),
      HINT = 'Point each chat at a message it owns, or clear the pointer only after confirming the intended empty branch.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg("id", ', ' ORDER BY "id")
  INTO invalid_ids
  FROM (
    SELECT "id"
    FROM "AccessGrant"
    WHERE num_nonnulls("userId", "groupId") <> 1
    ORDER BY "id"
    LIMIT 10
  ) invalid;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'AIQSA schema integrity preflight failed: AccessGrant must belong to exactly one user or group (sample grant ids: %s).',
        invalid_ids
      ),
      HINT = 'Choose the intended user or group principal; do not delete grants until their entitlement owner is understood.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg("id", ', ' ORDER BY "id")
  INTO invalid_ids
  FROM (
    SELECT "id"
    FROM "AccessGrant"
    WHERE NOT (
      (
        "provider" IS NOT NULL
        AND btrim("provider") <> ''
        AND "searchStrategy" IS NULL
        AND ("modelId" IS NULL OR btrim("modelId") <> '')
      )
      OR (
        "provider" IS NULL
        AND "modelId" IS NULL
        AND "searchStrategy" IS NOT NULL
        AND btrim("searchStrategy") <> ''
      )
    )
    ORDER BY "id"
    LIMIT 10
  ) invalid;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'AIQSA schema integrity preflight failed: AccessGrant has an empty or ambiguous provider/model/search target (sample grant ids: %s).',
        invalid_ids
      ),
      HINT = 'Use exactly one target shape: provider-wide, provider plus model, or search strategy.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  invalid_values TEXT;
BEGIN
  SELECT string_agg(status, ', ' ORDER BY status)
  INTO invalid_values
  FROM (
    SELECT DISTINCT "status" AS status
    FROM "Message"
    WHERE "status" NOT IN ('queued', 'streaming', 'in_progress', 'complete', 'cancelled', 'error')
  ) invalid;

  IF invalid_values IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('AIQSA schema integrity preflight failed: Message has unsupported statuses: %s.', invalid_values),
      HINT = 'Map only statuses whose lifecycle meaning is known; the migration will not guess a terminal state.';
  END IF;
END
$migration$;

-- in_progress was historically included in one shared active-status array for
-- messages and runs. It has the same non-terminal meaning as streaming for an
-- assistant message, and the current product contract does not expose it as a
-- persisted message state.
UPDATE "Message"
SET "status" = 'streaming'
WHERE "status" = 'in_progress';

DO $migration$
DECLARE
  invalid_values TEXT;
BEGIN
  SELECT string_agg(status, ', ' ORDER BY status)
  INTO invalid_values
  FROM (
    SELECT DISTINCT "status" AS status
    FROM "ModelRun"
    WHERE "status" NOT IN ('queued', 'streaming', 'in_progress', 'complete', 'cancelled', 'error')
  ) invalid;

  IF invalid_values IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('AIQSA schema integrity preflight failed: ModelRun has unsupported statuses: %s.', invalid_values),
      HINT = 'Map only statuses whose lifecycle meaning is known; the migration will not guess a terminal state.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  invalid_values TEXT;
BEGIN
  SELECT string_agg(status, ', ' ORDER BY status)
  INTO invalid_values
  FROM (
    SELECT DISTINCT "status" AS status
    FROM "SearchRun"
    WHERE "status" NOT IN ('complete', 'error')
  ) invalid;

  IF invalid_values IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('AIQSA schema integrity preflight failed: SearchRun has unsupported statuses: %s.', invalid_values),
      HINT = 'Current persisted search runs are terminal; inspect an unknown state before mapping it to complete or error.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  invalid_values TEXT;
BEGIN
  SELECT string_agg(status, ', ' ORDER BY status)
  INTO invalid_values
  FROM (
    SELECT DISTINCT "status" AS status
    FROM "Attachment"
    WHERE "status" NOT IN ('ready')
  ) invalid;

  IF invalid_values IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('AIQSA schema integrity preflight failed: Attachment has unsupported statuses: %s.', invalid_values),
      HINT = 'The current upload path persists only ready attachments; inspect unknown states instead of coercing them.';
  END IF;
END
$migration$;

-- PostgreSQL enum types make the current lifecycle vocabulary visible to both
-- Prisma and the database. The active-run indexes are recreated because their
-- text predicates depend on the old ModelRun.status type.
DROP INDEX "ModelRun_one_active_per_chat_idx";
DROP INDEX "ModelRun_status_idx";

CREATE TYPE "MessageStatus" AS ENUM ('queued', 'streaming', 'complete', 'cancelled', 'error');
CREATE TYPE "ModelRunStatus" AS ENUM ('queued', 'streaming', 'in_progress', 'complete', 'cancelled', 'error');
CREATE TYPE "SearchRunStatus" AS ENUM ('complete', 'error');
CREATE TYPE "AttachmentStatus" AS ENUM ('ready');

ALTER TABLE "Message" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Message"
  ALTER COLUMN "status" TYPE "MessageStatus" USING ("status"::"MessageStatus");
ALTER TABLE "Message" ALTER COLUMN "status" SET DEFAULT 'complete';

ALTER TABLE "ModelRun"
  ALTER COLUMN "status" TYPE "ModelRunStatus" USING ("status"::"ModelRunStatus");

ALTER TABLE "SearchRun"
  ALTER COLUMN "status" TYPE "SearchRunStatus" USING ("status"::"SearchRunStatus");

ALTER TABLE "Attachment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Attachment"
  ALTER COLUMN "status" TYPE "AttachmentStatus" USING ("status"::"AttachmentStatus");
ALTER TABLE "Attachment" ALTER COLUMN "status" SET DEFAULT 'ready';

CREATE INDEX "ModelRun_status_idx" ON "ModelRun"("status");
CREATE UNIQUE INDEX "ModelRun_one_active_per_chat_idx"
ON "ModelRun"("chatId")
WHERE "status" IN ('queued', 'streaming', 'in_progress');

-- Prisma declares these composite relations, while this migration supplies the
-- PostgreSQL 16 column-scoped SET NULL that Prisma cannot render safely. It
-- preserves Chat.id when a selected active leaf is deleted.
CREATE UNIQUE INDEX "Message_chatId_id_key" ON "Message"("chatId", "id");

ALTER TABLE "Message"
ADD CONSTRAINT "Message_chatId_parentMessageId_fkey"
FOREIGN KEY ("chatId", "parentMessageId") REFERENCES "Message"("chatId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "Chat"
ADD CONSTRAINT "Chat_id_activeLeafMessageId_fkey"
FOREIGN KEY ("id", "activeLeafMessageId") REFERENCES "Message"("chatId", "id")
ON DELETE SET NULL ("activeLeafMessageId") ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "AccessGrant"
ADD CONSTRAINT "AccessGrant_subject_check"
CHECK (num_nonnulls("userId", "groupId") = 1) NOT VALID;

ALTER TABLE "AccessGrant"
ADD CONSTRAINT "AccessGrant_target_check"
CHECK (
  (
    "provider" IS NOT NULL
    AND btrim("provider") <> ''
    AND "searchStrategy" IS NULL
    AND ("modelId" IS NULL OR btrim("modelId") <> '')
  )
  OR (
    "provider" IS NULL
    AND "modelId" IS NULL
    AND "searchStrategy" IS NOT NULL
    AND btrim("searchStrategy") <> ''
  )
) NOT VALID;

ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_chatId_parentMessageId_fkey";
ALTER TABLE "Chat" VALIDATE CONSTRAINT "Chat_id_activeLeafMessageId_fkey";
ALTER TABLE "AccessGrant" VALIDATE CONSTRAINT "AccessGrant_subject_check";
ALTER TABLE "AccessGrant" VALIDATE CONSTRAINT "AccessGrant_target_check";

-- The composite relations now supersede the original id-only foreign keys.
ALTER TABLE "Message" DROP CONSTRAINT "Message_parentMessageId_fkey";
ALTER TABLE "Chat" DROP CONSTRAINT "Chat_activeLeafMessageId_fkey";

COMMIT;
