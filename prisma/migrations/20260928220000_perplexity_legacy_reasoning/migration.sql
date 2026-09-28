-- Sonar Pro Search models configured from the pre-v0.2.25 template still store
-- the template's former reasoning object. Requests serialize it as reasoning
-- Off, which this endpoint rejects because its reasoning is mandatory. Replace
-- only that exact object with the current template value, which hides reasoning
-- without disabling it. The column and both configurations change
-- independently, each on its own exact match; every other key stays unchanged.
-- Versions, checks, routing and native-routing adoption stay unchanged; the
-- updatedAt bump makes an admin form loaded before the upgrade save as stale.
-- The adoption trigger treats configuration writes as operator edits, so it is
-- disabled only around this data update.
ALTER TABLE "ProviderModel" DISABLE TRIGGER "ProviderModel_preserve_native_route_operator_edit";

UPDATE "ProviderModel" AS model SET
  "defaultParams" = CASE WHEN model."defaultParams" -> 'reasoning' = legacy_fix.legacy
    THEN jsonb_set(model."defaultParams", '{reasoning}', legacy_fix.fixed) ELSE model."defaultParams" END,
  "activeConfig" = CASE WHEN model."activeConfig" ->> 'upstreamModelId' = legacy_fix.upstream
      AND model."activeConfig" #> '{defaultParams,reasoning}' = legacy_fix.legacy
    THEN jsonb_set(model."activeConfig", '{defaultParams,reasoning}', legacy_fix.fixed) ELSE model."activeConfig" END,
  "draftConfig" = CASE WHEN model."draftConfig" ->> 'upstreamModelId' = legacy_fix.upstream
      AND model."draftConfig" #> '{defaultParams,reasoning}' = legacy_fix.legacy
    THEN jsonb_set(model."draftConfig", '{defaultParams,reasoning}', legacy_fix.fixed) ELSE model."draftConfig" END,
  "updatedAt" = CURRENT_TIMESTAMP
FROM (SELECT
  'perplexity/sonar-pro-search'::text AS upstream,
  '{"effort":"medium","enabled":false,"exclude":true,"maxTokens":0}'::jsonb AS legacy,
  '{"exclude":true}'::jsonb AS fixed) AS legacy_fix
WHERE model."provider" = 'openrouter' AND model."modelId" = legacy_fix.upstream AND (
  model."defaultParams" -> 'reasoning' = legacy_fix.legacy OR
  (model."activeConfig" ->> 'upstreamModelId' = legacy_fix.upstream
    AND model."activeConfig" #> '{defaultParams,reasoning}' = legacy_fix.legacy) OR
  (model."draftConfig" ->> 'upstreamModelId' = legacy_fix.upstream
    AND model."draftConfig" #> '{defaultParams,reasoning}' = legacy_fix.legacy));

ALTER TABLE "ProviderModel" ENABLE TRIGGER "ProviderModel_preserve_native_route_operator_edit";
