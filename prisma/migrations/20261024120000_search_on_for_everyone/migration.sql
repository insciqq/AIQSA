-- Web search is on for everyone, with one way to search, and DeepSeek's own
-- hosted Search is retired in favour of the DeepSeek Search API (operator
-- decisions 2026-10-24). Live checks showed DeepSeek V4 Flash never searches
-- through its hosted tool and no DeepSeek model returns source links there.
-- Every statement is idempotent; a previous-release writer that saves a plan
-- during the upgrade only writes values the new release still reads.

-- The DeepSeek Search API source that takes over, when it is working.
CREATE TEMPORARY TABLE "aiqsa_search_replacement" AS
SELECT (
  SELECT option."optionId"
  FROM "SearchOption" AS option
  WHERE option."kind" = 'deepseek_search_api'
    AND option."enabled"
    AND option."archivedAt" IS NULL
    AND EXISTS (
      SELECT 1 FROM "SearchStrategy" AS route
      WHERE route."searchOptionId" = option."id"
        AND route."enabled"
        AND route."archivedAt" IS NULL
        AND route."activeRevisionId" IS NOT NULL
    )
  ORDER BY option."createdAt", option."id"
  LIMIT 1
) AS "optionId";

-- DeepSeek's hosted Search: the web_search sources of DeepSeek connections
-- (the built-in one and any an administrator added through setup).
CREATE TEMPORARY TABLE "aiqsa_retired_search" AS
SELECT option."id", option."optionId"
FROM "SearchOption" AS option
JOIN "ProviderConnection" AS connection ON connection."id" = option."sourceConnectionId"
WHERE option."kind" = 'web_search' AND connection."family" = 'deepseek';

-- A plan without retired sources: each becomes the replacement, kept once and
-- in its first position, or is dropped when there is none.
CREATE FUNCTION aiqsa_search_plan_without_retired(plan JSONB) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN plan IS NULL OR jsonb_typeof(plan -> 'optionIds') IS DISTINCT FROM 'array' THEN plan
    ELSE jsonb_set(plan, '{optionIds}', COALESCE((
      SELECT jsonb_agg(kept."id" ORDER BY kept."position")
      FROM (
        SELECT mapped."id", min(mapped."position") AS "position"
        FROM (
          SELECT CASE
              WHEN item.element IN (SELECT "optionId" FROM "aiqsa_retired_search")
                THEN (SELECT "optionId" FROM "aiqsa_search_replacement")
              ELSE item.element
            END AS "id",
            item.position AS "position"
          FROM jsonb_array_elements_text(plan -> 'optionIds') WITH ORDINALITY AS item(element, position)
        ) AS mapped
        WHERE mapped."id" IS NOT NULL
        GROUP BY mapped."id"
      ) AS kept
    ), '[]'::jsonb))
  END
$$;

-- Whoever could use DeepSeek's hosted Search may use its replacement. An
-- administrator's existing grant for the replacement, enabled or not, stays.
INSERT INTO "AccessGrant" ("id", "userId", "groupId", "searchStrategy", "enabled", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, grant_row."userId", grant_row."groupId", replacement."optionId", true,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT old_grant."userId", old_grant."groupId"
  FROM "AccessGrant" AS old_grant
  WHERE old_grant."enabled"
    AND old_grant."searchStrategy" IN (SELECT "optionId" FROM "aiqsa_retired_search")
) AS grant_row
CROSS JOIN "aiqsa_search_replacement" AS replacement
WHERE replacement."optionId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "AccessGrant" AS existing
    WHERE existing."searchStrategy" = replacement."optionId"
      AND existing."userId" IS NOT DISTINCT FROM grant_row."userId"
      AND existing."groupId" IS NOT DISTINCT FROM grant_row."groupId"
  );

-- The retired sources leave every list; their runs stay readable.
UPDATE "SearchStrategy"
SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "enabled" AND "searchOptionId" IN (SELECT "id" FROM "aiqsa_retired_search");
UPDATE "SearchOption"
SET "enabled" = false, "archivedAt" = COALESCE("archivedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM "aiqsa_retired_search") AND ("enabled" OR "archivedAt" IS NULL);

-- The organization default searches every chosen source; an empty one now
-- means automatic, never Off. A changed policy gets a new version, so an
-- administrator page opened before the upgrade cannot overwrite it.
UPDATE "SearchPolicy"
SET "defaultPlan" = jsonb_set(aiqsa_search_plan_without_retired("defaultPlan"), '{mode}', '"all_selected"'),
  "version" = "version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE jsonb_typeof("defaultPlan" -> 'optionIds') = 'array'
  AND jsonb_set(aiqsa_search_plan_without_retired("defaultPlan"), '{mode}', '"all_selected"')
    IS DISTINCT FROM "defaultPlan";

-- Personal defaults: Search turned off, left without a source or unreadable
-- follows the organization default again; chosen sources are all searched.
UPDATE "UserSettings" AS settings
SET "defaultSearchPlan" = cleaned."plan", "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT current."id", CASE
      WHEN jsonb_typeof(current."defaultSearchPlan" -> 'optionIds') IS DISTINCT FROM 'array' THEN NULL
      WHEN jsonb_array_length(aiqsa_search_plan_without_retired(current."defaultSearchPlan") -> 'optionIds') = 0 THEN NULL
      ELSE jsonb_set(aiqsa_search_plan_without_retired(current."defaultSearchPlan"), '{mode}', '"all_selected"')
    END AS "plan"
  FROM "UserSettings" AS current
  WHERE current."defaultSearchPlan" IS NOT NULL
) AS cleaned
WHERE settings."id" = cleaned."id"
  AND cleaned."plan" IS DISTINCT FROM settings."defaultSearchPlan";

-- Telegram follows the same personal default, with Search on.
UPDATE "TelegramLink" SET "searchEnabled" = true WHERE NOT "searchEnabled";

-- Assistants keep their own Search choice, only without a retired source.
-- Their version stays, so an approved installation-wide listing still covers
-- them; a row left without a source uses the user's default Search.
ALTER TABLE "AssistantDefinition" DISABLE TRIGGER "AssistantDefinition_version";
ALTER TABLE "AssistantDefinition" DISABLE TRIGGER "AssistantDefinition_project_invalidation";
UPDATE "AssistantDefinition"
SET "searchPlan" = CASE
    WHEN jsonb_array_length(aiqsa_search_plan_without_retired("searchPlan") -> 'optionIds') = 0
      THEN '{"mode":"inherit"}'::jsonb
    ELSE aiqsa_search_plan_without_retired("searchPlan")
  END,
  "searchPolicy" = CASE
    WHEN jsonb_array_length(aiqsa_search_plan_without_retired("searchPlan") -> 'optionIds') = 0
      THEN 'adjustable'::"AssistantRowPolicy"
    ELSE "searchPolicy"
  END
WHERE jsonb_typeof("searchPlan" -> 'optionIds') = 'array'
  AND aiqsa_search_plan_without_retired("searchPlan") IS DISTINCT FROM "searchPlan";
ALTER TABLE "AssistantDefinition" ENABLE TRIGGER "AssistantDefinition_version";
ALTER TABLE "AssistantDefinition" ENABLE TRIGGER "AssistantDefinition_project_invalidation";

DROP FUNCTION aiqsa_search_plan_without_retired(JSONB);
DROP TABLE "aiqsa_retired_search";
DROP TABLE "aiqsa_search_replacement";
