BEGIN;

ALTER TABLE "ChatMemoryCheckpoint" ALTER COLUMN "pipelineVersion"
  SET DEFAULT 'memory-history-incremental-v9';

-- Contextual keys require reindexing through the existing backfill. Preserve
-- retained checkpoints instead of relabelling their old preparation evidence.
-- Tool observations have unchanged source semantics: admit both predecessor
-- and current writers during the application replacement window.
DO $migration$
DECLARE
  definition text;
  predecessor text := 'checkpoint."pipelineVersion" <> ''memory-history-incremental-v8''';
  current_guard text := 'checkpoint."pipelineVersion" NOT IN (''memory-history-incremental-v8'', ''memory-history-incremental-v9'')';
BEGIN
  definition := pg_get_functiondef(
    'aiqsa_memory_assert_tool_event_source(text,text)'::regprocedure
  );
  IF (length(definition) - length(replace(definition, predecessor, '')))
      / length(predecessor) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Memory tool source pipeline';
  END IF;
  -- Leave every owner, lifecycle, source revision and settled-call guard intact.
  EXECUTE replace(definition, predecessor, current_guard);
END;
$migration$;

COMMIT;
