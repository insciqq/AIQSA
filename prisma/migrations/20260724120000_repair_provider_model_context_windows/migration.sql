-- The provider-control-plane cutover kept contextWindow in the legacy column,
-- but did not copy it into the authoritative draft/active capability snapshots.
-- A later activation could also replace that legacy value with the compatibility
-- sentinel `1`. Repair only persisted configuration metadata; accepted run
-- bindings remain immutable and current availability checks keep their versions.

WITH template_context("templateKey", "contextWindow") AS (
  VALUES
    ('fake:fake-qsa', 8192),
    ('openai:gpt-5.5', 1050000),
    ('openai:gpt-5.6-sol', 1050000),
    ('openai:gpt-5.6-terra', 1050000),
    ('openai:gpt-5.6-luna', 1050000),
    ('anthropic:claude-opus-4-8', 1000000),
    ('openrouter:anthropic/claude-opus-4.8', 1000000),
    ('openrouter:google/gemini-3.5-flash', 1048576),
    ('openrouter:~google/gemini-pro-latest', 1048576),
    ('openrouter:perplexity/sonar-pro-search', 200000)
),
resolved_context AS (
  SELECT
    model_row."id",
    COALESCE(
      CASE
        WHEN jsonb_typeof(model_row."activeConfig" #> '{capabilities,contextWindow}') = 'number'
          THEN (model_row."activeConfig" #>> '{capabilities,contextWindow}')::INTEGER
      END,
      CASE
        WHEN jsonb_typeof(model_row."draftConfig" #> '{capabilities,contextWindow}') = 'number'
          THEN (model_row."draftConfig" #>> '{capabilities,contextWindow}')::INTEGER
      END,
      CASE WHEN model_row."contextWindow" > 1 THEN model_row."contextWindow" END,
      template_context."contextWindow"
    ) AS "contextWindow"
  FROM "ProviderModel" model_row
  LEFT JOIN template_context
    ON template_context."templateKey" = model_row."templateKey"
)
UPDATE "ProviderModel" model_row
SET
  "draftConfig" = CASE
    WHEN model_row."draftConfig" #> '{capabilities,contextWindow}' IS NULL
      AND jsonb_typeof(model_row."draftConfig" -> 'capabilities') = 'object'
      THEN jsonb_set(
        model_row."draftConfig",
        '{capabilities}',
        (model_row."draftConfig" -> 'capabilities') ||
          jsonb_build_object('contextWindow', resolved_context."contextWindow"),
        true
      )
    ELSE model_row."draftConfig"
  END,
  "activeConfig" = CASE
    WHEN model_row."activeConfig" IS NOT NULL
      AND model_row."activeConfig" #> '{capabilities,contextWindow}' IS NULL
      AND jsonb_typeof(model_row."activeConfig" -> 'capabilities') = 'object'
      THEN jsonb_set(
        model_row."activeConfig",
        '{capabilities}',
        (model_row."activeConfig" -> 'capabilities') ||
          jsonb_build_object('contextWindow', resolved_context."contextWindow"),
        true
      )
    ELSE model_row."activeConfig"
  END,
  "contextWindow" = resolved_context."contextWindow"
FROM resolved_context
WHERE resolved_context."id" = model_row."id"
  AND resolved_context."contextWindow" IS NOT NULL;
