-- Add one code-owned Anthropic Search source. The hosted route is available
-- only to an exact eligible answer deployment; the query-only route is bound
-- to one exact active Anthropic ProviderModel when such a declaration exists.
-- No credential, provider-check, grant, preference, or run-history row is read
-- or rewritten by this catalog migration.

BEGIN;

ALTER TABLE "SearchStrategy"
DROP CONSTRAINT "SearchStrategy_provider_model_check",
ADD CONSTRAINT "SearchStrategy_provider_model_check" CHECK (
  (
    "kind" IN ('perplexity_tool_search', 'provider_model_web_search')
    AND "providerModelId" IS NOT NULL
  )
  OR (
    "kind" = 'gemini_google_search'
    AND (
      (
        "adapterKind" = 'answer_provider_hosted'
        AND "credentialMode" = 'answer_provider'
        AND "providerModelId" IS NULL
      )
      OR (
        "adapterKind" = 'provider_model_client'
        AND "credentialMode" = 'provider_model'
        AND "providerModelId" IS NOT NULL
      )
    )
  )
  OR (
    "kind" = 'anthropic_native_web_search'
    AND "adapterKind" = 'answer_provider_hosted'
    AND "credentialMode" = 'answer_provider'
    AND "providerModelId" IS NULL
  )
  OR (
    "kind" IN ('none', 'openai_native_web_search')
    AND "providerModelId" IS NULL
  )
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ProviderConnection"
    WHERE "id" = '00000000-0000-4000-8000-000000001103'
      AND "templateKey" = 'anthropic'
      AND "family" = 'anthropic'
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration could not resolve the code-owned source connection';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchOption"
    WHERE (
      "id" = '00000000-0000-4000-8000-000000001405'
      OR "optionId" = 'anthropic-web-search'
      OR "templateKey" = 'search:anthropic'
    )
      AND NOT (
        "id" = '00000000-0000-4000-8000-000000001405'
        AND "optionId" = 'anthropic-web-search'
        AND "templateKey" = 'search:anthropic'
        AND "kind" = 'web_search'
        AND "sourceConnectionId" = '00000000-0000-4000-8000-000000001103'
      )
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found a conflicting logical source identity';
  END IF;
END
$migration$;

INSERT INTO "SearchOption" (
  "id", "optionId", "displayName", "description", "kind", "templateKey",
  "sourceConnectionId", "enabled", "archivedAt", "createdAt", "updatedAt"
)
SELECT
  '00000000-0000-4000-8000-000000001405',
  'anthropic-web-search',
  'Anthropic Search',
  'Web search provided by Anthropic.',
  'web_search',
  'search:anthropic',
  '00000000-0000-4000-8000-000000001103',
  true,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "SearchOption"
  WHERE "id" = '00000000-0000-4000-8000-000000001405'
);

CREATE TEMP TABLE "_AnthropicHostedSearch" ON COMMIT DROP AS
SELECT
  option_row."id" AS "searchOptionId",
  jsonb_build_object(
    'adapterKind', 'answer_provider_hosted',
    'credentialMode', 'answer_provider',
    'maxOutputTokens', 4096,
    'maxResults', 8,
    'maxSearchCallsPerAnswer', 2,
    'protocol', 'anthropic_web_search',
    'providerModelId', NULL,
    'queryMaxCharacters', 500,
    'reasoningPolicy', 'provider_default',
    'timeoutMs', 300000
  ) AS "canonicalDraft",
  encode(sha256(convert_to(
    '{"adapterKind":"answer_provider_hosted","credentialMode":"answer_provider"' ||
    ',"maxOutputTokens":4096,"maxResults":8,"maxSearchCallsPerAnswer":2' ||
    ',"protocol":"anthropic_web_search","providerModelId":null' ||
    ',"queryMaxCharacters":500,"reasoningPolicy":"provider_default"' ||
    ',"timeoutMs":300000}',
    'UTF8'
  )), 'hex') AS "draftHash",
  jsonb_build_object(
    'checkedAt', to_char(
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'method', 'configuration',
    'normalizedSourceCount', 0,
    'protocol', 'anthropic_web_search',
    'status', 'available'
  ) AS "configurationEvidence",
  encode(sha256(convert_to('["configuration"]', 'UTF8')), 'hex')
    AS "validationFingerprint"
FROM "SearchOption" option_row
WHERE option_row."id" = '00000000-0000-4000-8000-000000001405';

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    WHERE (
      strategy."id" = 'anthropic-web-search'
      OR strategy."strategyId" = 'anthropic-web-search'
    )
      AND NOT (
        strategy."id" = 'anthropic-web-search'
        AND strategy."strategyId" = 'anthropic-web-search'
        AND strategy."searchOptionId" = '00000000-0000-4000-8000-000000001405'
        AND strategy."provider" = 'anthropic'
        AND strategy."kind" = 'anthropic_native_web_search'
        AND strategy."adapterKind" = 'answer_provider_hosted'
        AND strategy."credentialMode" = 'answer_provider'
        AND strategy."providerModelId" IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found a conflicting hosted route identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    LEFT JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
     AND revision."searchStrategyId" = strategy."id"
    WHERE strategy."id" = 'anthropic-web-search'
      AND (
        strategy."activeRevisionId" IS NULL
        OR revision."id" IS NULL
        OR revision."adapterKind" <> 'answer_provider_hosted'
        OR revision."credentialMode" <> 'answer_provider'
        OR revision."providerModelId" IS NOT NULL
        OR revision."configuration" ->> 'protocol' <> 'anthropic_web_search'
      )
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found an incomplete hosted route';
  END IF;
END
$migration$;

INSERT INTO "SearchStrategy" (
  "id", "searchOptionId", "strategyId", "provider", "modelId",
  "providerModelId", "displayName", "kind", "description", "enabled",
  "config", "adapterKind", "credentialMode", "draft", "draftVersion",
  "testedDraftHash", "draftTestEvidence", "activeRevisionId", "activatedAt",
  "archivedAt", "createdAt", "updatedAt"
)
SELECT
  'anthropic-web-search',
  hosted."searchOptionId",
  'anthropic-web-search',
  'anthropic',
  NULL,
  NULL,
  'Anthropic Search',
  'anthropic_native_web_search',
  'Web search provided by Anthropic.',
  true,
  hosted."canonicalDraft",
  'answer_provider_hosted',
  'answer_provider',
  hosted."canonicalDraft",
  1,
  hosted."draftHash",
  hosted."configurationEvidence",
  NULL,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_AnthropicHostedSearch" hosted
WHERE NOT EXISTS (
  SELECT 1 FROM "SearchStrategy"
  WHERE "id" = 'anthropic-web-search'
     OR "strategyId" = 'anthropic-web-search'
);

INSERT INTO "SearchIntegrationRevision" (
  "id", "searchStrategyId", "revisionNumber", "adapterKind",
  "credentialMode", "configuration", "providerModelId",
  "validationEvidence", "draftHash", "validationFingerprint", "createdAt"
)
SELECT
  'anthropic-web-search:configuration-revision:1',
  strategy."id",
  1,
  'answer_provider_hosted',
  'answer_provider',
  hosted."canonicalDraft",
  NULL,
  hosted."configurationEvidence",
  hosted."draftHash",
  hosted."validationFingerprint",
  CURRENT_TIMESTAMP
FROM "_AnthropicHostedSearch" hosted
INNER JOIN "SearchStrategy" strategy
  ON strategy."id" = 'anthropic-web-search'
WHERE strategy."activeRevisionId" IS NULL;

UPDATE "SearchStrategy" strategy
SET
  "activeRevisionId" = 'anthropic-web-search:configuration-revision:1',
  "activatedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE strategy."id" = 'anthropic-web-search'
  AND strategy."activeRevisionId" IS NULL;

-- Publish the exact-model query-only route only for an already-active model
-- whose normalized active declaration explicitly enables native Search.
CREATE TEMP TABLE "_AnthropicSearchEligibleModels" ON COMMIT DROP AS
SELECT
  option_row."id" AS "searchOptionId",
  option_row."displayName",
  option_row."description",
  connection."id" AS "sourceConnectionId",
  model."id" AS "providerModelId",
  model."provider",
  model."modelId"
FROM "SearchOption" option_row
INNER JOIN "ProviderConnection" connection
  ON connection."id" = option_row."sourceConnectionId"
INNER JOIN "ProviderModel" model
  ON model."connectionId" = connection."id"
WHERE option_row."id" = '00000000-0000-4000-8000-000000001405'
  AND option_row."archivedAt" IS NULL
  AND connection."family" = 'anthropic'
  AND connection."templateKey" = 'anthropic'
  AND connection."enabled"
  AND connection."activeVersion" > 0
  AND connection."activeConfig" IS NOT NULL
  AND model."enabled"
  AND model."activeVersion" > 0
  AND model."activeConfig" IS NOT NULL
  AND model."activeConfig" ->> 'adapterKind' = 'anthropic_messages'
  AND model."activeConfig" #> '{capabilities,nativeSearch}' = 'true'::jsonb;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    WHERE strategy."searchOptionId" = '00000000-0000-4000-8000-000000001405'
      AND strategy."archivedAt" IS NULL
      AND (
        strategy."adapterKind" = 'provider_model_client'
        OR strategy."credentialMode" = 'provider_model'
        OR strategy."kind" = 'provider_model_web_search'
      )
    GROUP BY strategy."searchOptionId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found duplicate current client routes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    WHERE strategy."searchOptionId" = '00000000-0000-4000-8000-000000001405'
      AND strategy."archivedAt" IS NULL
      AND (
        strategy."adapterKind" = 'provider_model_client'
        OR strategy."credentialMode" = 'provider_model'
        OR strategy."kind" = 'provider_model_web_search'
      )
      AND (
        strategy."adapterKind" <> 'provider_model_client'
        OR strategy."credentialMode" <> 'provider_model'
        OR strategy."kind" <> 'provider_model_web_search'
      )
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found a corrupt current client route';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    LEFT JOIN "ProviderModel" model ON model."id" = strategy."providerModelId"
    WHERE strategy."searchOptionId" = '00000000-0000-4000-8000-000000001405'
      AND strategy."archivedAt" IS NULL
      AND strategy."adapterKind" = 'provider_model_client'
      AND model."connectionId" IS DISTINCT FROM '00000000-0000-4000-8000-000000001103'
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found a client route owned by another source';
  END IF;
END
$migration$;

CREATE TEMP TABLE "_AnthropicSearchTarget" ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    eligible.*,
    current_route."id" AS "existingRouteId",
    current_route."strategyId" AS "existingStrategyId",
    row_number() OVER (
      PARTITION BY eligible."searchOptionId"
      ORDER BY
        CASE
          WHEN eligible."providerModelId" = current_route."providerModelId" THEN 0
          WHEN eligible."providerModelId" = '00000000-0000-4000-8000-000000001211' THEN 1
          ELSE 2
        END,
        eligible."providerModelId" COLLATE "C"
    ) AS "modelOrdinal"
  FROM "_AnthropicSearchEligibleModels" eligible
  LEFT JOIN LATERAL (
    SELECT strategy."id", strategy."strategyId", strategy."providerModelId"
    FROM "SearchStrategy" strategy
    WHERE strategy."searchOptionId" = eligible."searchOptionId"
      AND strategy."archivedAt" IS NULL
      AND strategy."adapterKind" = 'provider_model_client'
      AND strategy."credentialMode" = 'provider_model'
    ORDER BY strategy."id" COLLATE "C"
    LIMIT 1
  ) current_route ON true
)
SELECT * FROM ranked WHERE "modelOrdinal" = 1;

CREATE TEMP TABLE "_AnthropicSearchRoute" ON COMMIT DROP AS
SELECT
  target.*,
  COALESCE(target."existingRouteId", identity."id") AS "routeId",
  COALESCE(target."existingStrategyId", identity."strategyId") AS "routeStrategyId"
FROM "_AnthropicSearchTarget" target
LEFT JOIN LATERAL (
  SELECT candidate."id", candidate."strategyId"
  FROM (
    VALUES
      (
        'system-anthropic-web-search-client',
        'anthropic-web-search-client',
        1
      ),
      (
        'anthropic-search-client:' || target."sourceConnectionId",
        'anthropic-search-client:' || target."sourceConnectionId",
        2
      )
  ) candidate("id", "strategyId", priority)
  WHERE target."existingRouteId" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "SearchStrategy" occupied
      WHERE occupied."id" IN (candidate."id", candidate."strategyId")
         OR occupied."strategyId" IN (candidate."id", candidate."strategyId")
    )
  ORDER BY candidate.priority
  LIMIT 1
) identity ON true;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "_AnthropicSearchRoute"
    WHERE "routeId" IS NULL OR "routeStrategyId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration could not allocate a client route identity';
  END IF;
END
$migration$;

CREATE TEMP TABLE "_AnthropicSearchCanonical" ON COMMIT DROP AS
SELECT
  route.*,
  jsonb_build_object(
    'adapterKind', 'provider_model_client',
    'credentialMode', 'provider_model',
    'maxOutputTokens', 4096,
    'maxResults', 8,
    'maxSearchCallsPerAnswer', 2,
    'protocol', 'anthropic_web_search',
    'providerModelId', route."providerModelId",
    'queryMaxCharacters', 500,
    'reasoningPolicy', 'lowest_supported',
    'timeoutMs', 300000
  ) AS "canonicalDraft",
  encode(sha256(convert_to(
    '{"adapterKind":"provider_model_client","credentialMode":"provider_model"' ||
    ',"maxOutputTokens":4096,"maxResults":8,"maxSearchCallsPerAnswer":2' ||
    ',"protocol":"anthropic_web_search","providerModelId":' ||
    to_json(route."providerModelId")::TEXT ||
    ',"queryMaxCharacters":500,"reasoningPolicy":"lowest_supported"' ||
    ',"timeoutMs":300000}',
    'UTF8'
  )), 'hex') AS "draftHash",
  jsonb_build_object(
    'checkedAt', to_char(
      CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'method', 'configuration',
    'normalizedSourceCount', 0,
    'protocol', 'anthropic_web_search',
    'status', 'available'
  ) AS "configurationEvidence",
  encode(sha256(convert_to('["configuration"]', 'UTF8')), 'hex')
    AS "validationFingerprint"
FROM "_AnthropicSearchRoute" route;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_AnthropicSearchCanonical" target
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."searchStrategyId" = target."routeId"
     AND revision."draftHash" = target."draftHash"
     AND revision."validationFingerprint" = target."validationFingerprint"
    WHERE revision."adapterKind" IS DISTINCT FROM 'provider_model_client'
       OR revision."credentialMode" IS DISTINCT FROM 'provider_model'
       OR revision."configuration" IS DISTINCT FROM target."canonicalDraft"
       OR revision."providerModelId" IS DISTINCT FROM target."providerModelId"
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration found a corrupt configuration revision';
  END IF;
END
$migration$;

CREATE TEMP TABLE "_AnthropicSearchPublication" ON COMMIT DROP AS
WITH publication_base AS (
  SELECT
    target.*,
    matching."id" AS "existingRevisionId",
    matching."revisionNumber" AS "existingRevisionNumber",
    matching."validationEvidence" AS "existingRevisionEvidence",
    COALESCE(latest."nextRevisionNumber", 1) AS "nextRevisionNumber"
  FROM "_AnthropicSearchCanonical" target
  LEFT JOIN "SearchIntegrationRevision" matching
    ON matching."searchStrategyId" = target."routeId"
   AND matching."draftHash" = target."draftHash"
   AND matching."validationFingerprint" = target."validationFingerprint"
  LEFT JOIN LATERAL (
    SELECT COALESCE(max(revision."revisionNumber"), 0) + 1 AS "nextRevisionNumber"
    FROM "SearchIntegrationRevision" revision
    WHERE revision."searchStrategyId" = target."routeId"
  ) latest ON true
)
SELECT
  publication_base.*,
  COALESCE(publication_base."existingRevisionId", revision_identity."id")
    AS "revisionId",
  COALESCE(
    publication_base."existingRevisionNumber",
    publication_base."nextRevisionNumber"
  ) AS "revisionNumber",
  COALESCE(
    publication_base."existingRevisionEvidence",
    publication_base."configurationEvidence"
  ) AS "publicationEvidence"
FROM publication_base
LEFT JOIN LATERAL (
  SELECT candidate."id"
  FROM (
    VALUES
      (
        publication_base."routeId" || ':configuration-revision:' ||
          publication_base."nextRevisionNumber"::TEXT,
        1
      ),
      (
        'anthropic-search-revision:' || md5(
          publication_base."routeId" || ':' || publication_base."draftHash"
        ),
        2
      )
  ) candidate("id", priority)
  WHERE publication_base."existingRevisionId" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "SearchIntegrationRevision" occupied
      WHERE occupied."id" = candidate."id"
    )
  ORDER BY candidate.priority
  LIMIT 1
) revision_identity ON true;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "_AnthropicSearchPublication" WHERE "revisionId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration could not allocate a configuration revision identity';
  END IF;
END
$migration$;

INSERT INTO "SearchStrategy" (
  "id", "searchOptionId", "strategyId", "provider", "modelId",
  "providerModelId", "displayName", "kind", "description", "enabled",
  "config", "adapterKind", "credentialMode", "draft", "draftVersion",
  "testedDraftHash", "draftTestEvidence", "activeRevisionId", "activatedAt",
  "archivedAt", "createdAt", "updatedAt"
)
SELECT
  target."routeId",
  target."searchOptionId",
  target."routeStrategyId",
  'anthropic',
  target."modelId",
  target."providerModelId",
  target."displayName",
  'provider_model_web_search',
  target."description",
  true,
  target."canonicalDraft",
  'provider_model_client',
  'provider_model',
  target."canonicalDraft",
  1,
  target."draftHash",
  target."publicationEvidence",
  NULL,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_AnthropicSearchPublication" target
WHERE target."existingRouteId" IS NULL;

INSERT INTO "SearchIntegrationRevision" (
  "id", "searchStrategyId", "revisionNumber", "adapterKind",
  "credentialMode", "configuration", "providerModelId",
  "validationEvidence", "draftHash", "validationFingerprint", "createdAt"
)
SELECT
  target."revisionId",
  target."routeId",
  target."revisionNumber",
  'provider_model_client',
  'provider_model',
  target."canonicalDraft",
  target."providerModelId",
  target."publicationEvidence",
  target."draftHash",
  target."validationFingerprint",
  CURRENT_TIMESTAMP
FROM "_AnthropicSearchPublication" target
WHERE target."existingRevisionId" IS NULL;

UPDATE "SearchStrategy" strategy
SET
  "provider" = 'anthropic',
  "modelId" = target."modelId",
  "providerModelId" = target."providerModelId",
  "displayName" = target."displayName",
  "kind" = 'provider_model_web_search',
  "description" = target."description",
  "enabled" = true,
  "config" = target."canonicalDraft",
  "adapterKind" = 'provider_model_client',
  "credentialMode" = 'provider_model',
  "draftVersion" = CASE
    WHEN strategy."draft" IS DISTINCT FROM target."canonicalDraft"
      THEN strategy."draftVersion" + 1
    ELSE strategy."draftVersion"
  END,
  "draft" = target."canonicalDraft",
  "testedDraftHash" = target."draftHash",
  "draftTestEvidence" = target."publicationEvidence",
  "activeRevisionId" = target."revisionId",
  "activatedAt" = CASE
    WHEN strategy."activeRevisionId" IS DISTINCT FROM target."revisionId"
      OR NOT strategy."enabled"
      THEN CURRENT_TIMESTAMP
    ELSE COALESCE(strategy."activatedAt", CURRENT_TIMESTAMP)
  END,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_AnthropicSearchPublication" target
WHERE strategy."id" = target."routeId"
  AND (
    strategy."provider" IS DISTINCT FROM 'anthropic'
    OR strategy."modelId" IS DISTINCT FROM target."modelId"
    OR strategy."providerModelId" IS DISTINCT FROM target."providerModelId"
    OR strategy."displayName" IS DISTINCT FROM target."displayName"
    OR strategy."kind" IS DISTINCT FROM 'provider_model_web_search'
    OR strategy."description" IS DISTINCT FROM target."description"
    OR strategy."enabled" IS DISTINCT FROM true
    OR strategy."config" IS DISTINCT FROM target."canonicalDraft"
    OR strategy."adapterKind" IS DISTINCT FROM 'provider_model_client'
    OR strategy."credentialMode" IS DISTINCT FROM 'provider_model'
    OR strategy."draft" IS DISTINCT FROM target."canonicalDraft"
    OR strategy."testedDraftHash" IS DISTINCT FROM target."draftHash"
    OR strategy."draftTestEvidence" IS DISTINCT FROM target."publicationEvidence"
    OR strategy."activeRevisionId" IS DISTINCT FROM target."revisionId"
    OR strategy."activatedAt" IS NULL
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
     AND revision."searchStrategyId" = strategy."id"
    WHERE strategy."id" = 'anthropic-web-search'
      AND strategy."searchOptionId" = '00000000-0000-4000-8000-000000001405'
      AND strategy."kind" = 'anthropic_native_web_search'
      AND strategy."adapterKind" = 'answer_provider_hosted'
      AND revision."configuration" ->> 'protocol' = 'anthropic_web_search'
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration did not publish the hosted route';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_AnthropicSearchPublication" target
    LEFT JOIN "SearchStrategy" strategy ON strategy."id" = target."routeId"
    LEFT JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
     AND revision."searchStrategyId" = strategy."id"
    WHERE strategy."id" IS NULL
       OR strategy."searchOptionId" IS DISTINCT FROM target."searchOptionId"
       OR strategy."strategyId" IS DISTINCT FROM target."routeStrategyId"
       OR NOT strategy."enabled"
       OR strategy."archivedAt" IS NOT NULL
       OR strategy."kind" IS DISTINCT FROM 'provider_model_web_search'
       OR strategy."adapterKind" IS DISTINCT FROM 'provider_model_client'
       OR strategy."credentialMode" IS DISTINCT FROM 'provider_model'
       OR strategy."providerModelId" IS DISTINCT FROM target."providerModelId"
       OR strategy."draft" IS DISTINCT FROM target."canonicalDraft"
       OR revision."id" IS NULL
       OR revision."configuration" IS DISTINCT FROM target."canonicalDraft"
       OR revision."providerModelId" IS DISTINCT FROM target."providerModelId"
  ) THEN
    RAISE EXCEPTION 'Anthropic Search migration did not publish the eligible client route';
  END IF;
END
$migration$;

COMMIT;
