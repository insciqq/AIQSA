-- Null any pre-existing dangling active-leaf pointer before adding the FK.
UPDATE "Chat"
SET "activeLeafMessageId" = NULL
WHERE "activeLeafMessageId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Message"
    WHERE "Message"."id" = "Chat"."activeLeafMessageId"
  );

-- AddForeignKey
ALTER TABLE "Chat"
ADD CONSTRAINT "Chat_activeLeafMessageId_fkey"
FOREIGN KEY ("activeLeafMessageId") REFERENCES "Message"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Chat_activeLeafMessageId_idx" ON "Chat"("activeLeafMessageId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
