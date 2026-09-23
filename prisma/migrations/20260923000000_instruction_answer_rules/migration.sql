ALTER TABLE "InstructionPreset" ADD COLUMN "answerRules" TEXT;
ALTER TABLE "InstructionPreset" ADD CONSTRAINT "InstructionPreset_answerRules_length_check"
  CHECK ("answerRules" IS NULL OR char_length("answerRules") <= 4000);
