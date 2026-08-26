CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keep the immutable relation snapshot comparable to the TypeScript
-- memorySynthesisSourceEligibilityHash owner.  The payload is assembled in
-- canonical key order with JSON string escaping and the same millisecond UTC
-- timestamp representation as Date#toISOString.
CREATE OR REPLACE FUNCTION aiqsa_memory_synthesis_source_eligibility_hash(
  source_canonical_key text,
  source_directness text,
  source_fact_id text,
  source_ingestion_fingerprint text,
  source_memory_generation integer,
  source_modality text,
  source_observed_at timestamp(3) without time zone,
  source_pipeline_version text,
  source_mode text,
  source_version_id text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(digest(convert_to(
    '{"canonicalKey":' || to_json(source_canonical_key)::text ||
    ',"directness":' || to_json(source_directness)::text ||
    ',"domain":"aiqsa.memory.synthesis-source-eligibility"' ||
    ',"factId":' || to_json(source_fact_id)::text ||
    ',"ingestionFingerprint":' ||
      COALESCE(to_json(source_ingestion_fingerprint)::text, 'null') ||
    ',"memoryGeneration":' || source_memory_generation::text ||
    ',"modality":' || to_json(source_modality)::text ||
    ',"observedAt":' || to_json(
      to_char(
        source_observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    )::text ||
    ',"pipelineVersion":' || to_json(source_pipeline_version)::text ||
    ',"sourceMode":' || to_json(source_mode)::text ||
    ',"version":1' ||
    ',"versionId":' || to_json(source_version_id)::text ||
    '}',
    'UTF8'
  ), 'sha256'), 'hex');
$$;
