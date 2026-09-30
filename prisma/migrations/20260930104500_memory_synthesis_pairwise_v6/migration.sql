-- Add pairwise and same-episode display projections without changing direct
-- source truth, the three-root generalization policy, or existing preferences.
-- Restart the bounded evaluation once for this policy, preserving enable/pause
-- boundaries; unchanged source fingerprints prevent repeated provider calls.
ALTER TABLE "UserMemorySettings"
  ALTER COLUMN "synthesisPolicyVersion" SET DEFAULT 'memory-synthesis-policy-v6';
UPDATE "UserMemorySettings"
SET "synthesisPolicyVersion" = 'memory-synthesis-policy-v6', "lastSynthesisAt" = NULL
WHERE "synthesisPolicyVersion" = 'memory-synthesis-policy-v5';

-- The source references are server-bound version ids, never model-authored ids.
-- Retain exact claim coverage for joint projections; legacy intersections and
-- generalizations do not require claim arrays.
CREATE OR REPLACE FUNCTION aiqsa_memory_synthesis_claims_valid(
  p_user_id text, p_version_id text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  projection jsonb;
  display_text text;
  claim jsonb;
  source_ref jsonb;
  combined_text text := '';
  seen_refs text[] := ARRAY[]::text[];
BEGIN
  SELECT "structuredValue", "displayText" INTO projection, display_text
  FROM "MemoryFactVersion"
  WHERE "userId" = p_user_id AND "id" = p_version_id;
  IF NOT FOUND OR projection IS NULL OR display_text IS NULL THEN RETURN FALSE; END IF;
  IF COALESCE(projection->>'reasonCode', '') NOT IN (
    'combined_refined_facts', 'combined_episode_facts'
  ) THEN RETURN TRUE; END IF;
  IF jsonb_typeof(projection->'claims') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(projection->'claims') NOT BETWEEN 1 AND 8 THEN RETURN FALSE; END IF;
  FOR claim IN SELECT value FROM jsonb_array_elements(projection->'claims') LOOP
    IF jsonb_typeof(claim) IS DISTINCT FROM 'object'
       OR jsonb_typeof(claim->'statement') IS DISTINCT FROM 'string'
       OR COALESCE(length(claim->>'statement'), 0) NOT BETWEEN 1 AND 2000
       OR jsonb_typeof(claim->'sourceVersionIds') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
    IF jsonb_array_length(claim->'sourceVersionIds') NOT BETWEEN 1 AND 40 THEN RETURN FALSE; END IF;
    FOR source_ref IN SELECT value FROM jsonb_array_elements(claim->'sourceVersionIds') LOOP
      IF jsonb_typeof(source_ref) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM "MemoryFactVersionRelation"
        WHERE "userId" = p_user_id AND "sourceVersionId" = p_version_id
          AND "kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
          AND "targetVersionId" = source_ref #>> '{}'
      ) THEN RETURN FALSE; END IF;
      seen_refs := array_append(seen_refs, source_ref #>> '{}');
    END LOOP;
    combined_text := combined_text || CASE WHEN combined_text = '' THEN '' ELSE ' ' END || (claim->>'statement');
  END LOOP;
  IF combined_text IS DISTINCT FROM display_text THEN RETURN FALSE; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM "MemoryFactVersionRelation"
    WHERE "userId" = p_user_id AND "sourceVersionId" = p_version_id
      AND "kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
      AND NOT ("targetVersionId" = ANY(seen_refs))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_fact_pointer(
  p_user_id text,
  p_fact_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  fact_row "MemoryFact"%ROWTYPE;
  active_count integer;
  pointed_state "MemoryFactVersionState";
  pointed_expires_at timestamp(3);
  pointed_system_to timestamp(3);
  pointed_merge_target text;
  pointed_modality "MemoryFactModality";
  synthesis_source_count integer;
  pointed_reason text;
  minimum_sources integer;
BEGIN
  SELECT * INTO fact_row FROM "MemoryFact"
  WHERE "userId" = p_user_id AND "id" = p_fact_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO active_count FROM "MemoryFactVersion"
  WHERE "userId" = p_user_id
    AND "factId" = p_fact_id
    AND "state" = 'ACTIVE';

  IF fact_row."state" = 'ACTIVE' THEN
    SELECT "state", "expiresAt", "systemTo", "mergedIntoVersionId", "modality"
    INTO pointed_state, pointed_expires_at, pointed_system_to,
      pointed_merge_target, pointed_modality
    FROM "MemoryFactVersion"
    WHERE "userId" = p_user_id
      AND "factId" = p_fact_id
      AND "id" = fact_row."currentVersionId";
    IF fact_row."currentVersionId" IS NULL
       OR pointed_state IS DISTINCT FROM 'ACTIVE'
       OR pointed_system_to IS NOT NULL
       OR pointed_merge_target IS NOT NULL
       OR active_count <> 1
       OR pointed_expires_at <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'ACTIVE Memory fact must point to one live open ACTIVE same-owner version';
    END IF;

    IF pointed_modality = 'PATTERN'::"MemoryFactModality" THEN
      SELECT count(DISTINCT source."factId") INTO synthesis_source_count
      FROM "MemoryFactVersionRelation" AS relation
      INNER JOIN "MemoryFactVersion" AS source
        ON source."userId" = relation."userId"
       AND source."id" = relation."targetVersionId"
      WHERE relation."userId" = p_user_id
        AND relation."sourceVersionId" = fact_row."currentVersionId"
        AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind";
      SELECT "structuredValue"->>'reasonCode' INTO pointed_reason
      FROM "MemoryFactVersion" WHERE "id" = fact_row."currentVersionId" AND "userId" = p_user_id;
      minimum_sources := CASE WHEN pointed_reason IN (
        'combined_overlapping_facts', 'combined_refined_facts', 'combined_episode_facts'
      ) THEN 2 ELSE 3 END;
      IF pointed_reason IN ('combined_refined_facts', 'combined_episode_facts')
         AND NOT aiqsa_memory_synthesis_claims_valid(p_user_id, fact_row."currentVersionId") THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Joint Memory projection must retain exact claim-level source coverage';
      END IF;
      IF fact_row."identityKind" IS DISTINCT FROM 'PROPOSITION'
         OR synthesis_source_count < minimum_sources THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'ACTIVE PATTERN must be a depth-one source-linked proposition';
      END IF;
    END IF;
  ELSIF fact_row."currentVersionId" IS NOT NULL OR active_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-ACTIVE Memory fact cannot retain an ACTIVE version or current pointer';
  END IF;
END;
$function$;
