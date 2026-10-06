-- Whether this owner's Memory embedding selection has been decided: set or
-- cleared by a settings patch, or chosen by the one-time Knowledge-default
-- bootstrap. The settings revision also counts unrelated preference changes
-- and system migrations, so it cannot answer this. Column only: the backfill
-- runs in 20261006140001, its own transaction, so this table lock is released
-- before its row locks meet previous-release settings writers.
ALTER TABLE "UserMemorySettings" ADD COLUMN "embeddingSelectionResolved" BOOLEAN NOT NULL DEFAULT false;
