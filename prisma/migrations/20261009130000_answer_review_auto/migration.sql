-- Automatic answer review: a chat's review choice and the default new chats
-- start with, and what an automatic session freezes at its user's send.
-- Expand only: previous-release writers never read or write the new columns,
-- every existing chat and setting starts off and every existing session is
-- manual. The JSON shapes are decoded strictly by the application; no CHECK
-- is added to the large live "Chat" table.

-- AlterEnum: the schema's order. Nothing below uses the new values, which
-- PostgreSQL allows only after this transaction commits.
ALTER TYPE "AnswerReviewStopReason" ADD VALUE 'unsupported' AFTER 'error';
ALTER TYPE "AnswerReviewStopReason" ADD VALUE 'time_limit' AFTER 'unsupported';

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "defaultAnswerReview" JSONB;

-- AlterTable
ALTER TABLE "Chat" ADD COLUMN "answerReviewConfig" JSONB;

-- AlterTable: an automatic session keeps the controls its send froze for
-- every step, and marks once that its end was handled; a manual one has
-- neither. A running session has not ended.
ALTER TABLE "AnswerReviewSession"
  ADD COLUMN "controls" JSONB,
  ADD COLUMN "endNotifiedAt" TIMESTAMP(3),
  ADD CONSTRAINT "AnswerReviewSession_auto_check" CHECK (
    (("mode" = 'auto') = ("controls" IS NOT NULL))
    AND ("controls" IS NULL OR jsonb_typeof("controls") = 'object')
    AND ("endNotifiedAt" IS NULL OR ("mode" = 'auto' AND "state" <> 'running'))
  );

-- CreateIndex: the driver's reconciler reads running and ended automatic sessions.
CREATE INDEX "AnswerReviewSession_mode_state_idx" ON "AnswerReviewSession"("mode", "state");
