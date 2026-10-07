-- Message limits count admitted interactive runs in this log instead of
-- ModelRun, whose rows go with their chat or branch: deleting chats must not
-- reset a limit. Run creation writes a row for every send, edit and
-- regeneration (never for scheduled runs or continuations) and prunes the
-- user's rows older than 25 hours in the same transaction. The table is new and
-- starts empty, so ordinary DDL in one transaction is safe; runs admitted before
-- the upgrade are not counted.
CREATE TABLE "UsageMessageAdmission" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageMessageAdmission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageMessageAdmission_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UsageMessageAdmission_userId_createdAt_idx" ON "UsageMessageAdmission"("userId", "createdAt");
