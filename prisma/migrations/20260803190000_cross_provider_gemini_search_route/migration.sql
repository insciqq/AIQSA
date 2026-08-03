-- Publish a query-only Gemini client route beneath the existing logical
-- Google Search option. This is a catalog-only upgrade: it reads active
-- provider/model declarations and never resolves credentials or calls Gemini.
-- Existing hosted execution, grants, preferences, and run archaeology remain
-- unchanged.

BEGIN;

-- Gemini used to be hosted-only, so the legacy constraint required a null
-- ProviderModel reference for every gemini_google_search row. Admit only the
-- new typed client shape while retaining the hosted and other-kind fences.
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
    "kind" IN ('none', 'openai_native_web_search')
    AND "providerModelId" IS NULL
  )
);

CREATE TEMP TABLE "_GeminiSearchEligibleModels" ON COMMIT DROP AS
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
WHERE option_row."optionId" = 'gemini-google-search'
  AND option_row."kind" = 'gemini_google_search'
  AND option_row."templateKey" = 'search:gemini-google'
  AND option_row."archivedAt" IS NULL
  AND connection."family" = 'gemini'
  AND connection."templateKey" = 'gemini'
  AND connection."enabled"
  AND connection."activeVersion" > 0
  AND connection."activeConfig" IS NOT NULL
  AND model."enabled"
  AND model."activeVersion" > 0
  AND model."activeConfig" IS NOT NULL
  AND model."activeConfig" ->> 'adapterKind' = 'gemini_interactions_native'
  AND model."activeConfig" #> '{capabilities,nativeSearch}' = 'true'::jsonb;

-- Count every client-shaped row so a partially corrupt route cannot hide from
-- the one-current-client invariant.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT "searchOptionId"
      FROM "_GeminiSearchEligibleModels"
    ) target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = target."searchOptionId"
     AND strategy."archivedAt" IS NULL
     AND (
       strategy."adapterKind" = 'provider_model_client'
       OR strategy."credentialMode" = 'provider_model'
     )
    GROUP BY target."searchOptionId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill found duplicate current client routes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT "searchOptionId"
      FROM "_GeminiSearchEligibleModels"
    ) target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = target."searchOptionId"
     AND strategy."archivedAt" IS NULL
     AND (
       strategy."adapterKind" = 'provider_model_client'
       OR strategy."credentialMode" = 'provider_model'
     )
    WHERE strategy."adapterKind" <> 'provider_model_client'
       OR strategy."credentialMode" <> 'provider_model'
       OR strategy."kind" <> 'gemini_google_search'
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill found a corrupt current client route';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT "searchOptionId", "sourceConnectionId"
      FROM "_GeminiSearchEligibleModels"
    ) target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = target."searchOptionId"
     AND strategy."archivedAt" IS NULL
     AND strategy."adapterKind" = 'provider_model_client'
     AND strategy."credentialMode" = 'provider_model'
    LEFT JOIN "ProviderModel" model
      ON model."id" = strategy."providerModelId"
    WHERE model."connectionId" IS DISTINCT FROM target."sourceConnectionId"
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill found a client route owned by another source';
  END IF;
END
$migration$;

-- Retain a still-eligible operator selection. Otherwise prefer the reviewed
-- Gemini 3.6 Flash template, then use stable ProviderModel identity ordering.
CREATE TEMP TABLE "_GeminiSearchTarget" ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    eligible.*,
    current_route."id" AS "existingRouteId",
    current_route."strategyId" AS "existingStrategyId",
    current_route."providerModelId" AS "existingProviderModelId",
    current_route."draft" AS "existingDraft",
    current_route."draftTestEvidence" AS "existingEvidence",
    row_number() OVER (
      PARTITION BY eligible."searchOptionId"
      ORDER BY
        CASE
          WHEN eligible."providerModelId" = current_route."providerModelId" THEN 0
          WHEN eligible."providerModelId" = '00000000-0000-4000-8000-000000001213' THEN 1
          ELSE 2
        END,
        eligible."providerModelId" COLLATE "C"
    ) AS "modelOrdinal"
  FROM "_GeminiSearchEligibleModels" eligible
  LEFT JOIN LATERAL (
    SELECT
      strategy."id",
      strategy."strategyId",
      strategy."providerModelId",
      strategy."draft",
      strategy."draftTestEvidence"
    FROM "SearchStrategy" strategy
    WHERE strategy."searchOptionId" = eligible."searchOptionId"
      AND strategy."archivedAt" IS NULL
      AND strategy."adapterKind" = 'provider_model_client'
      AND strategy."credentialMode" = 'provider_model'
    ORDER BY strategy."id" COLLATE "C"
    LIMIT 1
  ) current_route ON true
)
SELECT
  ranked.*,
  CASE
    WHEN jsonb_typeof(ranked."existingDraft" -> 'maxOutputTokens') = 'number'
      THEN CASE
        WHEN (ranked."existingDraft" ->> 'maxOutputTokens')::NUMERIC =
          trunc((ranked."existingDraft" ->> 'maxOutputTokens')::NUMERIC)
          AND (ranked."existingDraft" ->> 'maxOutputTokens')::NUMERIC BETWEEN 1024 AND 32768
          THEN (ranked."existingDraft" ->> 'maxOutputTokens')::INTEGER
        ELSE 4096
      END
    ELSE 4096
  END AS "maxOutputTokens",
  CASE
    WHEN jsonb_typeof(ranked."existingDraft" -> 'maxResults') = 'number'
      THEN CASE
        WHEN (ranked."existingDraft" ->> 'maxResults')::NUMERIC =
          trunc((ranked."existingDraft" ->> 'maxResults')::NUMERIC)
          AND (ranked."existingDraft" ->> 'maxResults')::NUMERIC BETWEEN 1 AND 20
          THEN (ranked."existingDraft" ->> 'maxResults')::INTEGER
        ELSE 8
      END
    ELSE 8
  END AS "maxResults",
  CASE
    WHEN jsonb_typeof(ranked."existingDraft" -> 'maxSearchCallsPerAnswer') = 'number'
      THEN CASE
        WHEN (ranked."existingDraft" ->> 'maxSearchCallsPerAnswer')::NUMERIC =
          trunc((ranked."existingDraft" ->> 'maxSearchCallsPerAnswer')::NUMERIC)
          AND (ranked."existingDraft" ->> 'maxSearchCallsPerAnswer')::NUMERIC BETWEEN 1 AND 4
          THEN (ranked."existingDraft" ->> 'maxSearchCallsPerAnswer')::INTEGER
        ELSE 2
      END
    ELSE 2
  END AS "maxSearchCallsPerAnswer",
  CASE
    WHEN jsonb_typeof(ranked."existingDraft" -> 'queryMaxCharacters') = 'number'
      THEN CASE
        WHEN (ranked."existingDraft" ->> 'queryMaxCharacters')::NUMERIC =
          trunc((ranked."existingDraft" ->> 'queryMaxCharacters')::NUMERIC)
          AND (ranked."existingDraft" ->> 'queryMaxCharacters')::NUMERIC BETWEEN 32 AND 1000
          THEN (ranked."existingDraft" ->> 'queryMaxCharacters')::INTEGER
        ELSE 500
      END
    ELSE 500
  END AS "queryMaxCharacters",
  CASE
    WHEN ranked."existingDraft" ->> 'reasoningPolicy' IN (
      'lowest_supported', 'provider_default'
    ) THEN ranked."existingDraft" ->> 'reasoningPolicy'
    ELSE 'lowest_supported'
  END AS "reasoningPolicy",
  CASE
    WHEN jsonb_typeof(ranked."existingDraft" -> 'timeoutMs') = 'number'
      THEN CASE
        WHEN (ranked."existingDraft" ->> 'timeoutMs')::NUMERIC =
          trunc((ranked."existingDraft" ->> 'timeoutMs')::NUMERIC)
          AND (ranked."existingDraft" ->> 'timeoutMs')::NUMERIC BETWEEN 5000 AND 900000
          THEN (ranked."existingDraft" ->> 'timeoutMs')::INTEGER
        ELSE 300000
      END
    ELSE 300000
  END AS "timeoutMs"
FROM ranked
WHERE ranked."modelOrdinal" = 1;

-- Prefer the Quick Setup identity, with the connection-scoped Advanced
-- identity as the collision-safe fallback.
CREATE TEMP TABLE "_GeminiSearchRoute" ON COMMIT DROP AS
SELECT
  target.*,
  COALESCE(target."existingRouteId", identity."id") AS "routeId",
  COALESCE(target."existingStrategyId", identity."strategyId") AS "routeStrategyId"
FROM "_GeminiSearchTarget" target
LEFT JOIN LATERAL (
  SELECT candidate."id", candidate."strategyId"
  FROM (
    VALUES
      (
        'system-gemini-google-search-client',
        'gemini-google-search-client',
        1
      ),
      (
        'gemini-search-client:' || target."sourceConnectionId",
        'gemini-search-client:' || target."sourceConnectionId",
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
    SELECT 1
    FROM "_GeminiSearchRoute"
    WHERE "routeId" IS NULL OR "routeStrategyId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill could not allocate a client route identity';
  END IF;
END
$migration$;

-- Match the application's sorted-key canonical JSON digest exactly.
CREATE TEMP TABLE "_GeminiSearchCanonical" ON COMMIT DROP AS
SELECT
  route.*,
  jsonb_build_object(
    'adapterKind', 'provider_model_client',
    'credentialMode', 'provider_model',
    'maxOutputTokens', route."maxOutputTokens",
    'maxResults', route."maxResults",
    'maxSearchCallsPerAnswer', route."maxSearchCallsPerAnswer",
    'protocol', 'gemini_google_search',
    'providerModelId', route."providerModelId",
    'queryMaxCharacters', route."queryMaxCharacters",
    'reasoningPolicy', route."reasoningPolicy",
    'timeoutMs', route."timeoutMs"
  ) AS "canonicalDraft",
  encode(sha256(convert_to(
    '{"adapterKind":"provider_model_client","credentialMode":"provider_model"' ||
    ',"maxOutputTokens":' || route."maxOutputTokens"::TEXT ||
    ',"maxResults":' || route."maxResults"::TEXT ||
    ',"maxSearchCallsPerAnswer":' || route."maxSearchCallsPerAnswer"::TEXT ||
    ',"protocol":"gemini_google_search","providerModelId":' ||
    to_json(route."providerModelId")::TEXT ||
    ',"queryMaxCharacters":' || route."queryMaxCharacters"::TEXT ||
    ',"reasoningPolicy":' || to_json(route."reasoningPolicy")::TEXT ||
    ',"timeoutMs":' || route."timeoutMs"::TEXT || '}',
    'UTF8'
  )), 'hex') AS "draftHash",
  jsonb_build_object(
    'checkedAt', CASE
      WHEN route."existingEvidence" ->> 'method' = 'configuration'
        AND route."existingEvidence" ->> 'status' = 'available'
        AND route."existingEvidence" ->> 'protocol' = 'gemini_google_search'
        AND route."existingEvidence" ->> 'normalizedSourceCount' = '0'
        AND jsonb_typeof(route."existingEvidence" -> 'checkedAt') = 'string'
        THEN route."existingEvidence" ->> 'checkedAt'
      ELSE to_char(
        CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    END,
    'method', 'configuration',
    'normalizedSourceCount', 0,
    'protocol', 'gemini_google_search',
    'status', 'available'
  ) AS "configurationEvidence",
  encode(sha256(convert_to('["configuration"]', 'UTF8')), 'hex')
    AS "validationFingerprint"
FROM "_GeminiSearchRoute" route;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_GeminiSearchCanonical" target
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."searchStrategyId" = target."routeId"
     AND revision."draftHash" = target."draftHash"
     AND revision."validationFingerprint" = target."validationFingerprint"
    WHERE revision."adapterKind" IS DISTINCT FROM 'provider_model_client'
       OR revision."credentialMode" IS DISTINCT FROM 'provider_model'
       OR revision."configuration" IS DISTINCT FROM target."canonicalDraft"
       OR revision."providerModelId" IS DISTINCT FROM target."providerModelId"
       OR revision."validationEvidence" IS DISTINCT FROM target."configurationEvidence"
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill found a corrupt configuration revision';
  END IF;
END
$migration$;

CREATE TEMP TABLE "_GeminiSearchPublication" ON COMMIT DROP AS
WITH publication_base AS (
  SELECT
    target.*,
    matching."id" AS "existingRevisionId",
    matching."revisionNumber" AS "existingRevisionNumber",
    matching."validationEvidence" AS "existingRevisionEvidence",
    COALESCE(latest."nextRevisionNumber", 1) AS "nextRevisionNumber"
  FROM "_GeminiSearchCanonical" target
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
        'gemini-search-revision:' || md5(
          publication_base."routeId" || ':' || publication_base."draftHash"
        ),
        2
      )
  ) candidate("id", priority)
  WHERE publication_base."existingRevisionId" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "SearchIntegrationRevision" occupied
      WHERE occupied."id" = candidate."id"
    )
  ORDER BY candidate.priority
  LIMIT 1
) revision_identity ON true;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_GeminiSearchPublication"
    WHERE "revisionId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill could not allocate a configuration revision identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_GeminiSearchPublication" target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."id" = target."routeId"
    WHERE strategy."draft" IS DISTINCT FROM target."canonicalDraft"
      AND strategy."draftVersion" = 2147483647
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill cannot advance a corrupt draft version';
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
  target."provider",
  target."modelId",
  target."providerModelId",
  target."displayName",
  'gemini_google_search',
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
FROM "_GeminiSearchPublication" target
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
FROM "_GeminiSearchPublication" target
WHERE target."existingRevisionId" IS NULL;

UPDATE "SearchStrategy" strategy
SET
  "provider" = target."provider",
  "modelId" = target."modelId",
  "providerModelId" = target."providerModelId",
  "displayName" = target."displayName",
  "kind" = 'gemini_google_search',
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
FROM "_GeminiSearchPublication" target
WHERE strategy."id" = target."routeId"
  AND (
    strategy."provider" IS DISTINCT FROM target."provider"
    OR strategy."modelId" IS DISTINCT FROM target."modelId"
    OR strategy."providerModelId" IS DISTINCT FROM target."providerModelId"
    OR strategy."displayName" IS DISTINCT FROM target."displayName"
    OR strategy."kind" IS DISTINCT FROM 'gemini_google_search'
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
  IF EXISTS (
    SELECT 1
    FROM "_GeminiSearchPublication" target
    LEFT JOIN "SearchStrategy" strategy
      ON strategy."id" = target."routeId"
    LEFT JOIN "SearchIntegrationRevision" revision
      ON revision."id" = strategy."activeRevisionId"
     AND revision."searchStrategyId" = strategy."id"
    WHERE strategy."id" IS NULL
       OR strategy."searchOptionId" IS DISTINCT FROM target."searchOptionId"
       OR strategy."strategyId" IS DISTINCT FROM target."routeStrategyId"
       OR NOT strategy."enabled"
       OR strategy."archivedAt" IS NOT NULL
       OR strategy."adapterKind" IS DISTINCT FROM 'provider_model_client'
       OR strategy."credentialMode" IS DISTINCT FROM 'provider_model'
       OR strategy."kind" IS DISTINCT FROM 'gemini_google_search'
       OR strategy."providerModelId" IS DISTINCT FROM target."providerModelId"
       OR strategy."draft" IS DISTINCT FROM target."canonicalDraft"
       OR revision."id" IS NULL
       OR revision."configuration" IS DISTINCT FROM target."canonicalDraft"
       OR revision."providerModelId" IS DISTINCT FROM target."providerModelId"
  ) THEN
    RAISE EXCEPTION 'Gemini Search route backfill did not publish the eligible client route';
  END IF;
END
$migration$;

COMMIT;
