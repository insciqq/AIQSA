-- Successful Memory jobs may retain only a small allowlisted set of
-- content-free integer work counters. The database guard prevents a raw SQL
-- producer from turning this operational field into a text or identifier
-- sink.
CREATE OR REPLACE FUNCTION public.aiqsa_memory_operational_counters_valid(
  p_counters JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT p_counters IS NULL OR (
    jsonb_typeof(p_counters) = 'object'
    AND pg_column_size(p_counters) <= 4096
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_counters) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY[
        'digestFullRebuild',
        'digestIncremental',
        'digestNoop',
        'digestSegmentsProcessed',
        'digestSourceChunksProcessed',
        'historyChunksBuilt',
        'historyChunksReplaced',
        'historyChunksReused',
        'historyMessageContentRowsLoaded',
        'historyMessagesProjected',
        'historyModelRunRowsLoaded',
        'historyPathMetadataRowsRead'
      ]::TEXT[])
        OR jsonb_typeof(entry.value) <> 'number'
        OR (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$'
        OR (entry.value #>> '{}')::NUMERIC > 2147483647
    )
  );
$function$;

ALTER TABLE public."MemoryJob"
  ADD COLUMN "operationalCounters" JSONB;

ALTER TABLE public."MemoryJob"
  ADD CONSTRAINT "MemoryJob_operational_counters_check"
  CHECK (public.aiqsa_memory_operational_counters_valid("operationalCounters"))
  NOT VALID;

ALTER TABLE public."MemoryJob"
  VALIDATE CONSTRAINT "MemoryJob_operational_counters_check";
