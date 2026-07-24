-- Establish the ADR 0022 provider-control-plane identity and lineage foundation.
-- This stopped-release migration consumes and drops mutable legacy identity columns.

DO $$
DECLARE
  invalid_values TEXT;
BEGIN
  SELECT string_agg(DISTINCT "provider", ', ' ORDER BY "provider")
  INTO invalid_values
  FROM "ProviderModel"
  WHERE "provider" NOT IN ('fake', 'openai', 'anthropic', 'openrouter');

  IF invalid_values IS NOT NULL THEN
    RAISE EXCEPTION 'Provider control-plane migration found unsupported model providers: %', invalid_values;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UserSettings"
    WHERE jsonb_typeof("defaultControlValues") <> 'object'
  ) THEN
    RAISE EXCEPTION 'Provider control-plane migration found non-object user default controls';
  END IF;

  SELECT string_agg(DISTINCT "provider", ', ' ORDER BY "provider")
  INTO invalid_values
  FROM "AccessGrant" grant_row
  WHERE grant_row."provider" IS NOT NULL
    AND (
      grant_row."provider" NOT IN ('fake', 'openai', 'anthropic', 'openrouter')
      OR NOT EXISTS (
        SELECT 1
        FROM "ProviderModel" model_row
        WHERE model_row."provider" = grant_row."provider"
          AND (
            grant_row."modelId" IS NULL
            OR model_row."modelId" = grant_row."modelId"
          )
      )
    );

  IF invalid_values IS NOT NULL THEN
    RAISE EXCEPTION 'Provider control-plane migration found unresolved access-grant providers/models: %', invalid_values;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UserSettings" settings
    WHERE NOT EXISTS (
      SELECT 1
      FROM "ProviderModel" model_row
      WHERE model_row."provider" = settings."defaultProvider"
        AND model_row."modelId" = settings."defaultModelId"
    )
  ) THEN
    RAISE EXCEPTION 'Provider control-plane migration found unresolved UserSettings provider/model defaults';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Chat" chat
    WHERE NOT EXISTS (
      SELECT 1
      FROM "ProviderModel" model_row
      WHERE model_row."provider" = chat."defaultProvider"
        AND model_row."modelId" = chat."defaultModelId"
    )
  ) THEN
    RAISE EXCEPTION 'Provider control-plane migration found unresolved Chat provider/model defaults';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy"
    WHERE "kind" NOT IN ('none', 'openai_native_web_search', 'perplexity_tool_search')
  ) THEN
    RAISE EXCEPTION 'Provider control-plane migration found an unsupported search-strategy kind';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SearchStrategy" strategy
    WHERE strategy."kind" = 'perplexity_tool_search'
      AND (
        strategy."modelId" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "ProviderModel" model_row
          WHERE model_row."provider" = strategy."provider"
            AND model_row."modelId" = strategy."modelId"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Provider control-plane migration found an unresolved provider-backed search model';
  END IF;
END $$;

CREATE TYPE "ProviderUnassignedPolicy" AS ENUM ('use_default', 'require_assignment');
CREATE TYPE "ProviderCredentialCheckStatus" AS ENUM ('available', 'unavailable');
CREATE TYPE "ProviderRunRole" AS ENUM ('answer', 'search');
CREATE TYPE "ProviderCredentialSource" AS ENUM ('default', 'group');

CREATE TABLE "ProviderConnection" (
  "id" TEXT NOT NULL,
  "templateKey" TEXT,
  "displayName" TEXT NOT NULL,
  "family" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "unassignedPolicy" "ProviderUnassignedPolicy" NOT NULL DEFAULT 'use_default',
  "defaultCredentialId" TEXT,
  "draftConfig" JSONB NOT NULL DEFAULT '{}',
  "draftVersion" INTEGER NOT NULL DEFAULT 1,
  "activeConfig" JSONB,
  "activeVersion" INTEGER NOT NULL DEFAULT 0,
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderConnection_name_family_check"
    CHECK (btrim("displayName") <> '' AND btrim("family") <> ''),
  CONSTRAINT "ProviderConnection_versions_check"
    CHECK ("draftVersion" >= 1 AND "activeVersion" >= 0),
  CONSTRAINT "ProviderConnection_active_config_check"
    CHECK (
      ("activeVersion" = 0 AND "activeConfig" IS NULL AND "activatedAt" IS NULL)
      OR ("activeVersion" > 0 AND "activeConfig" IS NOT NULL AND "activatedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ProviderConnection_templateKey_key"
ON "ProviderConnection"("templateKey");
CREATE INDEX "ProviderConnection_enabled_idx"
ON "ProviderConnection"("enabled");

WITH templates("id", "templateKey", "displayName", "family", "draftConfig") AS (
  VALUES
    (
      '00000000-0000-4000-8000-000000001101',
      'fake',
      'Fake QSA',
      'fake',
      '{"apiRoot":"http://127.0.0.1","allowPrivateNetwork":true}'::jsonb
    ),
    (
      '00000000-0000-4000-8000-000000001102',
      'openai',
      'OpenAI',
      'openai',
      '{"apiRoot":"https://api.openai.com/v1","allowPrivateNetwork":false}'::jsonb
    ),
    (
      '00000000-0000-4000-8000-000000001103',
      'anthropic',
      'Anthropic',
      'anthropic',
      '{"apiRoot":"https://api.anthropic.com/v1","allowPrivateNetwork":false}'::jsonb
    ),
    (
      '00000000-0000-4000-8000-000000001104',
      'openrouter',
      'OpenRouter',
      'openrouter',
      '{"apiRoot":"https://openrouter.ai/api/v1","allowPrivateNetwork":false}'::jsonb
    )
)
INSERT INTO "ProviderConnection" (
  "id", "templateKey", "displayName", "family", "enabled", "draftConfig",
  "draftVersion", "activeConfig", "activeVersion", "activatedAt", "updatedAt"
)
SELECT
  template."id",
  template."templateKey",
  template."displayName",
  template."family",
  template."family" = 'fake',
  template."draftConfig",
  1,
  CASE WHEN template."family" = 'fake' THEN template."draftConfig" ELSE NULL END,
  CASE WHEN template."family" = 'fake' THEN 1 ELSE 0 END,
  CASE WHEN template."family" = 'fake' THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP
FROM templates template;

ALTER TABLE "ProviderModel"
ADD COLUMN "connectionId" TEXT,
ADD COLUMN "templateKey" TEXT,
ADD COLUMN "draftConfig" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "draftVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "activeConfig" JSONB,
ADD COLUMN "activeVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "activatedAt" TIMESTAMP(3);

UPDATE "ProviderModel" model_row
SET
  "connectionId" = connection."id",
  "templateKey" = model_row."provider" || ':' || model_row."modelId",
  "enabled" = model_row."provider" = 'fake',
  "draftConfig" = jsonb_build_object(
      'adapterKind', CASE model_row."provider"
        WHEN 'fake' THEN 'fake'
        WHEN 'openai' THEN 'openai_responses_native'
        WHEN 'anthropic' THEN 'anthropic_messages'
        WHEN 'openrouter' THEN 'openrouter_chat_completions'
      END,
      'upstreamModelId', model_row."modelId",
      'capabilities', model_row."capabilities",
      'defaultParams', model_row."defaultParams"
    ) || CASE
      WHEN model_row."provider" = 'openrouter' THEN jsonb_build_object(
        'openRouterRouting', jsonb_build_object(
          'mode', 'automatic',
          'providers', '[]'::jsonb
        )
      )
      ELSE '{}'::jsonb
    END
FROM "ProviderConnection" connection
WHERE connection."templateKey" = model_row."provider";

UPDATE "ProviderModel"
SET
  "activeConfig" = "draftConfig",
  "activeVersion" = 1,
  "activatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'fake';

ALTER TABLE "ProviderModel"
ALTER COLUMN "connectionId" SET NOT NULL;

DROP INDEX "ProviderModel_provider_modelId_key";
CREATE UNIQUE INDEX "ProviderModel_templateKey_key"
ON "ProviderModel"("templateKey");
CREATE UNIQUE INDEX "ProviderModel_connectionId_id_key"
ON "ProviderModel"("connectionId", "id");
CREATE INDEX "ProviderModel_provider_modelId_idx"
ON "ProviderModel"("provider", "modelId");
CREATE INDEX "ProviderModel_connectionId_enabled_idx"
ON "ProviderModel"("connectionId", "enabled");

ALTER TABLE "ProviderModel"
ADD CONSTRAINT "ProviderModel_versions_check"
CHECK ("draftVersion" >= 1 AND "activeVersion" >= 0),
ADD CONSTRAINT "ProviderModel_active_config_check"
CHECK (
  ("activeVersion" = 0 AND "activeConfig" IS NULL AND "activatedAt" IS NULL)
  OR ("activeVersion" > 0 AND "activeConfig" IS NOT NULL AND "activatedAt" IS NOT NULL)
),
ADD CONSTRAINT "ProviderModel_connectionId_fkey"
FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccessGrant"
ADD COLUMN "providerConnectionId" TEXT,
ADD COLUMN "providerModelId" TEXT;

UPDATE "AccessGrant" grant_row
SET "providerModelId" = model_row."id"
FROM "ProviderModel" model_row
WHERE grant_row."provider" = model_row."provider"
  AND grant_row."modelId" = model_row."modelId";

UPDATE "AccessGrant" grant_row
SET "providerConnectionId" = connection."id"
FROM "ProviderConnection" connection
WHERE grant_row."provider" = connection."family"
  AND grant_row."modelId" IS NULL;

ALTER TABLE "AccessGrant"
DROP CONSTRAINT "AccessGrant_target_check",
ADD CONSTRAINT "AccessGrant_target_check"
CHECK (
  num_nonnulls("providerConnectionId", "providerModelId", "searchStrategy") = 1
  AND ("providerConnectionId" IS NULL OR btrim("providerConnectionId") <> '')
  AND ("providerModelId" IS NULL OR btrim("providerModelId") <> '')
  AND ("searchStrategy" IS NULL OR btrim("searchStrategy") <> '')
),
ADD CONSTRAINT "AccessGrant_providerConnectionId_fkey"
FOREIGN KEY ("providerConnectionId") REFERENCES "ProviderConnection"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "AccessGrant_providerModelId_fkey"
FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "AccessGrant_providerConnectionId_idx"
ON "AccessGrant"("providerConnectionId");
CREATE INDEX "AccessGrant_providerModelId_idx"
ON "AccessGrant"("providerModelId");

DROP INDEX IF EXISTS "AccessGrant_provider_modelId_idx";

ALTER TABLE "AccessGrant"
DROP COLUMN "provider",
DROP COLUMN "modelId";

ALTER TABLE "UserSettings"
ADD COLUMN "defaultProviderModelId" TEXT;

UPDATE "UserSettings" settings
SET "defaultProviderModelId" = model_row."id"
FROM "ProviderModel" model_row
WHERE settings."defaultProvider" = model_row."provider"
  AND settings."defaultModelId" = model_row."modelId";

UPDATE "UserSettings" settings
SET "defaultControlValues" = COALESCE(
  (
    SELECT jsonb_object_agg(
      COALESCE(model_row."connectionId" || ':' || model_row."id", control."key"),
      control."value"
    )
    FROM jsonb_each(settings."defaultControlValues") control
    LEFT JOIN "ProviderModel" model_row
      ON control."key" = model_row."provider" || ':' || model_row."modelId"
  ),
  '{}'::jsonb
);

ALTER TABLE "UserSettings"
ADD CONSTRAINT "UserSettings_defaultProviderModelId_fkey"
FOREIGN KEY ("defaultProviderModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "UserSettings_defaultProviderModelId_idx"
ON "UserSettings"("defaultProviderModelId");

ALTER TABLE "UserSettings"
DROP COLUMN "defaultProvider",
DROP COLUMN "defaultModelId";

ALTER TABLE "Chat"
ADD COLUMN "defaultProviderModelId" TEXT;

UPDATE "Chat" chat
SET "defaultProviderModelId" = model_row."id"
FROM "ProviderModel" model_row
WHERE chat."defaultProvider" = model_row."provider"
  AND chat."defaultModelId" = model_row."modelId";

ALTER TABLE "Chat"
ADD CONSTRAINT "Chat_defaultProviderModelId_fkey"
FOREIGN KEY ("defaultProviderModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Chat_defaultProviderModelId_idx"
ON "Chat"("defaultProviderModelId");

ALTER TABLE "Chat"
DROP COLUMN "defaultProvider",
DROP COLUMN "defaultModelId";

ALTER TABLE "SearchStrategy"
ADD COLUMN "providerModelId" TEXT;

UPDATE "SearchStrategy" strategy
SET "providerModelId" = model_row."id"
FROM "ProviderModel" model_row
WHERE strategy."kind" = 'perplexity_tool_search'
  AND strategy."provider" = model_row."provider"
  AND strategy."modelId" = model_row."modelId";

ALTER TABLE "SearchStrategy"
ADD CONSTRAINT "SearchStrategy_provider_model_check"
CHECK (
  ("kind" = 'perplexity_tool_search' AND "providerModelId" IS NOT NULL)
  OR ("kind" IN ('none', 'openai_native_web_search') AND "providerModelId" IS NULL)
),
ADD CONSTRAINT "SearchStrategy_providerModelId_fkey"
FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "SearchStrategy_providerModelId_idx"
ON "SearchStrategy"("providerModelId");

CREATE TABLE "ProviderCredential" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "draftSecretEnvelope" TEXT,
  "draftVersion" INTEGER NOT NULL DEFAULT 0,
  "activeVersionId" TEXT,
  "testedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCredential_label_check" CHECK (btrim("label") <> ''),
  CONSTRAINT "ProviderCredential_draft_version_check" CHECK ("draftVersion" >= 0),
  CONSTRAINT "ProviderCredential_active_pointer_check"
    CHECK ("activeVersionId" IS NULL OR "activatedAt" IS NOT NULL)
);

CREATE UNIQUE INDEX "ProviderCredential_connectionId_id_key"
ON "ProviderCredential"("connectionId", "id");
CREATE UNIQUE INDEX "ProviderCredential_connectionId_label_key"
ON "ProviderCredential"("connectionId", "label");
CREATE UNIQUE INDEX "ProviderCredential_id_activeVersionId_key"
ON "ProviderCredential"("id", "activeVersionId");
CREATE INDEX "ProviderCredential_connectionId_enabled_idx"
ON "ProviderCredential"("connectionId", "enabled");

ALTER TABLE "ProviderCredential"
ADD CONSTRAINT "ProviderCredential_connectionId_fkey"
FOREIGN KEY ("connectionId") REFERENCES "ProviderConnection"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderCredentialVersion" (
  "id" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "secretEnvelope" TEXT,
  "testEvidence" JSONB NOT NULL,
  "testedAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderCredentialVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCredentialVersion_version_check" CHECK ("version" > 0),
  CONSTRAINT "ProviderCredentialVersion_secret_check"
    CHECK ("secretEnvelope" IS NOT NULL OR "revokedAt" IS NOT NULL)
);

CREATE UNIQUE INDEX "ProviderCredentialVersion_credentialId_id_key"
ON "ProviderCredentialVersion"("credentialId", "id");
CREATE UNIQUE INDEX "ProviderCredentialVersion_credentialId_version_key"
ON "ProviderCredentialVersion"("credentialId", "version");
CREATE INDEX "ProviderCredentialVersion_revokedAt_idx"
ON "ProviderCredentialVersion"("revokedAt");

ALTER TABLE "ProviderCredentialVersion"
ADD CONSTRAINT "ProviderCredentialVersion_credentialId_fkey"
FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderCredential"
ADD CONSTRAINT "ProviderCredential_activeVersion_fkey"
FOREIGN KEY ("id", "activeVersionId")
REFERENCES "ProviderCredentialVersion"("credentialId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ProviderConnection"
ADD CONSTRAINT "ProviderConnection_defaultCredential_fkey"
FOREIGN KEY ("id", "defaultCredentialId")
REFERENCES "ProviderCredential"("connectionId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "ProviderGroupCredentialAssignment" (
  "connectionId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderGroupCredentialAssignment_pkey"
    PRIMARY KEY ("connectionId", "groupId")
);

CREATE INDEX "ProviderGroupCredentialAssignment_credentialId_idx"
ON "ProviderGroupCredentialAssignment"("credentialId");
CREATE INDEX "ProviderGroupCredentialAssignment_groupId_idx"
ON "ProviderGroupCredentialAssignment"("groupId");

ALTER TABLE "ProviderGroupCredentialAssignment"
ADD CONSTRAINT "ProviderGroupAssignment_credential_fkey"
FOREIGN KEY ("connectionId", "credentialId")
REFERENCES "ProviderCredential"("connectionId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderGroupAssignment_group_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderDraftCheck" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "providerModelId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "credentialVersionId" TEXT,
  "credentialDraftVersion" INTEGER,
  "connectionDraftVersion" INTEGER NOT NULL,
  "modelDraftVersion" INTEGER NOT NULL,
  "status" "ProviderCredentialCheckStatus" NOT NULL,
  "evidence" JSONB,
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderDraftCheck_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderDraftCheck_credential_source_check"
    CHECK (num_nonnulls("credentialVersionId", "credentialDraftVersion") = 1),
  CONSTRAINT "ProviderDraftCheck_versions_check"
    CHECK (
      "connectionDraftVersion" >= 1
      AND "modelDraftVersion" >= 1
      AND ("credentialDraftVersion" IS NULL OR "credentialDraftVersion" >= 1)
    )
);

CREATE UNIQUE INDEX "ProviderDraftCheck_fingerprint_key"
ON "ProviderDraftCheck"("fingerprint");
CREATE UNIQUE INDEX "ProviderDraftCheck_active_tuple_key"
ON "ProviderDraftCheck"(
  "connectionId", "providerModelId", "credentialId", "credentialVersionId",
  "connectionDraftVersion", "modelDraftVersion"
)
WHERE "credentialVersionId" IS NOT NULL;
CREATE UNIQUE INDEX "ProviderDraftCheck_draft_tuple_key"
ON "ProviderDraftCheck"(
  "connectionId", "providerModelId", "credentialId", "credentialDraftVersion",
  "connectionDraftVersion", "modelDraftVersion"
)
WHERE "credentialDraftVersion" IS NOT NULL;
CREATE INDEX "ProviderDraftCheck_connectionId_providerModelId_idx"
ON "ProviderDraftCheck"("connectionId", "providerModelId");
CREATE INDEX "ProviderDraftCheck_credentialId_credentialVersionId_idx"
ON "ProviderDraftCheck"("credentialId", "credentialVersionId");

ALTER TABLE "ProviderDraftCheck"
ADD CONSTRAINT "ProviderDraftCheck_credential_fkey"
FOREIGN KEY ("connectionId", "credentialId")
REFERENCES "ProviderCredential"("connectionId", "id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderDraftCheck_version_fkey"
FOREIGN KEY ("credentialId", "credentialVersionId")
REFERENCES "ProviderCredentialVersion"("credentialId", "id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderDraftCheck_model_fkey"
FOREIGN KEY ("connectionId", "providerModelId")
REFERENCES "ProviderModel"("connectionId", "id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "ProviderModelCredentialCheck" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "providerModelId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "credentialVersionId" TEXT NOT NULL,
  "connectionVersion" INTEGER NOT NULL,
  "modelVersion" INTEGER NOT NULL,
  "status" "ProviderCredentialCheckStatus" NOT NULL,
  "evidence" JSONB,
  "latestRefreshError" JSONB,
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "refreshFailedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderModelCredentialCheck_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderModelCredentialCheck_versions_check"
    CHECK ("connectionVersion" > 0 AND "modelVersion" > 0)
);

CREATE UNIQUE INDEX "ProviderModelCredentialCheck_tuple_key"
ON "ProviderModelCredentialCheck"(
  "providerModelId", "credentialVersionId", "connectionVersion", "modelVersion"
);
CREATE INDEX "ProviderModelCredentialCheck_connection_model_idx"
ON "ProviderModelCredentialCheck"("connectionId", "providerModelId");
CREATE INDEX "ProviderModelCredentialCheck_credential_version_idx"
ON "ProviderModelCredentialCheck"("credentialId", "credentialVersionId");

ALTER TABLE "ProviderModelCredentialCheck"
ADD CONSTRAINT "ProviderModelCredentialCheck_credential_fkey"
FOREIGN KEY ("connectionId", "credentialId")
REFERENCES "ProviderCredential"("connectionId", "id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderModelCredentialCheck_version_fkey"
FOREIGN KEY ("credentialId", "credentialVersionId")
REFERENCES "ProviderCredentialVersion"("credentialId", "id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderModelCredentialCheck_model_fkey"
FOREIGN KEY ("connectionId", "providerModelId")
REFERENCES "ProviderModel"("connectionId", "id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "ProviderRunBinding" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "role" "ProviderRunRole" NOT NULL,
  "connectionId" TEXT,
  "providerModelId" TEXT,
  "credentialId" TEXT,
  "credentialVersionId" TEXT,
  "credentialSource" "ProviderCredentialSource" NOT NULL,
  "executionSnapshot" JSONB NOT NULL,
  "recoverableUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderRunBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderRunBinding_live_or_detached_check"
    CHECK (
      (
        "connectionId" IS NULL
        AND "providerModelId" IS NULL
        AND "credentialId" IS NULL
        AND "credentialVersionId" IS NULL
      )
      OR (
        "connectionId" IS NOT NULL
        AND "providerModelId" IS NOT NULL
        AND (
          ("credentialId" IS NULL AND "credentialVersionId" IS NULL)
          OR ("credentialId" IS NOT NULL AND "credentialVersionId" IS NOT NULL)
        )
      )
    )
);

CREATE UNIQUE INDEX "ProviderRunBinding_modelRunId_role_key"
ON "ProviderRunBinding"("modelRunId", "role");
CREATE INDEX "ProviderRunBinding_connection_model_idx"
ON "ProviderRunBinding"("connectionId", "providerModelId");
CREATE INDEX "ProviderRunBinding_credential_version_idx"
ON "ProviderRunBinding"("credentialId", "credentialVersionId");
CREATE INDEX "ProviderRunBinding_recoverableUntil_idx"
ON "ProviderRunBinding"("recoverableUntil");

ALTER TABLE "ProviderRunBinding"
ADD CONSTRAINT "ProviderRunBinding_modelRunId_fkey"
FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ProviderRunBinding_credential_fkey"
FOREIGN KEY ("connectionId", "credentialId")
REFERENCES "ProviderCredential"("connectionId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderRunBinding_version_fkey"
FOREIGN KEY ("credentialId", "credentialVersionId")
REFERENCES "ProviderCredentialVersion"("credentialId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "ProviderRunBinding_model_fkey"
FOREIGN KEY ("connectionId", "providerModelId")
REFERENCES "ProviderModel"("connectionId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT;
