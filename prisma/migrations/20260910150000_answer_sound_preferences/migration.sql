ALTER TABLE "UserSettings"
  ADD COLUMN "answerSoundEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "answerSoundId" VARCHAR(16) NOT NULL DEFAULT 'rise',
  ADD CONSTRAINT "UserSettings_answerSoundId_check"
    CHECK ("answerSoundId" IN ('rise', 'bell', 'drop', 'double-tap'));
