-- The periodic synthesis inventory starts from enabled owners, then probes
-- their live observations after the forward boundary through this index.

CREATE INDEX "MemoryFactVersion_userId_state_observedAt_idx"
  ON "MemoryFactVersion"("userId", "state", "observedAt");

CREATE INDEX "MemoryFactVersion_modality_state_userId_idx"
  ON "MemoryFactVersion"("modality", "state", "userId");
