BEGIN;

-- Re-rendering can change safe evidence without changing the chat revision.
-- Retired rounds keep accepted references but no longer reserve live positions.
DROP INDEX "MemoryRecallRound_source_ordinal_key";
ALTER INDEX "MemoryRecallRound_live_ordinal_key"
  RENAME TO "MemoryRecallRound_source_ordinal_key";

COMMIT;
