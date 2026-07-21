ALTER TABLE "Group" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Group_archivedAt_idx" ON "Group"("archivedAt");
