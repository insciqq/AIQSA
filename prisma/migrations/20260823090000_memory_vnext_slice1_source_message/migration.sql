-- Memory vNext Slice 1 binds automatic extraction to one immutable direct-user
-- message. Existing and legacy-pipeline jobs remain nullable so they can
-- terminalize; the following guard migration enforces the vNext contract.

ALTER TABLE "MemoryJob"
  ADD COLUMN "sourceMessageId" TEXT;

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "observedAt" TIMESTAMP(3);

CREATE INDEX "MemoryJob_userId_sourceMessageId_idx"
  ON "MemoryJob"("userId", "sourceMessageId");
