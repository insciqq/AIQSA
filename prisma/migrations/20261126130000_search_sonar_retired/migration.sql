-- Perplexity Sonar leaves the product (operator decision 2026-11-26); OpenRouter's
-- web search with Perplexity replaces it on the same OpenRouter connection.
--
-- What changes, and how:
-- - The installation's engine or backup that names a Sonar source moves to the
--   live OpenRouter web search source with engine Perplexity on that source's
--   connection, when there is one; else it becomes null, and the engine is
--   Automatic: the default order picks it at run time and Admin › Search shows
--   the one it resolved. A backup equal to the engine after the move is
--   cleared. `defaultPlan` follows as the new release writes it (engine, then
--   backup; empty when Automatic) for the previous release, still serving
--   while Compose replaces containers, and the version moves on so an Admin ›
--   Search page opened before the upgrade cannot write over the new policy.
--   A policy that names no Sonar source stays exactly as it is.
-- - The Sonar sources and their routes are archived and disabled; their
--   revisions stay for the runs and answers that reference them.
-- - Personal, Assistant and chat plans and grants stay as stored: plans read as
--   on or off, and a grant of a Sonar source is still a Search grant.
-- - Runs accepted before the upgrade keep their frozen plans; a frozen Sonar
--   option has no runtime now, so its call fails visibly with a stable code.

WITH "sonar" AS (
  SELECT option."optionId", (
    SELECT web."optionId"
    FROM "SearchOption" AS web
    WHERE web."sourceConnectionId" = option."sourceConnectionId"
      AND web."kind" = 'web_search'
      AND web."enabled"
      AND web."archivedAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "SearchStrategy" AS route
        JOIN "SearchIntegrationRevision" AS revision
          ON revision."id" = route."activeRevisionId" AND revision."searchStrategyId" = route."id"
        WHERE route."searchOptionId" = web."id"
          AND route."enabled"
          AND route."archivedAt" IS NULL
          AND route."adapterKind" = 'provider_model_client'
          AND revision."configuration" ->> 'protocol' = 'openrouter_web_search'
          AND revision."configuration" -> 'openRouterWebSearch' ->> 'engine' = 'perplexity'
      )
    ORDER BY web."createdAt", web."optionId"
    LIMIT 1
  ) AS "replacement"
  FROM "SearchOption" AS option
  WHERE option."kind" = 'perplexity_search'
), "mapped" AS (
  SELECT policy."id",
    CASE WHEN policy."engineOptionId" IN (SELECT "optionId" FROM "sonar")
      THEN (SELECT "replacement" FROM "sonar" WHERE "sonar"."optionId" = policy."engineOptionId")
      ELSE policy."engineOptionId"
    END AS "engine",
    CASE WHEN policy."backupOptionId" IN (SELECT "optionId" FROM "sonar")
      THEN (SELECT "replacement" FROM "sonar" WHERE "sonar"."optionId" = policy."backupOptionId")
      ELSE policy."backupOptionId"
    END AS "backup"
  FROM "SearchPolicy" AS policy
  WHERE policy."engineOptionId" IN (SELECT "optionId" FROM "sonar")
    OR policy."backupOptionId" IN (SELECT "optionId" FROM "sonar")
    OR (jsonb_typeof(policy."defaultPlan" -> 'optionIds') = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(policy."defaultPlan" -> 'optionIds') AS item(element)
      WHERE item.element IN (SELECT "optionId" FROM "sonar")
    ))
), "settled" AS (
  SELECT "id", "engine",
    CASE WHEN "backup" IS NOT DISTINCT FROM "engine" THEN NULL ELSE "backup" END AS "backup"
  FROM "mapped"
)
UPDATE "SearchPolicy" AS policy
SET "engineOptionId" = settled."engine",
  "backupOptionId" = settled."backup",
  "defaultPlan" = jsonb_build_object(
    'mode', 'all_selected',
    'optionIds', to_jsonb(array_remove(ARRAY[settled."engine", settled."backup"], NULL))
  ),
  "version" = policy."version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "settled"
WHERE settled."id" = policy."id";

UPDATE "SearchStrategy"
SET "enabled" = false, "archivedAt" = COALESCE("archivedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
WHERE ("kind" = 'perplexity_tool_search'
    OR "searchOptionId" IN (SELECT "id" FROM "SearchOption" WHERE "kind" = 'perplexity_search'))
  AND ("enabled" OR "archivedAt" IS NULL);

UPDATE "SearchOption"
SET "enabled" = false, "archivedAt" = COALESCE("archivedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'perplexity_search' AND ("enabled" OR "archivedAt" IS NULL);
