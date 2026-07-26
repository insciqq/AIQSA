-- Cut first-class Gemini over to the stable native Interactions API. This is a
-- protocol-schema conversion, not an administrator draft edit: credentials,
-- grants, defaults, version identities, checks, and terminal run snapshots stay
-- unchanged. Old active compatible runs cannot be replayed through the removed
-- transport and are settled with a safe retry-required error.

BEGIN;

-- A credential version may be active without encrypted secret material only
-- when the immutable test evidence explicitly records no authentication. The
-- COALESCE is deliberate: PostgreSQL CHECK constraints accept NULL, so missing
-- or malformed legacy evidence must fail closed for a new active NULL secret.
ALTER TABLE "ProviderCredentialVersion"
DROP CONSTRAINT "ProviderCredentialVersion_secret_check",
ADD CONSTRAINT "ProviderCredentialVersion_secret_check" CHECK (
  "secretEnvelope" IS NOT NULL
  OR "revokedAt" IS NOT NULL
  OR COALESCE(
    ("testEvidence" ->> 'authenticationMode') = 'none',
    false
  )
);

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProviderConnection" connection
    WHERE connection."family" = 'gemini'
      AND (
        jsonb_typeof(connection."draftConfig") <> 'object'
        OR jsonb_typeof(connection."draftConfig" -> 'apiRoot') IS DISTINCT FROM 'string'
        OR regexp_replace(connection."draftConfig" ->> 'apiRoot', '/+$', '') NOT IN (
          'https://generativelanguage.googleapis.com/v1beta/openai',
          'https://generativelanguage.googleapis.com/v1'
        )
        OR (
          connection."activeConfig" IS NOT NULL
          AND (
            jsonb_typeof(connection."activeConfig") <> 'object'
            OR jsonb_typeof(connection."activeConfig" -> 'apiRoot') IS DISTINCT FROM 'string'
            OR regexp_replace(connection."activeConfig" ->> 'apiRoot', '/+$', '') NOT IN (
              'https://generativelanguage.googleapis.com/v1beta/openai',
              'https://generativelanguage.googleapis.com/v1'
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Native Gemini cutover found an unsupported Gemini connection configuration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ProviderModel" model
    INNER JOIN "ProviderConnection" connection ON connection."id" = model."connectionId"
    WHERE connection."family" = 'gemini'
      AND (
        jsonb_typeof(model."draftConfig") <> 'object'
        OR model."draftConfig" ->> 'adapterKind' IS NULL
        OR model."draftConfig" ->> 'adapterKind' NOT IN (
          'openai_chat_completions_compatible',
          'gemini_interactions_native'
        )
        OR jsonb_typeof(model."draftConfig" -> 'capabilities') IS DISTINCT FROM 'object'
        OR jsonb_typeof(model."capabilities") IS DISTINCT FROM 'object'
        OR (
          model."activeConfig" IS NOT NULL
          AND (
            jsonb_typeof(model."activeConfig") <> 'object'
            OR model."activeConfig" ->> 'adapterKind' IS NULL
            OR model."activeConfig" ->> 'adapterKind' NOT IN (
              'openai_chat_completions_compatible',
              'gemini_interactions_native'
            )
            OR jsonb_typeof(model."activeConfig" -> 'capabilities') IS DISTINCT FROM 'object'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Native Gemini cutover found an unsupported Gemini model configuration';
  END IF;
END
$migration$;

ALTER TABLE "Message"
ADD COLUMN "groundedAt" TIMESTAMP(3),
ADD COLUMN "groundingProvider" TEXT,
ADD COLUMN "groundingStrategy" TEXT,
ADD CONSTRAINT "Message_grounding_provenance_check" CHECK (
  (
    "groundedAt" IS NULL
    AND "groundingProvider" IS NULL
    AND "groundingStrategy" IS NULL
  )
  OR (
    "role" = 'assistant'
    AND "groundedAt" IS NOT NULL
    AND "groundingProvider" = 'gemini'
    AND "groundingStrategy" = 'gemini-google-search'
  )
);

CREATE INDEX "Message_groundingProvider_groundedAt_idx"
ON "Message"("groundingProvider", "groundedAt");

ALTER TABLE "SearchStrategy"
DROP CONSTRAINT "SearchStrategy_provider_model_check",
ADD CONSTRAINT "SearchStrategy_provider_model_check" CHECK (
  (
    "kind" = 'perplexity_tool_search'
    AND "providerModelId" IS NOT NULL
  )
  OR (
    "kind" IN ('none', 'openai_native_web_search', 'gemini_google_search')
    AND "providerModelId" IS NULL
  )
);

UPDATE "ProviderConnection"
SET
  "draftConfig" = jsonb_set(
    "draftConfig",
    '{apiRoot}',
    to_jsonb('https://generativelanguage.googleapis.com/v1'::text),
    true
  ),
  "activeConfig" = CASE
    WHEN "activeConfig" IS NULL THEN NULL
    ELSE jsonb_set(
      "activeConfig",
      '{apiRoot}',
      to_jsonb('https://generativelanguage.googleapis.com/v1'::text),
      true
    )
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "family" = 'gemini';

UPDATE "ProviderModel" model
SET
  "draftConfig" = jsonb_set(
    jsonb_set(
      model."draftConfig",
      '{adapterKind}',
      to_jsonb('gemini_interactions_native'::text),
      true
    ),
    '{capabilities,nativeSearch}',
    'true'::jsonb,
    true
  ),
  "activeConfig" = CASE
    WHEN model."activeConfig" IS NULL THEN NULL
    ELSE jsonb_set(
      jsonb_set(
        model."activeConfig",
        '{adapterKind}',
        to_jsonb('gemini_interactions_native'::text),
        true
      ),
      '{capabilities,nativeSearch}',
      'true'::jsonb,
      true
    )
  END,
  "capabilities" = CASE
    WHEN jsonb_typeof(model."capabilities") = 'object'
      THEN model."capabilities" || jsonb_build_object('nativeSearch', true)
    ELSE model."capabilities"
  END,
  "supportsNativeSearch" = true,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "ProviderConnection" connection
WHERE connection."id" = model."connectionId"
  AND connection."family" = 'gemini';

INSERT INTO "SearchStrategy" (
  "id",
  "strategyId",
  "provider",
  "modelId",
  "providerModelId",
  "displayName",
  "kind",
  "description",
  "enabled",
  "config",
  "createdAt",
  "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000001301',
  'gemini-google-search',
  'gemini',
  NULL,
  NULL,
  'Google Search',
  'gemini_google_search',
  'Native Google Search grounding for eligible Gemini models.',
  true,
  '{"tool":"google_search","liveOnly":true}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("strategyId") DO UPDATE SET
  "provider" = EXCLUDED."provider",
  "modelId" = EXCLUDED."modelId",
  "providerModelId" = EXCLUDED."providerModelId",
  "displayName" = EXCLUDED."displayName",
  "kind" = EXCLUDED."kind",
  "description" = EXCLUDED."description",
  "enabled" = EXCLUDED."enabled",
  "config" = EXCLUDED."config",
  "updatedAt" = CURRENT_TIMESTAMP;

WITH incompatible_active_runs AS (
  SELECT DISTINCT run."id", run."assistantMessageId"
  FROM "ModelRun" run
  INNER JOIN "ProviderRunBinding" binding
    ON binding."modelRunId" = run."id"
    AND binding."role" = 'answer'
  WHERE run."status" IN ('queued', 'streaming', 'in_progress')
    AND binding."executionSnapshot" #>> '{providerFamily}' = 'gemini'
    AND binding."executionSnapshot" #>> '{model,adapterKind}' =
      'openai_chat_completions_compatible'
),
settled_runs AS (
  UPDATE "ModelRun" run
  SET
    "status" = 'error',
    "errorPayload" = jsonb_build_object(
      'code', 'gemini_native_cutover_retry_required',
      'message', 'This Gemini run cannot be resumed after the native transport upgrade. Retry it.',
      'recoveryTerminal', true
    ),
    "toolLoopState" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM incompatible_active_runs incompatible
  WHERE run."id" = incompatible."id"
  RETURNING run."id", run."assistantMessageId"
),
settled_messages AS (
  UPDATE "Message" message
  SET
    "status" = 'error',
    "errorMessage" = 'This Gemini run cannot be resumed after the native transport upgrade. Retry it.',
    "updatedAt" = CURRENT_TIMESTAMP
  FROM settled_runs run
  WHERE message."id" = run."assistantMessageId"
    AND message."status" IN ('queued', 'streaming')
  RETURNING message."id"
)
UPDATE "ModelRunToolCall" call
SET
  "state" = 'cancelled',
  "completedAt" = COALESCE(call."completedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM settled_runs run
WHERE call."modelRunId" = run."id"
  AND call."state" IN ('pending', 'running');

COMMIT;
