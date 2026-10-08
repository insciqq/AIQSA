-- Answer problem reports: a user tells administrators that an answer went
-- wrong, with a reason and an optional comment, never the question or the
-- answer. Expand only: previous-release writers never read or write the table.

-- CreateEnum
CREATE TYPE "AnswerProblemReportReason" AS ENUM ('wrong_or_made_up', 'did_not_follow_request', 'error_or_broken', 'too_slow', 'other');

-- CreateTable
CREATE TABLE "AnswerProblemReport" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "runId" TEXT,
    "userId" TEXT NOT NULL,
    "reason" "AnswerProblemReportReason" NOT NULL,
    "comment" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnswerProblemReport_pkey" PRIMARY KEY ("id"),
    -- The writer trims the comment and stores an empty one as null.
    CONSTRAINT "AnswerProblemReport_comment_check" CHECK ("comment" IS NULL OR length(btrim("comment")) > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "AnswerProblemReport_messageId_userId_key" ON "AnswerProblemReport"("messageId", "userId");

-- CreateIndex
CREATE INDEX "AnswerProblemReport_chatId_runId_idx" ON "AnswerProblemReport"("chatId", "runId");

-- CreateIndex
CREATE INDEX "AnswerProblemReport_updatedAt_idx" ON "AnswerProblemReport"("updatedAt");

-- CreateIndex
CREATE INDEX "AnswerProblemReport_userId_idx" ON "AnswerProblemReport"("userId");

-- AddForeignKey: deleting the answer (its chat or its branch) removes its reports.
ALTER TABLE "AnswerProblemReport" ADD CONSTRAINT "AnswerProblemReport_message_fkey" FOREIGN KEY ("chatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey: deleting the run clears only the report's run column.
ALTER TABLE "AnswerProblemReport" ADD CONSTRAINT "AnswerProblemReport_run_fkey" FOREIGN KEY ("chatId", "runId") REFERENCES "ModelRun"("chatId", "id") ON DELETE SET NULL ("runId") ON UPDATE RESTRICT;

-- AddForeignKey: deleting the reporting account removes its reports.
ALTER TABLE "AnswerProblemReport" ADD CONSTRAINT "AnswerProblemReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
