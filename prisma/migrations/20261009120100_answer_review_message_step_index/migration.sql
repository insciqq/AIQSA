-- One server-written turn per answer review step: the claim a step's
-- admission makes in the transaction that creates its turn. Message is a
-- large live table, so the index is built CONCURRENTLY and stays the only
-- statement of this file (Persistence, Migrations And Bootstrap).
CREATE UNIQUE INDEX CONCURRENTLY "Message_answerReviewSessionId_answerReviewRound_answerRevie_key" ON "Message"("answerReviewSessionId", "answerReviewRound", "answerReviewStep");
