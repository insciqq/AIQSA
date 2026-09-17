BEGIN;

-- Preserve existing checkpoints and accepted evidence. Current writers
-- rebuild old projections through the ordinary history indexing workflow.
ALTER TABLE "ChatMemoryCheckpoint"
  ALTER COLUMN "pipelineVersion" SET DEFAULT 'memory-history-incremental-v10';

-- Tool observations retain their source contract. Accept the new checkpoint
-- writer alongside its predecessors during application replacement, keeping
-- all owner, lifecycle, source-map and settled-call constraints unchanged.
DO $migration$
DECLARE
  definition text;
  predecessor text := 'checkpoint."pipelineVersion" NOT IN (''memory-history-incremental-v8'', ''memory-history-incremental-v9'')';
  current_guard text := 'checkpoint."pipelineVersion" NOT IN (''memory-history-incremental-v8'', ''memory-history-incremental-v9'', ''memory-history-incremental-v10'')';
BEGIN
  definition := pg_get_functiondef(
    'aiqsa_memory_assert_tool_event_source(text,text)'::regprocedure
  );
  IF (length(definition) - length(replace(definition, predecessor, '')))
      / length(predecessor) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Memory tool source pipeline';
  END IF;
  EXECUTE replace(definition, predecessor, current_guard);
END;
$migration$;

COMMIT;
