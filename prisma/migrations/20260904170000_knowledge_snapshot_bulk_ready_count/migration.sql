DROP TRIGGER IF EXISTS "KnowledgeBaseSnapshotSource_ready_count"
ON "KnowledgeBaseSnapshotSource";

CREATE OR REPLACE FUNCTION "validateKnowledgeBaseSnapshotSourceReadyCountStatement"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_snapshot_id TEXT;
  expected_ready_count INTEGER;
  actual_ready_count INTEGER;
BEGIN
  FOR target_snapshot_id IN
    SELECT DISTINCT inserted_source."snapshotId"
    FROM inserted_snapshot_sources AS inserted_source
  LOOP
    SELECT snapshot."readySourceCount"
    INTO expected_ready_count
    FROM "KnowledgeBaseSnapshot" AS snapshot
    WHERE snapshot."id" = target_snapshot_id;

    SELECT count(*)::integer
    INTO actual_ready_count
    FROM "KnowledgeBaseSnapshotSource" AS source
    WHERE source."snapshotId" = target_snapshot_id;

    IF expected_ready_count IS NULL OR
       expected_ready_count <> actual_ready_count THEN
      RAISE EXCEPTION 'knowledge_base_snapshot_ready_count_invalid'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "KnowledgeBaseSnapshotSource_ready_count"
AFTER INSERT ON "KnowledgeBaseSnapshotSource"
REFERENCING NEW TABLE AS inserted_snapshot_sources
FOR EACH STATEMENT
EXECUTE FUNCTION "validateKnowledgeBaseSnapshotSourceReadyCountStatement"();
