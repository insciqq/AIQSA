CREATE OR REPLACE FUNCTION "validateKnowledgeBaseSnapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  base_source_revision INTEGER;
  active_source_count INTEGER;
  generation_profile_revision_id TEXT;
  generation_status "KnowledgeIndexGenerationStatus";
BEGIN
  SELECT
    base."sourceRevision",
    (
      SELECT count(*)::integer
      FROM "KnowledgeBaseSource" AS membership
      INNER JOIN "KnowledgeSource" AS source
        ON source."id" = membership."sourceId"
       AND source."ownerUserId" = membership."ownerUserId"
       AND source."trashedAt" IS NULL
       AND source."deletionRequestedAt" IS NULL
      WHERE membership."knowledgeBaseId" = base."id"
        AND membership."removedAt" IS NULL
    ),
    generation."profileRevisionId",
    generation."status"
  INTO
    base_source_revision,
    active_source_count,
    generation_profile_revision_id,
    generation_status
  FROM "KnowledgeBase" AS base
  INNER JOIN "KnowledgeIndexGeneration" AS generation
    ON generation."knowledgeBaseId" = base."id"
   AND generation."id" = NEW."indexGenerationId"
  WHERE base."id" = NEW."knowledgeBaseId"
    AND base."ownerUserId" = NEW."ownerUserId";

  IF NOT FOUND OR
     generation_status <> 'active' OR
     generation_profile_revision_id IS NULL OR
     generation_profile_revision_id <> NEW."profileRevisionId" OR
     base_source_revision <> NEW."sourceRevision" OR
     active_source_count <> NEW."sourceCount" THEN
    RAISE EXCEPTION 'knowledge_base_snapshot_evidence_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
