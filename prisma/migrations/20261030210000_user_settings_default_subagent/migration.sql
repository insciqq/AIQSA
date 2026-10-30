-- The custom sub-agent a new thread with no type runs (operator decision
-- 2026-10-30). Expand only: the column is nullable, every existing row stays
-- null, so nothing changes until a user sets a default, and previous-release
-- writers never name it. The composite key keeps a default among its owner's
-- own definitions, and deleting the definition clears only this column.
ALTER TABLE "UserSettings" ADD COLUMN "defaultSubagentDefinitionId" TEXT;

-- CreateIndex
CREATE INDEX "UserSettings_userId_defaultSubagentDefinitionId_idx" ON "UserSettings"("userId", "defaultSubagentDefinitionId");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_defaultSubagentDefinition_fkey"
  FOREIGN KEY ("userId", "defaultSubagentDefinitionId") REFERENCES "SubagentDefinition"("ownerUserId", "id")
  ON DELETE SET NULL ("defaultSubagentDefinitionId") ON UPDATE RESTRICT;
