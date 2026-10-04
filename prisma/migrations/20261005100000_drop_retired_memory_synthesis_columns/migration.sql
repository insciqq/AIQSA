-- Contract the settings of retired Dream synthesis. Since v0.3.2 no release
-- writes or selects these columns (no settings call returns the full row), so
-- the previous-release writer during Compose replacement never touches them.
-- Every other setting of every row is unchanged.
ALTER TABLE "UserMemorySettings" DROP CONSTRAINT "UserMemorySettings_synthesis_shape_check";
DROP INDEX "UserMemorySettings_synthesisEnabled_lastSynthesisAt_userId_idx";
ALTER TABLE "UserMemorySettings"
  DROP COLUMN "synthesisEnabled",
  DROP COLUMN "synthesisEnabledAt",
  DROP COLUMN "synthesisPolicyVersion",
  DROP COLUMN "lastSynthesisAt";
