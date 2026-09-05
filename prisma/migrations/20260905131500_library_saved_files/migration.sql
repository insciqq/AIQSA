ALTER TABLE "Attachment" ADD COLUMN "savedAt" TIMESTAMP(3);

CREATE INDEX "Attachment_userId_savedAt_idx" ON "Attachment"("userId", "savedAt");

-- A saved personal file is an independent immutable input. Using it in a
-- conversation creates another attachment instead of consuming this record.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_saved_file_boundary_check" CHECK (
  "savedAt" IS NULL OR (
    "userId" IS NOT NULL
    AND "projectId" IS NULL
    AND "chatId" IS NULL
    AND "messageId" IS NULL
    AND "producerModelRunId" IS NULL
  )
);
