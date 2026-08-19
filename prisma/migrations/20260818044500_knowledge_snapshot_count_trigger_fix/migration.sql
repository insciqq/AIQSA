CREATE OR REPLACE FUNCTION "validateKnowledgeBaseSnapshotReadyCount"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_snapshot_id TEXT;
  expected_ready_count INTEGER;
  actual_ready_count INTEGER;
BEGIN
  target_snapshot_id := COALESCE(
    to_jsonb(NEW) ->> 'id',
    to_jsonb(NEW) ->> 'snapshotId'
  );
  SELECT snapshot."readySourceCount"
  INTO expected_ready_count
  FROM "KnowledgeBaseSnapshot" AS snapshot
  WHERE snapshot."id" = target_snapshot_id;
  SELECT count(*)::integer
  INTO actual_ready_count
  FROM "KnowledgeBaseSnapshotSource" AS source
  WHERE source."snapshotId" = target_snapshot_id;
  IF expected_ready_count IS NULL OR expected_ready_count <> actual_ready_count THEN
    RAISE EXCEPTION 'knowledge_base_snapshot_ready_count_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
