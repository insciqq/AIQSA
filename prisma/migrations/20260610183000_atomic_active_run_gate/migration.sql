-- Denormalize run ownership so the database can enforce one active run per user.
ALTER TABLE "ModelRun" ADD COLUMN "userId" TEXT;

UPDATE "ModelRun"
SET "userId" = "Chat"."userId"
FROM "Chat"
WHERE "ModelRun"."chatId" = "Chat"."id";

ALTER TABLE "ModelRun" ALTER COLUMN "userId" SET NOT NULL;

-- A process boot with active rows means their in-process controllers are gone.
WITH orphaned_runs AS (
    UPDATE "ModelRun"
    SET
        "errorPayload" = '{"code":"run_orphaned_on_boot","message":"Run was active when this server process started and was marked failed."}'::jsonb,
        "status" = 'error'
    WHERE "status" IN ('queued', 'streaming', 'in_progress')
    RETURNING "assistantMessageId"
)
UPDATE "Message"
SET
    "errorMessage" = 'Run was active when this server process started and was marked failed.',
    "status" = 'error'
WHERE
    "id" IN (
        SELECT "assistantMessageId"
        FROM orphaned_runs
        WHERE "assistantMessageId" IS NOT NULL
    )
    AND "status" IN ('queued', 'streaming', 'in_progress');

CREATE INDEX "ModelRun_userId_createdAt_idx" ON "ModelRun"("userId", "createdAt");

CREATE UNIQUE INDEX "ModelRun_one_active_per_user_idx"
ON "ModelRun"("userId")
WHERE "status" IN ('queued', 'streaming', 'in_progress');

ALTER TABLE "ModelRun"
ADD CONSTRAINT "ModelRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
