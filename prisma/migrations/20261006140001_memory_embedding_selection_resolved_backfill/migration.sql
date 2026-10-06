-- A stored embedding was selected through a settings patch, the bootstrap's
-- included, so its selection is resolved. A missing one is never an owner's
-- clear: no owner-facing route has accepted an embedding selection since
-- personal Memory v1, before the first supported release, and outside patches
-- only account deletion clears it, for an owner who is no longer active.
-- Those owners stay eligible for the bootstrap whatever their settings
-- revision. A previous-release bootstrap may still select after this runs;
-- the bootstrap reads the flag only while no embedding is stored.
UPDATE "UserMemorySettings" SET "embeddingSelectionResolved" = true
WHERE "embeddingProviderModelId" IS NOT NULL;
