-- Logical Search options separate the stable user/admin choice from one or
-- more physical execution routes. Historical run rows remain exact archaeology:
-- this migration does not rewrite SearchRunBinding, SearchRun, or ModelRun.

BEGIN;

-- Gemini became a code-owned connection template after the original provider
-- control-plane migration. Install its disabled draft before logical Search
-- parents require an exact source. Preserve any already-installed template.
INSERT INTO "ProviderConnection" (
  "id", "templateKey", "displayName", "family", "enabled",
  "unassignedPolicy", "draftConfig", "draftVersion", "activeConfig",
  "activeVersion", "activatedAt", "createdAt", "updatedAt"
)
SELECT
  '00000000-0000-4000-8000-000000001105',
  'gemini',
  'Gemini',
  'gemini',
  false,
  'use_default',
  '{"apiRoot":"https://generativelanguage.googleapis.com/v1","allowPrivateNetwork":false}'::jsonb,
  1,
  NULL,
  0,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ProviderConnection" WHERE "templateKey" = 'gemini'
)
AND NOT EXISTS (
  SELECT 1 FROM "ProviderConnection"
  WHERE "id" = '00000000-0000-4000-8000-000000001105'
);

DO $migration$
BEGIN
  IF (
    SELECT count(*)
    FROM "ProviderConnection"
    WHERE "templateKey" IN ('openai', 'gemini', 'openrouter')
  ) <> 3 THEN
    RAISE EXCEPTION 'Logical Search option migration could not resolve the code-owned source connections';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy"
    WHERE "kind" NOT IN (
      'none',
      'openai_native_web_search',
      'gemini_google_search',
      'perplexity_tool_search',
      'provider_model_web_search'
    )
  ) THEN
    RAISE EXCEPTION 'Logical Search option migration found an unsupported physical route kind';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy"
    WHERE ("strategyId" = 'search-disabled') <> ("kind" = 'none')
  ) THEN
    RAISE EXCEPTION 'Logical Search option migration found an ambiguous connectionless Off route';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    LEFT JOIN "ProviderModel" model ON model."id" = strategy."providerModelId"
    WHERE strategy."strategyId" NOT IN (
      'search-disabled',
      'openai-native-web-search',
      'gemini-google-search',
      'perplexity-tool-search'
    )
      AND model."connectionId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Logical Search option migration found an ambiguous legacy route source';
  END IF;
END
$migration$;

CREATE TABLE "SearchOption" (
  "id" TEXT NOT NULL,
  "optionId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "templateKey" TEXT,
  "sourceConnectionId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchOption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SearchOption_text_check" CHECK (
    btrim("optionId") <> ''
    AND char_length("optionId") <= 160
    AND btrim("displayName") <> ''
    AND char_length("displayName") <= 160
    AND btrim("description") <> ''
    AND char_length("description") <= 500
    AND (
      "templateKey" IS NULL
      OR (btrim("templateKey") <> '' AND char_length("templateKey") <= 160)
    )
  ),
  CONSTRAINT "SearchOption_kind_check" CHECK (
    "kind" IN ('none', 'web_search', 'gemini_google_search', 'perplexity_search')
  ),
  CONSTRAINT "SearchOption_source_check" CHECK (
    (
      "kind" = 'none'
      AND "optionId" = 'search-disabled'
      AND "sourceConnectionId" IS NULL
    ) OR (
      "kind" <> 'none'
      AND "sourceConnectionId" IS NOT NULL
    )
  ),
  CONSTRAINT "SearchOption_archive_check" CHECK (
    "archivedAt" IS NULL OR NOT "enabled"
  )
);

CREATE UNIQUE INDEX "SearchOption_optionId_key"
ON "SearchOption"("optionId");
CREATE UNIQUE INDEX "SearchOption_templateKey_key"
ON "SearchOption"("templateKey");
CREATE INDEX "SearchOption_sourceConnectionId_idx"
ON "SearchOption"("sourceConnectionId");
CREATE INDEX "SearchOption_enabled_archivedAt_idx"
ON "SearchOption"("enabled", "archivedAt");

ALTER TABLE "SearchOption"
ADD CONSTRAINT "SearchOption_sourceConnectionId_fkey"
FOREIGN KEY ("sourceConnectionId") REFERENCES "ProviderConnection"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fixed parent identities keep the established built-in option ids while
-- replacing transport language with one logical source identity.
WITH code_options(
  "id", "optionId", "displayName", "description", "kind", "templateKey",
  "sourceTemplateKey", "routeIds"
) AS (
  VALUES
    (
      '00000000-0000-4000-8000-000000001401',
      'search-disabled',
      'Off',
      'Answer without web search.',
      'none',
      'search:none',
      NULL::TEXT,
      ARRAY['search-disabled']::TEXT[]
    ),
    (
      '00000000-0000-4000-8000-000000001402',
      'openai-native-web-search',
      'OpenAI Search',
      'Web search provided by OpenAI.',
      'web_search',
      'search:openai',
      'openai',
      ARRAY['openai-native-web-search']::TEXT[]
    ),
    (
      '00000000-0000-4000-8000-000000001403',
      'gemini-google-search',
      'Google Search',
      'Google Search grounding for eligible Gemini models.',
      'gemini_google_search',
      'search:gemini-google',
      'gemini',
      ARRAY['gemini-google-search']::TEXT[]
    ),
    (
      '00000000-0000-4000-8000-000000001404',
      'perplexity-tool-search',
      'Perplexity Search',
      'Web search provided by Perplexity through OpenRouter.',
      'perplexity_search',
      'search:perplexity',
      'openrouter',
      ARRAY['perplexity-tool-search']::TEXT[]
    )
)
INSERT INTO "SearchOption" (
  "id", "optionId", "displayName", "description", "kind", "templateKey",
  "sourceConnectionId", "enabled", "archivedAt", "createdAt", "updatedAt"
)
SELECT
  option_row."id",
  option_row."optionId",
  option_row."displayName",
  option_row."description",
  option_row."kind",
  option_row."templateKey",
  connection."id",
  COALESCE((
    SELECT bool_or(strategy."enabled" AND strategy."archivedAt" IS NULL)
    FROM "SearchStrategy" strategy
    WHERE strategy."strategyId" = ANY(option_row."routeIds")
  ), false),
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM "SearchStrategy" strategy
      WHERE strategy."strategyId" = ANY(option_row."routeIds")
        AND strategy."archivedAt" IS NULL
    ) THEN NULL
    ELSE (
      SELECT max(strategy."archivedAt")
      FROM "SearchStrategy" strategy
      WHERE strategy."strategyId" = ANY(option_row."routeIds")
    )
  END,
  COALESCE((
    SELECT min(strategy."createdAt")
    FROM "SearchStrategy" strategy
    WHERE strategy."strategyId" = ANY(option_row."routeIds")
  ), CURRENT_TIMESTAMP),
  COALESCE((
    SELECT max(strategy."updatedAt")
    FROM "SearchStrategy" strategy
    WHERE strategy."strategyId" = ANY(option_row."routeIds")
  ), CURRENT_TIMESTAMP)
FROM code_options option_row
LEFT JOIN "ProviderConnection" connection
  ON connection."templateKey" = option_row."sourceTemplateKey";

-- Preserve arbitrary operator-created integrations as one logical option per
-- existing route. The client OpenAI alias joins the built-in parent only when
-- its exact provider model belongs to the code-owned OpenAI connection.
INSERT INTO "SearchOption" (
  "id", "optionId", "displayName", "description", "kind", "templateKey",
  "sourceConnectionId", "enabled", "archivedAt", "createdAt", "updatedAt"
)
SELECT
  CASE
    WHEN strategy."strategyId" = 'openai-provider-web-search'
      AND model."connectionId" IS NOT NULL
      THEN 'custom-web-search-option:' || model."connectionId"
    ELSE 'legacy-search-option:' || strategy."id"
  END,
  CASE
    WHEN strategy."strategyId" = 'openai-provider-web-search'
      AND model."connectionId" IS NOT NULL
      THEN 'custom-web-search:' || model."connectionId"
    ELSE strategy."strategyId"
  END,
  CASE
    WHEN strategy."strategyId" = 'openai-provider-web-search'
      AND model."connectionId" IS NOT NULL
      THEN left(
        COALESCE(NULLIF(btrim(connection."displayName"), ''), 'Custom endpoint'),
        153
      ) || ' Search'
    ELSE strategy."displayName"
  END,
  CASE
    WHEN strategy."strategyId" = 'openai-provider-web-search'
      AND model."connectionId" IS NOT NULL
      THEN left(
        'Web search provided by ' ||
          COALESCE(NULLIF(btrim(connection."displayName"), ''), 'Custom endpoint') || '.',
        500
      )
    ELSE strategy."description"
  END,
  CASE strategy."kind"
    WHEN 'none' THEN 'none'
    WHEN 'gemini_google_search' THEN 'gemini_google_search'
    WHEN 'perplexity_tool_search' THEN 'perplexity_search'
    ELSE 'web_search'
  END,
  NULL,
  model."connectionId",
  strategy."enabled" AND strategy."archivedAt" IS NULL,
  strategy."archivedAt",
  strategy."createdAt",
  strategy."updatedAt"
FROM "SearchStrategy" strategy
LEFT JOIN "ProviderModel" model ON model."id" = strategy."providerModelId"
LEFT JOIN "ProviderConnection" connection ON connection."id" = model."connectionId"
WHERE strategy."strategyId" NOT IN (
  'search-disabled',
  'openai-native-web-search',
  'gemini-google-search',
  'perplexity-tool-search'
)
AND (
  strategy."strategyId" <> 'openai-provider-web-search'
  OR connection."templateKey" IS DISTINCT FROM 'openai'
);

ALTER TABLE "SearchStrategy"
ADD COLUMN "searchOptionId" TEXT;

UPDATE "SearchStrategy" strategy
SET "searchOptionId" = CASE strategy."strategyId"
  WHEN 'search-disabled' THEN '00000000-0000-4000-8000-000000001401'
  WHEN 'openai-native-web-search' THEN '00000000-0000-4000-8000-000000001402'
  WHEN 'openai-provider-web-search' THEN COALESCE((
    SELECT CASE
      WHEN connection."templateKey" = 'openai'
        THEN '00000000-0000-4000-8000-000000001402'
      ELSE 'custom-web-search-option:' || connection."id"
    END
    FROM "ProviderModel" model
    INNER JOIN "ProviderConnection" connection ON connection."id" = model."connectionId"
    WHERE model."id" = strategy."providerModelId"
  ), 'legacy-search-option:' || strategy."id")
  WHEN 'gemini-google-search' THEN '00000000-0000-4000-8000-000000001403'
  WHEN 'perplexity-tool-search' THEN '00000000-0000-4000-8000-000000001404'
  ELSE 'legacy-search-option:' || strategy."id"
END;

-- Capture only exact, already-active custom Responses declarations. The
-- migration makes no provider request and does not infer support from names.
CREATE TEMP TABLE "_LogicalSearchCustomCandidates" ON COMMIT DROP AS
SELECT
  connection."id" AS "connectionId",
  connection."displayName" AS "connectionDisplayName",
  count(*)::INTEGER AS "qualifyingModelCount",
  min(model."id") AS "providerModelId"
FROM "ProviderConnection" connection
INNER JOIN "ProviderModel" model ON model."connectionId" = connection."id"
WHERE connection."family" = 'openai_compatible'
  AND connection."enabled"
  AND connection."activeVersion" > 0
  AND connection."activeConfig" IS NOT NULL
  AND model."enabled"
  AND model."activeVersion" > 0
  AND model."activeConfig" IS NOT NULL
  AND model."activeConfig" ->> 'adapterKind' = 'openai_responses_compatible'
  AND model."activeConfig" #> '{capabilities,nativeSearch}' = 'true'::jsonb
  AND model."supportsNativeSearch"
GROUP BY connection."id", connection."displayName";

INSERT INTO "SearchOption" (
  "id", "optionId", "displayName", "description", "kind", "templateKey",
  "sourceConnectionId", "enabled", "archivedAt", "createdAt", "updatedAt"
)
SELECT
  'custom-web-search-option:' || candidate."connectionId",
  'custom-web-search:' || candidate."connectionId",
  left(
    COALESCE(NULLIF(btrim(candidate."connectionDisplayName"), ''), 'Custom endpoint'),
    153
  ) || ' Search',
  left(
    'Web search provided by ' ||
      COALESCE(NULLIF(btrim(candidate."connectionDisplayName"), ''), 'Custom endpoint') || '.',
    500
  ),
  'web_search',
  NULL,
  candidate."connectionId",
  true,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_LogicalSearchCustomCandidates" candidate
WHERE NOT EXISTS (
  SELECT 1
  FROM "SearchOption" existing
  WHERE existing."optionId" = 'custom-web-search:' || candidate."connectionId"
     OR existing."id" = 'custom-web-search-option:' || candidate."connectionId"
);

-- The hosted route preserves the existing same-connection behavior. Its
-- evidence records configuration adoption, not a source-bearing web probe.
INSERT INTO "SearchStrategy" (
  "id", "searchOptionId", "strategyId", "provider", "modelId",
  "providerModelId", "displayName", "kind", "description", "enabled",
  "config", "adapterKind", "credentialMode", "draft", "draftVersion",
  "testedDraftHash", "draftTestEvidence", "activeRevisionId", "activatedAt",
  "archivedAt", "createdAt", "updatedAt"
)
SELECT
  'custom-web-search-hosted:' || candidate."connectionId",
  option_row."id",
  'custom-web-search-hosted:' || candidate."connectionId",
  'openai_compatible',
  NULL,
  NULL,
  option_row."displayName",
  'openai_native_web_search',
  option_row."description",
  true,
  '{"adapterKind":"answer_provider_hosted","credentialMode":"answer_provider","maxResults":8,"protocol":"openai_responses_web_search","providerModelId":null,"queryMaxCharacters":500,"timeoutMs":300000}'::jsonb,
  'answer_provider_hosted',
  'answer_provider',
  '{"adapterKind":"answer_provider_hosted","credentialMode":"answer_provider","maxResults":8,"protocol":"openai_responses_web_search","providerModelId":null,"queryMaxCharacters":500,"timeoutMs":300000}'::jsonb,
  1,
  '16f7088d66579a2e9986b10d957ac03c1e0a295fe99a32ae1baa7cafc3ad492d',
  jsonb_build_object(
    'method', 'migration_configuration',
    'normalizedSourceCount', 0,
    'protocol', 'openai_responses_web_search',
    'sourceProbe', false,
    'status', 'available'
  ),
  NULL,
  CURRENT_TIMESTAMP,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_LogicalSearchCustomCandidates" candidate
INNER JOIN "SearchOption" option_row
  ON option_row."id" = 'custom-web-search-option:' || candidate."connectionId"
 AND option_row."sourceConnectionId" = candidate."connectionId"
WHERE NOT EXISTS (
  SELECT 1
  FROM "SearchStrategy" existing
  WHERE existing."id" = 'custom-web-search-hosted:' || candidate."connectionId"
     OR existing."strategyId" = 'custom-web-search-hosted:' || candidate."connectionId"
);

INSERT INTO "SearchIntegrationRevision" (
  "id", "searchStrategyId", "revisionNumber", "adapterKind",
  "credentialMode", "configuration", "providerModelId",
  "validationEvidence", "draftHash", "createdAt"
)
SELECT
  'custom-web-search-hosted-revision:' || candidate."connectionId",
  strategy."id",
  1,
  'answer_provider_hosted',
  'answer_provider',
  strategy."draft",
  NULL,
  strategy."draftTestEvidence",
  strategy."testedDraftHash",
  CURRENT_TIMESTAMP
FROM "_LogicalSearchCustomCandidates" candidate
INNER JOIN "SearchStrategy" strategy
  ON strategy."id" = 'custom-web-search-hosted:' || candidate."connectionId"
 AND strategy."searchOptionId" = 'custom-web-search-option:' || candidate."connectionId"
WHERE strategy."activeRevisionId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "SearchIntegrationRevision" revision
    WHERE revision."id" = 'custom-web-search-hosted-revision:' || candidate."connectionId"
  );

UPDATE "SearchStrategy" strategy
SET
  "activeRevisionId" = revision."id",
  "activatedAt" = COALESCE(strategy."activatedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "SearchIntegrationRevision" revision
WHERE strategy."id" LIKE 'custom-web-search-hosted:%'
  AND revision."id" = 'custom-web-search-hosted-revision:' ||
    substring(strategy."id" FROM char_length('custom-web-search-hosted:') + 1)
  AND revision."searchStrategyId" = strategy."id";

-- A query-only route is merely a draft until a source-bearing administrator
-- probe succeeds. Multiple qualifying models are deliberately left for an
-- explicit admin choice rather than guessed by id or display name.
INSERT INTO "SearchStrategy" (
  "id", "searchOptionId", "strategyId", "provider", "modelId",
  "providerModelId", "displayName", "kind", "description", "enabled",
  "config", "adapterKind", "credentialMode", "draft", "draftVersion",
  "testedDraftHash", "draftTestEvidence", "activeRevisionId", "activatedAt",
  "archivedAt", "createdAt", "updatedAt"
)
SELECT
  'custom-web-search-client:' || candidate."connectionId",
  option_row."id",
  'custom-web-search-client:' || candidate."connectionId",
  'openai_compatible',
  model."modelId",
  model."id",
  option_row."displayName",
  'provider_model_web_search',
  option_row."description",
  false,
  '{}'::jsonb,
  'provider_model_client',
  'provider_model',
  jsonb_build_object(
    'adapterKind', 'provider_model_client',
    'credentialMode', 'provider_model',
    'maxResults', 8,
    'protocol', 'openai_responses_web_search',
    'providerModelId', model."id",
    'queryMaxCharacters', 500,
    'timeoutMs', 300000
  ),
  1,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_LogicalSearchCustomCandidates" candidate
INNER JOIN "SearchOption" option_row
  ON option_row."id" = 'custom-web-search-option:' || candidate."connectionId"
 AND option_row."sourceConnectionId" = candidate."connectionId"
INNER JOIN "ProviderModel" model ON model."id" = candidate."providerModelId"
WHERE candidate."qualifyingModelCount" = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "SearchStrategy" existing
    WHERE existing."searchOptionId" = option_row."id"
      AND existing."adapterKind" = 'provider_model_client'
      AND existing."credentialMode" = 'provider_model'
  );

-- Older installations could contain several physical routes for one exact
-- provider destination. They become children of one stable logical parent;
-- built-ins and connection-scoped custom parents win deterministically.
CREATE TEMP TABLE "_LogicalSearchOptionCollapse" ON COMMIT DROP AS
SELECT
  option_row."id" AS "oldOptionRowId",
  option_row."optionId" AS "oldOptionId",
  first_value(option_row."id") OVER destination AS "keeperOptionRowId",
  first_value(option_row."optionId") OVER destination AS "keeperOptionId"
FROM "SearchOption" option_row
WHERE option_row."sourceConnectionId" IS NOT NULL
WINDOW destination AS (
  PARTITION BY option_row."sourceConnectionId", option_row."kind"
  ORDER BY
    CASE
      WHEN option_row."templateKey" IS NOT NULL THEN 0
      WHEN option_row."optionId" = 'custom-web-search:' || option_row."sourceConnectionId" THEN 1
      ELSE 2
    END,
    option_row."createdAt",
    option_row."id"
  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
);

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    INNER JOIN "_LogicalSearchOptionCollapse" collapse_row
      ON collapse_row."oldOptionRowId" = strategy."searchOptionId"
    WHERE strategy."archivedAt" IS NULL
    GROUP BY collapse_row."keeperOptionRowId", strategy."adapterKind"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Logical Search option migration found ambiguous active physical routes';
  END IF;
END
$migration$;

WITH destination_state AS (
  SELECT
    collapse_row."keeperOptionRowId",
    bool_or(option_row."enabled" AND option_row."archivedAt" IS NULL) AS "enabled",
    bool_or(option_row."archivedAt" IS NULL) AS "hasUnarchived",
    max(option_row."archivedAt") AS "archivedAt",
    max(option_row."updatedAt") AS "updatedAt"
  FROM "_LogicalSearchOptionCollapse" collapse_row
  INNER JOIN "SearchOption" option_row
    ON option_row."id" = collapse_row."oldOptionRowId"
  GROUP BY collapse_row."keeperOptionRowId"
)
UPDATE "SearchOption" keeper
SET
  "enabled" = destination_state."enabled",
  "archivedAt" = CASE
    WHEN destination_state."hasUnarchived" THEN NULL
    ELSE destination_state."archivedAt"
  END,
  "updatedAt" = destination_state."updatedAt"
FROM destination_state
WHERE keeper."id" = destination_state."keeperOptionRowId";

UPDATE "SearchStrategy" strategy
SET "searchOptionId" = collapse_row."keeperOptionRowId"
FROM "_LogicalSearchOptionCollapse" collapse_row
WHERE strategy."searchOptionId" = collapse_row."oldOptionRowId"
  AND collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId";

DELETE FROM "SearchOption" option_row
USING "_LogicalSearchOptionCollapse" collapse_row
WHERE option_row."id" = collapse_row."oldOptionRowId"
  AND collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId";

CREATE UNIQUE INDEX "SearchOption_sourceConnectionId_kind_key"
ON "SearchOption"("sourceConnectionId", "kind");

CREATE UNIQUE INDEX "SearchStrategy_searchOptionId_adapterKind_active_key"
ON "SearchStrategy"("searchOptionId", "adapterKind")
WHERE "archivedAt" IS NULL;

-- A source-bearing client probe is valid only for the exact non-secret
-- connection/model/credential-version authority that produced it. Preserve
-- old immutable revisions as legacy evidence while allowing a fresh revision
-- for the same transport draft after authority rotation.
ALTER TABLE "SearchIntegrationRevision"
ADD COLUMN "validationFingerprint" TEXT NOT NULL DEFAULT 'legacy';

DROP INDEX "SearchIntegrationRevision_strategy_draftHash_key";

CREATE UNIQUE INDEX "SearchIntegrationRevision_strategy_draft_validation_key"
ON "SearchIntegrationRevision"(
  "searchStrategyId",
  "draftHash",
  "validationFingerprint"
);

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy"
    WHERE "searchOptionId" IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM "SearchOption" WHERE "id" = "SearchStrategy"."searchOptionId"
       )
  ) THEN
    RAISE EXCEPTION 'Logical Search option migration left an unowned physical route';
  END IF;
END
$migration$;

ALTER TABLE "SearchStrategy"
ALTER COLUMN "searchOptionId" SET NOT NULL;

CREATE INDEX "SearchStrategy_searchOptionId_idx"
ON "SearchStrategy"("searchOptionId");

ALTER TABLE "SearchStrategy"
ADD CONSTRAINT "SearchStrategy_searchOptionId_fkey"
FOREIGN KEY ("searchOptionId") REFERENCES "SearchOption"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preferences and grants that named a physical route promoted to a discarded
-- parent now follow the deterministic keeper. Historical run bindings remain
-- untouched and continue to name their original physical route and revision.
UPDATE "UserSettings" settings
SET
  "defaultSearchPlan" = jsonb_set(
    settings."defaultSearchPlan",
    '{optionIds}',
    (
      SELECT COALESCE(
        jsonb_agg(to_jsonb(deduplicated."mappedOptionId")
          ORDER BY deduplicated."firstOrdinal"),
        '[]'::jsonb
      )
      FROM (
        SELECT
          mapped."mappedOptionId",
          min(mapped.ordinality) AS "firstOrdinal"
        FROM (
          SELECT
            COALESCE((
              SELECT collapse_row."keeperOptionId"
              FROM "_LogicalSearchOptionCollapse" collapse_row
              WHERE collapse_row."oldOptionId" = option_id
            ), option_id) AS "mappedOptionId",
            ordinality
          FROM jsonb_array_elements_text(settings."defaultSearchPlan" -> 'optionIds')
            WITH ORDINALITY AS option_row(option_id, ordinality)
        ) mapped
        GROUP BY mapped."mappedOptionId"
      ) deduplicated
    ),
    false
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE settings."defaultSearchPlan" IS NOT NULL
  AND jsonb_typeof(settings."defaultSearchPlan") = 'object'
  AND jsonb_typeof(settings."defaultSearchPlan" -> 'optionIds') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(settings."defaultSearchPlan" -> 'optionIds') element
    WHERE jsonb_typeof(element) <> 'string'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(settings."defaultSearchPlan" -> 'optionIds')
      AS plan_option(option_id)
    INNER JOIN "_LogicalSearchOptionCollapse" collapse_row
      ON collapse_row."oldOptionId" = option_id
    WHERE collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId"
  );

UPDATE "UserSettings" settings
SET
  "defaultSearchStrategyId" = collapse_row."keeperOptionId",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_LogicalSearchOptionCollapse" collapse_row
WHERE settings."defaultSearchStrategyId" = collapse_row."oldOptionId"
  AND collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId";

UPDATE "SearchPolicy" policy
SET
  "defaultPlan" = jsonb_set(
    policy."defaultPlan",
    '{optionIds}',
    (
      SELECT COALESCE(
        jsonb_agg(to_jsonb(deduplicated."mappedOptionId")
          ORDER BY deduplicated."firstOrdinal"),
        '[]'::jsonb
      )
      FROM (
        SELECT
          mapped."mappedOptionId",
          min(mapped.ordinality) AS "firstOrdinal"
        FROM (
          SELECT
            COALESCE((
              SELECT collapse_row."keeperOptionId"
              FROM "_LogicalSearchOptionCollapse" collapse_row
              WHERE collapse_row."oldOptionId" = option_id
            ), option_id) AS "mappedOptionId",
            ordinality
          FROM jsonb_array_elements_text(policy."defaultPlan" -> 'optionIds')
            WITH ORDINALITY AS option_row(option_id, ordinality)
        ) mapped
        GROUP BY mapped."mappedOptionId"
      ) deduplicated
    ),
    false
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE jsonb_typeof(policy."defaultPlan") = 'object'
  AND jsonb_typeof(policy."defaultPlan" -> 'optionIds') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(policy."defaultPlan" -> 'optionIds') element
    WHERE jsonb_typeof(element) <> 'string'
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(policy."defaultPlan" -> 'optionIds')
      AS plan_option(option_id)
    INNER JOIN "_LogicalSearchOptionCollapse" collapse_row
      ON collapse_row."oldOptionId" = option_id
    WHERE collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId"
  );

UPDATE "AccessGrant" grant_row
SET
  "searchStrategy" = collapse_row."keeperOptionId",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_LogicalSearchOptionCollapse" collapse_row
WHERE grant_row."searchStrategy" = collapse_row."oldOptionId"
  AND collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId";

-- Resolve the legacy client alias through its exact physical route. It maps
-- to official OpenAI only when that route is sourced by the official
-- connection; a custom route maps to its connection-scoped logical parent.
CREATE TEMP TABLE "_LogicalSearchAliasTarget" ON COMMIT DROP AS
SELECT option_row."optionId" AS "optionId"
FROM "SearchStrategy" strategy
INNER JOIN "SearchOption" option_row ON option_row."id" = strategy."searchOptionId"
WHERE strategy."strategyId" = 'openai-provider-web-search';

-- The old hosted id inherited the answer model's connection. Preserve that
-- meaning only when a user's stored default answer model resolves to exactly
-- one canonical logical source. Missing or ambiguous ownership stays absent
-- and is handled fail closed below.
CREATE TEMP TABLE "_LogicalSearchUserNativeTarget" ON COMMIT DROP AS
SELECT
  settings."userId",
  min(option_row."optionId") AS "optionId"
FROM "UserSettings" settings
INNER JOIN "ProviderModel" model ON model."id" = settings."defaultProviderModelId"
INNER JOIN "ProviderConnection" connection ON connection."id" = model."connectionId"
INNER JOIN "SearchOption" option_row
  ON option_row."sourceConnectionId" = connection."id"
 AND option_row."kind" = 'web_search'
 AND option_row."archivedAt" IS NULL
 AND (
   option_row."templateKey" = 'search:openai'
   OR option_row."optionId" = 'custom-web-search:' || connection."id"
 )
WHERE model."supportsNativeSearch"
  AND COALESCE(model."activeConfig", model."draftConfig") ->> 'adapterKind' IN (
    'openai_responses_native',
    'openai_responses_compatible'
  )
GROUP BY settings."userId"
HAVING count(DISTINCT option_row."optionId") = 1;

UPDATE "UserSettings" settings
SET
  "defaultSearchPlan" = jsonb_set(
    settings."defaultSearchPlan",
    '{optionIds}',
    (
      SELECT COALESCE(
        jsonb_agg(to_jsonb(deduplicated."mappedOptionId")
          ORDER BY deduplicated."firstOrdinal"),
        '[]'::jsonb
      )
      FROM (
        SELECT
          mapped."mappedOptionId",
          min(mapped.ordinality) AS "firstOrdinal"
        FROM (
          SELECT
            CASE
              WHEN option_id = 'openai-provider-web-search' THEN (
                SELECT "optionId" FROM "_LogicalSearchAliasTarget"
              )
              WHEN option_id = 'openai-native-web-search' THEN (
                SELECT "optionId"
                FROM "_LogicalSearchUserNativeTarget" target
                WHERE target."userId" = settings."userId"
              )
              ELSE option_id
            END AS "mappedOptionId",
            ordinality
          FROM jsonb_array_elements_text(settings."defaultSearchPlan" -> 'optionIds')
            WITH ORDINALITY AS option_row(option_id, ordinality)
        ) mapped
        WHERE mapped."mappedOptionId" IS NOT NULL
        GROUP BY mapped."mappedOptionId"
      ) deduplicated
    ),
    false
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE settings."defaultSearchPlan" IS NOT NULL
  AND jsonb_typeof(settings."defaultSearchPlan") = 'object'
  AND jsonb_typeof(settings."defaultSearchPlan" -> 'optionIds') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(settings."defaultSearchPlan" -> 'optionIds') element
    WHERE jsonb_typeof(element) <> 'string'
  )
  AND (
    (settings."defaultSearchPlan" -> 'optionIds') ? 'openai-provider-web-search'
    OR (settings."defaultSearchPlan" -> 'optionIds') ? 'openai-native-web-search'
  );

UPDATE "UserSettings" settings
SET
  "defaultSearchStrategyId" = CASE
    WHEN settings."defaultSearchStrategyId" = 'openai-provider-web-search' THEN COALESCE(
      (SELECT "optionId" FROM "_LogicalSearchAliasTarget"),
      'search-disabled'
    )
    ELSE COALESCE((
      SELECT "optionId"
      FROM "_LogicalSearchUserNativeTarget" target
      WHERE target."userId" = settings."userId"
    ), 'search-disabled')
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE settings."defaultSearchStrategyId" IN (
  'openai-provider-web-search',
  'openai-native-web-search'
);

UPDATE "SearchPolicy" policy
SET
  "defaultPlan" = jsonb_set(
    policy."defaultPlan",
    '{optionIds}',
    (
      SELECT COALESCE(
        jsonb_agg(to_jsonb(deduplicated."mappedOptionId")
          ORDER BY deduplicated."firstOrdinal"),
        '[]'::jsonb
      )
      FROM (
        SELECT
          mapped."mappedOptionId",
          min(mapped.ordinality) AS "firstOrdinal"
        FROM (
          SELECT
            CASE
              WHEN option_id = 'openai-provider-web-search' THEN (
                SELECT "optionId" FROM "_LogicalSearchAliasTarget"
              )
              WHEN option_id = 'openai-native-web-search' THEN NULL
              ELSE option_id
            END AS "mappedOptionId",
            ordinality
          FROM jsonb_array_elements_text(policy."defaultPlan" -> 'optionIds')
            WITH ORDINALITY AS option_row(option_id, ordinality)
        ) mapped
        WHERE mapped."mappedOptionId" IS NOT NULL
        GROUP BY mapped."mappedOptionId"
      ) deduplicated
    ),
    false
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE jsonb_typeof(policy."defaultPlan") = 'object'
  AND jsonb_typeof(policy."defaultPlan" -> 'optionIds') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(policy."defaultPlan" -> 'optionIds') element
    WHERE jsonb_typeof(element) <> 'string'
  )
  AND (
    (policy."defaultPlan" -> 'optionIds') ? 'openai-provider-web-search'
    OR (policy."defaultPlan" -> 'optionIds') ? 'openai-native-web-search'
  );

-- A legacy native grant inherited whichever answer connection a request used.
-- Preserve it only for a direct user with one exact default-model destination;
-- group/global or otherwise ambiguous grants remain visible but disabled.
UPDATE "AccessGrant" grant_row
SET
  "searchStrategy" = COALESCE((
    SELECT target."optionId"
    FROM "_LogicalSearchUserNativeTarget" target
    WHERE target."userId" = grant_row."userId"
  ), grant_row."searchStrategy"),
  "enabled" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "_LogicalSearchUserNativeTarget" target
      WHERE target."userId" = grant_row."userId"
    ) THEN grant_row."enabled"
    ELSE false
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE grant_row."searchStrategy" = 'openai-native-web-search';

UPDATE "AccessGrant" grant_row
SET
  "searchStrategy" = COALESCE(
    (SELECT "optionId" FROM "_LogicalSearchAliasTarget"),
    grant_row."searchStrategy"
  ),
  "enabled" = CASE
    WHEN EXISTS (SELECT 1 FROM "_LogicalSearchAliasTarget") THEN grant_row."enabled"
    ELSE false
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE grant_row."searchStrategy" = 'openai-provider-web-search';

CREATE TEMP TABLE "_LogicalSearchGrantCollapse" ON COMMIT DROP AS
SELECT
  grant_row."id",
  first_value(grant_row."id") OVER (
    PARTITION BY grant_row."userId", grant_row."groupId", grant_row."searchStrategy"
    ORDER BY grant_row."createdAt", grant_row."id"
  ) AS "keeperId",
  bool_or(grant_row."enabled") OVER (
    PARTITION BY grant_row."userId", grant_row."groupId", grant_row."searchStrategy"
  ) AS "mergedEnabled"
FROM "AccessGrant" grant_row
WHERE grant_row."searchStrategy" IN (
  SELECT collapse_row."keeperOptionId"
  FROM "_LogicalSearchOptionCollapse" collapse_row
  WHERE collapse_row."oldOptionRowId" <> collapse_row."keeperOptionRowId"
  UNION
  SELECT target."optionId" FROM "_LogicalSearchUserNativeTarget" target
  UNION
  SELECT target."optionId" FROM "_LogicalSearchAliasTarget" target
  UNION
  SELECT 'openai-native-web-search'
  UNION
  SELECT 'openai-provider-web-search'
);

UPDATE "AccessGrant" grant_row
SET
  "enabled" = collapse_row."mergedEnabled",
  "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "keeperId", "mergedEnabled"
  FROM "_LogicalSearchGrantCollapse"
) collapse_row
WHERE grant_row."id" = collapse_row."keeperId";

DELETE FROM "AccessGrant" grant_row
USING "_LogicalSearchGrantCollapse" collapse_row
WHERE grant_row."id" = collapse_row."id"
  AND collapse_row."id" <> collapse_row."keeperId";

COMMIT;
