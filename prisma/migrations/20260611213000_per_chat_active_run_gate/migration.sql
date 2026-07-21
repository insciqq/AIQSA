DROP INDEX IF EXISTS "ModelRun_one_active_per_user_idx";

CREATE UNIQUE INDEX "ModelRun_one_active_per_chat_idx"
ON "ModelRun"("chatId")
WHERE "status" IN ('queued', 'streaming', 'in_progress');
