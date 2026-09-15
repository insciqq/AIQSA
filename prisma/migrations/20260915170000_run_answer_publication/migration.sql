ALTER TABLE "ModelRun"
  ADD COLUMN "answerCompletedAt" TIMESTAMP(3),
  ADD COLUMN "answerCompletionUsage" JSONB;

ALTER TABLE "ModelRun" ADD CONSTRAINT "ModelRun_answer_completion_usage_check"
  CHECK ("answerCompletionUsage" IS NULL OR "answerCompletedAt" IS NOT NULL);
