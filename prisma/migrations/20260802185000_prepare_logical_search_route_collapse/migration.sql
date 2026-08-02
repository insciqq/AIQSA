-- This prerequisite is deliberately ordered immediately before the published
-- logical Search option migration. Some legacy installations retained one
-- enabled query-only route and one or more disabled routes for the same exact
-- provider connection. The logical parent can own only one unarchived route
-- per adapter kind, so archive only those disabled remnants before collapse.
--
-- Rows, revisions, and historical SearchRunBinding references are preserved.
-- Multiple enabled candidates remain ambiguous and fail closed. Installations
-- where logical Search options already exist safely no-op when this later
-- addition is discovered after 20260802190000 was applied.

BEGIN;

CREATE TEMP TABLE "_LogicalSearchLegacyRouteDuplicates" ON COMMIT DROP AS
SELECT
  model."connectionId",
  strategy."kind",
  strategy."adapterKind",
  count(*) AS "routeCount",
  count(*) FILTER (WHERE strategy."enabled") AS "enabledCount",
  count(*) FILTER (
    WHERE strategy."enabled" AND strategy."activeRevisionId" IS NOT NULL
  ) AS "enabledReadyCount"
FROM "SearchStrategy" strategy
INNER JOIN "ProviderModel" model ON model."id" = strategy."providerModelId"
WHERE to_regclass('"SearchOption"') IS NULL
  AND strategy."kind" = 'provider_model_web_search'
  AND strategy."adapterKind" = 'provider_model_client'
  AND strategy."archivedAt" IS NULL
GROUP BY model."connectionId", strategy."kind", strategy."adapterKind"
HAVING count(*) > 1;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_LogicalSearchLegacyRouteDuplicates"
    WHERE "enabledCount" <> 1 OR "enabledReadyCount" <> 1
  ) THEN
    RAISE EXCEPTION 'Logical Search legacy route repair found multiple or missing enabled routes for one exact source';
  END IF;
END
$migration$;

UPDATE "SearchStrategy" strategy
SET
  "archivedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "ProviderModel" model
INNER JOIN "_LogicalSearchLegacyRouteDuplicates" duplicate
  ON duplicate."connectionId" = model."connectionId"
WHERE model."id" = strategy."providerModelId"
  AND duplicate."kind" = strategy."kind"
  AND duplicate."adapterKind" = strategy."adapterKind"
  AND strategy."archivedAt" IS NULL
  AND NOT strategy."enabled";

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    INNER JOIN "ProviderModel" model ON model."id" = strategy."providerModelId"
    WHERE to_regclass('"SearchOption"') IS NULL
      AND strategy."kind" = 'provider_model_web_search'
      AND strategy."adapterKind" = 'provider_model_client'
      AND strategy."archivedAt" IS NULL
    GROUP BY model."connectionId", strategy."kind", strategy."adapterKind"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Logical Search legacy route repair did not resolve duplicate physical routes';
  END IF;
END
$migration$;

COMMIT;
