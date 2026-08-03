-- Make the hidden query-only route of each unarchived OpenAI Search source usable
-- from another compatible answer provider. This is a catalog-only repair: it
-- reads declared active provider/model configuration and never resolves a
-- credential, decrypts a value, or calls a provider.
--
-- Existing logical options, physical-route identities, immutable revisions,
-- grants, preferences, and accepted run bindings remain archaeology. When an
-- eligible current client route exists, only its mutable/current pointer is
-- repaired; otherwise a collision-checked child route is added.

BEGIN;

CREATE TEMP TABLE "_ProviderNeutralSearchEligibleModels" ON COMMIT DROP AS
SELECT
  option_row."id" AS "searchOptionId",
  option_row."templateKey" AS "searchOptionTemplateKey",
  option_row."displayName",
  option_row."description",
  option_row."sourceConnectionId",
  model."id" AS "providerModelId",
  model."provider",
  model."modelId"
FROM "SearchOption" option_row
INNER JOIN "ProviderConnection" connection
  ON connection."id" = option_row."sourceConnectionId"
INNER JOIN "ProviderModel" model
  ON model."connectionId" = connection."id"
WHERE option_row."kind" = 'web_search'
  AND option_row."archivedAt" IS NULL
  AND connection."enabled"
  AND connection."activeVersion" > 0
  AND connection."activeConfig" IS NOT NULL
  AND model."enabled"
  AND model."activeVersion" > 0
  AND model."activeConfig" IS NOT NULL
  AND model."activeConfig" #> '{capabilities,nativeSearch}' = 'true'::jsonb
  AND (
    (
      connection."family" = 'openai'
      AND model."activeConfig" ->> 'adapterKind' = 'openai_responses_native'
    ) OR (
      connection."family" = 'openai_compatible'
      AND model."activeConfig" ->> 'adapterKind' = 'openai_responses_compatible'
    )
  );

-- A logical web-search source may own at most one current query-only child.
-- Count every client-shaped row, not only rows whose adapter label happens to
-- be correct, so a partially corrupted row cannot be hidden by the repair.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT "searchOptionId"
      FROM "_ProviderNeutralSearchEligibleModels"
    ) target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = target."searchOptionId"
     AND strategy."archivedAt" IS NULL
     AND (
       strategy."adapterKind" = 'provider_model_client'
       OR strategy."credentialMode" = 'provider_model'
       OR strategy."kind" = 'provider_model_web_search'
     )
    GROUP BY target."searchOptionId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill found duplicate current client routes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT "searchOptionId"
      FROM "_ProviderNeutralSearchEligibleModels"
    ) target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = target."searchOptionId"
     AND strategy."archivedAt" IS NULL
     AND (
       strategy."adapterKind" = 'provider_model_client'
       OR strategy."credentialMode" = 'provider_model'
       OR strategy."kind" = 'provider_model_web_search'
     )
    WHERE strategy."adapterKind" <> 'provider_model_client'
       OR strategy."credentialMode" <> 'provider_model'
       OR strategy."kind" <> 'provider_model_web_search'
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill found a corrupt current client route';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT "searchOptionId", "sourceConnectionId"
      FROM "_ProviderNeutralSearchEligibleModels"
    ) target
    INNER JOIN "SearchStrategy" strategy
      ON strategy."searchOptionId" = target."searchOptionId"
     AND strategy."archivedAt" IS NULL
     AND strategy."adapterKind" = 'provider_model_client'
     AND strategy."credentialMode" = 'provider_model'
     AND strategy."kind" = 'provider_model_web_search'
    INNER JOIN "ProviderModel" model ON model."id" = strategy."providerModelId"
    WHERE model."connectionId" <> target."sourceConnectionId"
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill found a client route owned by another source';
  END IF;
END
$migration$;

-- Prefer the model already selected by a valid same-source client route. If
-- that model is no longer eligible, use the lowest stable ProviderModel id.
CREATE TEMP TABLE "_ProviderNeutralSearchTargets" ON COMMIT DROP AS
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
          ELSE 1
        END,
        eligible."providerModelId" COLLATE "C"
    ) AS "modelOrdinal"
  FROM "_ProviderNeutralSearchEligibleModels" eligible
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
      AND strategy."kind" = 'provider_model_web_search'
    ORDER BY strategy."id" COLLATE "C"
    LIMIT 1
  ) current_route ON true
)
SELECT
  ranked.*,
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

-- Retain an existing route identity. For a missing route, prefer the current
-- official/custom conventions, then a connection-scoped official fallback,
-- and finally an option-row-scoped collision fallback.
CREATE TEMP TABLE "_ProviderNeutralSearchRoutes" ON COMMIT DROP AS
SELECT
  target.*,
  COALESCE(target."existingRouteId", identity."id") AS "routeId",
  COALESCE(target."existingStrategyId", identity."strategyId") AS "routeStrategyId"
FROM "_ProviderNeutralSearchTargets" target
LEFT JOIN LATERAL (
  SELECT candidate."id", candidate."strategyId"
  FROM (
    SELECT
      CASE
        WHEN target."searchOptionTemplateKey" = 'search:openai'
          THEN 'system-openai-provider-web-search'
        ELSE 'custom-web-search-client:' || target."sourceConnectionId"
      END AS "id",
      CASE
        WHEN target."searchOptionTemplateKey" = 'search:openai'
          THEN 'openai-provider-web-search'
        ELSE 'custom-web-search-client:' || target."sourceConnectionId"
      END AS "strategyId",
      1 AS priority
    UNION ALL
    SELECT
      'openai-search-client:' || target."sourceConnectionId",
      'openai-search-client:' || target."sourceConnectionId",
      2
    WHERE target."searchOptionTemplateKey" = 'search:openai'
    UNION ALL
    SELECT
      'provider-neutral-search-client:' || target."searchOptionId",
      'provider-neutral-search-client:' || target."searchOptionId",
      3
  ) candidate
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
    FROM "_ProviderNeutralSearchRoutes"
    WHERE "routeId" IS NULL OR "routeStrategyId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill could not allocate a client route identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_ProviderNeutralSearchRoutes" left_target
    INNER JOIN "_ProviderNeutralSearchRoutes" right_target
      ON left_target."searchOptionId" < right_target."searchOptionId"
     AND (
       left_target."routeId" IN (right_target."routeId", right_target."routeStrategyId")
       OR left_target."routeStrategyId" IN (right_target."routeId", right_target."routeStrategyId")
     )
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill allocated duplicate client route identities';
  END IF;
END
$migration$;

-- PostgreSQL's built-in sha256(bytea) computes the same canonical draft hash
-- as the application. Build the JSON text explicitly so whitespace or jsonb
-- display ordering cannot affect the digest.
CREATE TEMP TABLE "_ProviderNeutralSearchCanonical" ON COMMIT DROP AS
SELECT
  route.*,
  jsonb_build_object(
    'adapterKind', 'provider_model_client',
    'credentialMode', 'provider_model',
    'maxResults', route."maxResults",
    'protocol', 'openai_responses_web_search',
    'providerModelId', route."providerModelId",
    'queryMaxCharacters', route."queryMaxCharacters",
    'timeoutMs', route."timeoutMs"
  ) AS "canonicalDraft",
  encode(sha256(convert_to(
    '{"adapterKind":"provider_model_client","credentialMode":"provider_model","maxResults":' ||
    route."maxResults"::TEXT ||
    ',"protocol":"openai_responses_web_search","providerModelId":' ||
    to_json(route."providerModelId")::TEXT ||
    ',"queryMaxCharacters":' || route."queryMaxCharacters"::TEXT ||
    ',"timeoutMs":' || route."timeoutMs"::TEXT || '}',
    'UTF8'
  )), 'hex') AS "draftHash",
  jsonb_build_object(
    'checkedAt', CASE
      WHEN route."existingEvidence" ->> 'method' = 'configuration'
        AND route."existingEvidence" ->> 'status' = 'available'
        AND route."existingEvidence" ->> 'protocol' = 'openai_responses_web_search'
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
    'protocol', 'openai_responses_web_search',
    'status', 'available'
  ) AS "configurationEvidence",
  encode(sha256(convert_to('["configuration"]', 'UTF8')), 'hex')
    AS "validationFingerprint"
FROM "_ProviderNeutralSearchRoutes" route;

-- A matching configuration revision is reusable only when its complete
-- immutable payload is the canonical payload. A conflicting row at the same
-- unique identity is corruption, not a reason to rewrite history.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_ProviderNeutralSearchCanonical" target
    INNER JOIN "SearchIntegrationRevision" revision
      ON revision."searchStrategyId" = target."routeId"
     AND revision."draftHash" = target."draftHash"
     AND revision."validationFingerprint" = target."validationFingerprint"
    WHERE revision."adapterKind" IS DISTINCT FROM 'provider_model_client'
       OR revision."credentialMode" IS DISTINCT FROM 'provider_model'
       OR revision."configuration" IS DISTINCT FROM target."canonicalDraft"
       OR revision."providerModelId" IS DISTINCT FROM target."providerModelId"
       OR revision."validationEvidence" ->> 'method' IS DISTINCT FROM 'configuration'
       OR revision."validationEvidence" ->> 'status' IS DISTINCT FROM 'available'
       OR revision."validationEvidence" ->> 'protocol'
          IS DISTINCT FROM 'openai_responses_web_search'
       OR revision."validationEvidence" ->> 'normalizedSourceCount' IS DISTINCT FROM '0'
       OR jsonb_typeof(revision."validationEvidence" -> 'checkedAt')
          IS DISTINCT FROM 'string'
       OR revision."validationEvidence" ? 'probeBinding'
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill found a corrupt configuration revision';
  END IF;
END
$migration$;

CREATE TEMP TABLE "_ProviderNeutralSearchPublication" ON COMMIT DROP AS
WITH publication_base AS (
  SELECT
    target.*,
    matching."id" AS "existingRevisionId",
    matching."revisionNumber" AS "existingRevisionNumber",
    matching."validationEvidence" AS "existingRevisionEvidence",
    COALESCE(latest."nextRevisionNumber", 1) AS "nextRevisionNumber"
  FROM "_ProviderNeutralSearchCanonical" target
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
  COALESCE(
    publication_base."existingRevisionId",
    revision_identity."id"
  ) AS "revisionId",
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
        'provider-neutral-search-revision:' || md5(
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
    FROM "_ProviderNeutralSearchPublication"
    WHERE "revisionId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill could not allocate a configuration revision identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_ProviderNeutralSearchPublication" left_target
    INNER JOIN "_ProviderNeutralSearchPublication" right_target
      ON left_target."searchOptionId" < right_target."searchOptionId"
     AND left_target."revisionId" = right_target."revisionId"
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill allocated duplicate revision identities';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_ProviderNeutralSearchPublication" target
    INNER JOIN "SearchStrategy" strategy ON strategy."id" = target."routeId"
    WHERE strategy."draft" IS DISTINCT FROM target."canonicalDraft"
      AND strategy."draftVersion" = 2147483647
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill cannot advance a corrupt draft version';
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
FROM "_ProviderNeutralSearchPublication" target
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
FROM "_ProviderNeutralSearchPublication" target
WHERE target."existingRevisionId" IS NULL;

UPDATE "SearchStrategy" strategy
SET
  "provider" = target."provider",
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
FROM "_ProviderNeutralSearchPublication" target
WHERE strategy."id" = target."routeId"
  AND (
    strategy."provider" IS DISTINCT FROM target."provider"
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
  IF EXISTS (
    SELECT 1
    FROM "_ProviderNeutralSearchPublication" target
    LEFT JOIN "SearchStrategy" strategy ON strategy."id" = target."routeId"
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
       OR strategy."kind" IS DISTINCT FROM 'provider_model_web_search'
       OR strategy."providerModelId" IS DISTINCT FROM target."providerModelId"
       OR strategy."draft" IS DISTINCT FROM target."canonicalDraft"
       OR revision."id" IS NULL
       OR revision."configuration" IS DISTINCT FROM target."canonicalDraft"
       OR revision."providerModelId" IS DISTINCT FROM target."providerModelId"
  ) THEN
    RAISE EXCEPTION 'Provider-neutral Search backfill did not publish every eligible client route';
  END IF;
END
$migration$;

COMMIT;
