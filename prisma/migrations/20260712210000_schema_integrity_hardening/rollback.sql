-- Manual data-preserving schema rollback for 20260712210000_schema_integrity_hardening.
-- This preserves every row and restores the prior TEXT lifecycle columns. Quiesce
-- application writes and take the normal DB backup before running this file.
-- The known Message in_progress -> streaming normalization is not reversible.

BEGIN;

ALTER TABLE "Message"
ADD CONSTRAINT "Message_parentMessageId_fkey"
FOREIGN KEY ("parentMessageId") REFERENCES "Message"("id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_parentMessageId_fkey";

ALTER TABLE "Chat"
ADD CONSTRAINT "Chat_activeLeafMessageId_fkey"
FOREIGN KEY ("activeLeafMessageId") REFERENCES "Message"("id")
ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Chat" VALIDATE CONSTRAINT "Chat_activeLeafMessageId_fkey";

ALTER TABLE "Chat" DROP CONSTRAINT IF EXISTS "Chat_id_activeLeafMessageId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_chatId_parentMessageId_fkey";
ALTER TABLE "AccessGrant" DROP CONSTRAINT IF EXISTS "AccessGrant_subject_check";
ALTER TABLE "AccessGrant" DROP CONSTRAINT IF EXISTS "AccessGrant_target_check";
DROP INDEX IF EXISTS "Message_chatId_id_key";

DROP INDEX IF EXISTS "ModelRun_one_active_per_chat_idx";
DROP INDEX IF EXISTS "ModelRun_status_idx";

ALTER TABLE "Message" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Message" ALTER COLUMN "status" TYPE TEXT USING ("status"::TEXT);
ALTER TABLE "Message" ALTER COLUMN "status" SET DEFAULT 'complete';

ALTER TABLE "ModelRun" ALTER COLUMN "status" TYPE TEXT USING ("status"::TEXT);
ALTER TABLE "SearchRun" ALTER COLUMN "status" TYPE TEXT USING ("status"::TEXT);

ALTER TABLE "Attachment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Attachment" ALTER COLUMN "status" TYPE TEXT USING ("status"::TEXT);
ALTER TABLE "Attachment" ALTER COLUMN "status" SET DEFAULT 'ready';

CREATE INDEX "ModelRun_status_idx" ON "ModelRun"("status");
CREATE UNIQUE INDEX "ModelRun_one_active_per_chat_idx"
ON "ModelRun"("chatId")
WHERE "status" IN ('queued', 'streaming', 'in_progress');

DROP TYPE "AttachmentStatus";
DROP TYPE "SearchRunStatus";
DROP TYPE "ModelRunStatus";
DROP TYPE "MessageStatus";

COMMIT;
