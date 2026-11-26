-- One Search engine for every model and mode (operator decisions 2026-11-26).
-- Users only switch Search on or off; the administrator chooses the engine,
-- else the first ready source in the default order searches
-- (`lib/server/search/engineResolution.ts`); an optional backup answers only a
-- failed call; OpenAI-protocol answer models with verified hosted search
-- search inside their own answer while `inAnswerSearch` is on.
--
-- What carries over, and how:
-- - The organization default becomes the engine: its first live source with a
--   client route (the route every model and mode searches through) is the
--   engine, the next such source the backup. A hosted-only or archived source
--   cannot be either and is left out; an empty default, or one with no such
--   source, lets the default order pick the engine. A chosen source that is
--   off or broken right now stays chosen and shows its reason, never replaced.
-- - Personal defaults, Assistants and chats keep their stored plans, which the
--   new release reads as on or off: a plan that names any source is on, one
--   without sources is off, no personal plan is on. Nothing here rewrites them,
--   so the previous release, still serving while Compose replaces containers,
--   reads every row as before.
-- - Grants stay as they are: a grant of any Search source, or Full access,
--   lets its holders search with the installation's engine.
-- - Telegram links and Automations keep their own Search switches.
-- `defaultPlan` stays for the previous release; the new release keeps it in
-- step with the engine and backup until a later release drops it.

ALTER TABLE "SearchPolicy"
  ADD COLUMN "engineOptionId" TEXT,
  ADD COLUMN "backupOptionId" TEXT,
  ADD COLUMN "inAnswerSearch" BOOLEAN NOT NULL DEFAULT true;

WITH "chosen" AS (
  SELECT policy."id", item.element AS "optionId", min(item.position) AS "position"
  FROM "SearchPolicy" AS policy
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(policy."defaultPlan" -> 'optionIds') = 'array'
      THEN policy."defaultPlan" -> 'optionIds'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS item(element, position)
  WHERE EXISTS (
    SELECT 1
    FROM "SearchOption" AS option
    JOIN "SearchStrategy" AS route ON route."searchOptionId" = option."id"
    WHERE option."optionId" = item.element
      AND option."archivedAt" IS NULL
      AND option."kind" IN ('web_search', 'deepseek_search_api', 'gemini_google_search', 'perplexity_search')
      AND route."archivedAt" IS NULL
      AND route."adapterKind" = 'provider_model_client'
  )
  GROUP BY policy."id", item.element
), "ranked" AS (
  SELECT "id", "optionId", row_number() OVER (PARTITION BY "id" ORDER BY "position") AS "rank"
  FROM "chosen"
)
UPDATE "SearchPolicy" AS policy
SET "engineOptionId" = (SELECT ranked."optionId" FROM "ranked" AS ranked WHERE ranked."id" = policy."id" AND ranked."rank" = 1),
  "backupOptionId" = (SELECT ranked."optionId" FROM "ranked" AS ranked WHERE ranked."id" = policy."id" AND ranked."rank" = 2),
  -- A page of Admin › Search opened before the upgrade cannot write over the new policy.
  "version" = policy."version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP;
