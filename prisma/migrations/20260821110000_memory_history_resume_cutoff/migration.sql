ALTER TABLE "ChatMemoryCheckpoint"
ADD COLUMN "resumeCreatedAtCutoff" TIMESTAMP(3);

COMMENT ON COLUMN "ChatMemoryCheckpoint"."resumeCreatedAtCutoff" IS
'Server-authored forward-only cutoff for chat history and automatic fact learning after Exclude from Memory is resumed.';
