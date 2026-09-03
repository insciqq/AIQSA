-- A settled tool result and the provider usage merged into the run aggregate
-- are separate crash checkpoints. This marker is written atomically with the
-- aggregate replacement, so recovery never relies on wall-clock ordering.
ALTER TABLE "ModelRunToolCall"
  ADD COLUMN "usageAccountedAt" timestamp(3);
