-- When the answer text of the current provider round began. Cleared by a
-- tool-loop round reset, so the settled value marks the final answer's start;
-- the thread projects only the derived work duration (admission → answer).
ALTER TABLE "ModelRun"
  ADD COLUMN "answerStartedAt" TIMESTAMP(3);
