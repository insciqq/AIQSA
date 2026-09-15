CREATE TABLE "InstructionPreset" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "systemInstructions" TEXT NOT NULL,
  "responseReminder" TEXT NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstructionPreset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InstructionPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InstructionPreset_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "InstructionPreset_userId_id_key" ON "InstructionPreset"("userId", "id");
CREATE UNIQUE INDEX "InstructionPreset_userId_name_key" ON "InstructionPreset"("userId", "name");
ALTER TABLE "UserSettings" ADD COLUMN "activeInstructionPresetId" TEXT,
  ADD COLUMN "instructionSelectionVersion" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "UserSettings_userId_activeInstructionPresetId_idx" ON "UserSettings"("userId", "activeInstructionPresetId");
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_activeInstructionPresetId_fkey"
  FOREIGN KEY ("userId", "activeInstructionPresetId") REFERENCES "InstructionPreset"("userId", "id")
  ON DELETE SET NULL ("activeInstructionPresetId") ON UPDATE RESTRICT;
ALTER TABLE "AssistantDefinition" ADD COLUMN "responseReminder" TEXT NOT NULL DEFAULT '';
