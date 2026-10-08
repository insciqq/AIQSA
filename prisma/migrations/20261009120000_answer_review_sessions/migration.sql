-- Cross-model answer review: reviewer models critique an answer and its
-- author model revises it, each step an ordinary run of a turn the server
-- writes. Expand only: previous-release writers never read or write the
-- table or the columns, and every existing message starts outside a session.
-- The step claim index on "Message" follows in its own concurrent migration.

-- CreateEnum
CREATE TYPE "AnswerReviewMode" AS ENUM ('manual', 'auto');

-- CreateEnum
CREATE TYPE "AnswerReviewState" AS ENUM ('running', 'finished', 'stopped');

-- CreateEnum
CREATE TYPE "AnswerReviewStopReason" AS ENUM ('clean', 'max_rounds', 'disagreement', 'budget', 'approval_required', 'user_stopped', 'superseded', 'review_unreadable', 'error');

-- AlterEnum: the schema's order. Nothing below uses the new values, which
-- PostgreSQL allows only after this transaction commits.
ALTER TYPE "MessageSystemTurnKind" ADD VALUE 'answer_review_request' AFTER 'mcp_approval_continuation';
ALTER TYPE "MessageSystemTurnKind" ADD VALUE 'answer_revision_request' AFTER 'answer_review_request';

-- A step's round and ordinal come together and only on its server-written
-- user turn, which a step always creates in its session; its answer carries
-- just the session. Deleting a session (its chat being deleted, in whatever
-- order the cascades run) clears only the session column, so a turn's round
-- may outlive it. Every existing row is null, so the check holds at once.
ALTER TABLE "Message"
  ADD COLUMN "answerReviewSessionId" TEXT,
  ADD COLUMN "answerReviewRound" INTEGER,
  ADD COLUMN "answerReviewStep" INTEGER,
  ADD CONSTRAINT "Message_answer_review_step_check" CHECK (
    ("answerReviewRound" IS NULL) = ("answerReviewStep" IS NULL)
    AND ("answerReviewRound" IS NULL OR (
      "role" = 'user' AND "systemTurnKind" IS NOT NULL
      AND "answerReviewRound" >= 1 AND "answerReviewStep" >= 0
    ))
    AND ("answerReviewSessionId" IS NULL OR "role" <> 'user' OR "answerReviewRound" IS NOT NULL)
  );

-- CreateTable
CREATE TABLE "AnswerReviewSession" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT,
    "sourceAssistantMessageId" TEXT NOT NULL,
    "mode" "AnswerReviewMode" NOT NULL,
    "authorModel" JSONB NOT NULL,
    "reviewers" JSONB NOT NULL,
    "maxRounds" INTEGER,
    "round" INTEGER NOT NULL DEFAULT 1,
    "state" "AnswerReviewState" NOT NULL DEFAULT 'running',
    "stopReason" "AnswerReviewStopReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnswerReviewSession_pkey" PRIMARY KEY ("id"),
    -- A running session has no stop reason; a finished one ended by its
    -- reviews, a stopped one by anything else. Manual sessions add rounds by
    -- the user's action; automatic ones have one to three.
    CONSTRAINT "AnswerReviewSession_state_check" CHECK (
      ("state" = 'running') = ("stopReason" IS NULL)
      AND ("state" <> 'finished' OR "stopReason" IN ('clean', 'max_rounds', 'disagreement'))
      AND ("state" <> 'stopped' OR "stopReason" NOT IN ('clean', 'max_rounds', 'disagreement'))
      AND "round" >= 1
      AND (("mode" = 'manual') = ("maxRounds" IS NULL))
      AND ("maxRounds" IS NULL OR "maxRounds" BETWEEN 1 AND 3)
    ),
    CONSTRAINT "AnswerReviewSession_models_check" CHECK (
      jsonb_typeof("authorModel") = 'object'
      AND jsonb_typeof("reviewers") = 'array'
      AND jsonb_array_length("reviewers") BETWEEN 1 AND 2
    )
);

-- CreateIndex
CREATE INDEX "AnswerReviewSession_chatId_state_idx" ON "AnswerReviewSession"("chatId", "state");

-- CreateIndex
CREATE INDEX "AnswerReviewSession_userId_idx" ON "AnswerReviewSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerReviewSession_chatId_id_key" ON "AnswerReviewSession"("chatId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AnswerReviewSession_chatId_sourceAssistantMessageId_key" ON "AnswerReviewSession"("chatId", "sourceAssistantMessageId");

-- AddForeignKey: deleting a session clears only the message's session column.
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_answerReviewSessionId_fkey" FOREIGN KEY ("chatId", "answerReviewSessionId") REFERENCES "AnswerReviewSession"("chatId", "id") ON DELETE SET NULL ("answerReviewSessionId") ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AnswerReviewSession" ADD CONSTRAINT "AnswerReviewSession_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a deleted initiator leaves the session and its steps in place.
ALTER TABLE "AnswerReviewSession" ADD CONSTRAINT "AnswerReviewSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerReviewSession" ADD CONSTRAINT "AnswerReviewSession_source_fkey" FOREIGN KEY ("chatId", "sourceAssistantMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
