-- A history index page replays only as many changed settled tool calls of
-- its indexed prefix as its write budget admits; the next page resumes after
-- this (updatedAt, id) position. Both columns are new and NULL, so the
-- constraint holds for every existing checkpoint (one row per chat).
ALTER TABLE "ChatMemoryCheckpoint"
  ADD COLUMN "toolCallReplayAfterUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "toolCallReplayAfterId" TEXT,
  ADD CONSTRAINT "ChatMemoryCheckpoint_tool_call_replay_cursor_check" CHECK (
    ("toolCallReplayAfterUpdatedAt" IS NULL) = ("toolCallReplayAfterId" IS NULL)
  );

COMMENT ON COLUMN "ChatMemoryCheckpoint"."toolCallReplayAfterUpdatedAt" IS
'With toolCallReplayAfterId: the last changed settled tool call an index page handled while more remained; the next page resumes after it. NULL: the next page starts at lastSucceededAt.';
