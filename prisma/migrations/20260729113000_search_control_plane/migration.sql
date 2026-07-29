-- ADR 0043: administrator-owned, versioned Search integrations and bounded
-- multi-engine run plans. Existing strategy ids remain the option identity.

ALTER TABLE "UserSettings"
ADD COLUMN "defaultSearchPlan" JSONB NOT NULL
DEFAULT '{"mode":"all_selected","optionIds":[]}'::jsonb;

UPDATE "UserSettings"
SET "defaultSearchPlan" = CASE
  WHEN "defaultSearchStrategyId" = 'search-disabled'
    THEN '{"mode":"all_selected","optionIds":[]}'::jsonb
  ELSE jsonb_build_object(
    'mode', 'all_selected',
    'optionIds', jsonb_build_array("defaultSearchStrategyId")
  )
END;

ALTER TABLE "ProviderRunBinding"
ADD COLUMN "bindingKey" TEXT;

UPDATE "ProviderRunBinding" binding
SET "bindingKey" = CASE
  WHEN binding."role" = 'answer' THEN 'answer'
  -- Historical normalized requests contain only one Search strategy. Keep
  -- their legacy resolver key so accepted runs remain recoverable after the
  -- multi-engine binding-key migration.
  ELSE 'search'
END
FROM "ModelRun" run
WHERE run."id" = binding."modelRunId";

UPDATE "ProviderRunBinding"
SET "bindingKey" = CASE
  WHEN "role" = 'answer' THEN 'answer'
  ELSE 'search'
END
WHERE "bindingKey" IS NULL;

ALTER TABLE "ProviderRunBinding"
ALTER COLUMN "bindingKey" SET NOT NULL,
ALTER COLUMN "bindingKey" SET DEFAULT 'answer';

DROP INDEX "ProviderRunBinding_modelRunId_role_key";
CREATE UNIQUE INDEX "ProviderRunBinding_modelRunId_bindingKey_key"
ON "ProviderRunBinding"("modelRunId", "bindingKey");
CREATE INDEX "ProviderRunBinding_modelRunId_role_idx"
ON "ProviderRunBinding"("modelRunId", "role");

ALTER TABLE "SearchStrategy"
ADD COLUMN "adapterKind" TEXT NOT NULL DEFAULT 'answer_provider_hosted',
ADD COLUMN "credentialMode" TEXT NOT NULL DEFAULT 'answer_provider',
ADD COLUMN "draft" JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN "draftVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "testedDraftHash" TEXT,
ADD COLUMN "draftTestEvidence" JSONB,
ADD COLUMN "activeRevisionId" TEXT,
ADD COLUMN "activatedAt" TIMESTAMP(3),
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- The previous constraint knew only the three code-owned kinds. The generic
-- typed client adapter deliberately keeps a provider-model reference without
-- coupling option identity to one built-in strategy id.
ALTER TABLE "SearchStrategy"
DROP CONSTRAINT "SearchStrategy_provider_model_check",
ADD CONSTRAINT "SearchStrategy_provider_model_check" CHECK (
  (
    "kind" IN ('perplexity_tool_search', 'provider_model_web_search')
    AND "providerModelId" IS NOT NULL
  )
  OR (
    "kind" IN ('none', 'openai_native_web_search', 'gemini_google_search')
    AND "providerModelId" IS NULL
  )
);

UPDATE "SearchStrategy"
SET
  "adapterKind" = CASE
    WHEN "kind" = 'none' THEN 'none'
    WHEN "kind" = 'perplexity_tool_search' THEN 'provider_model_client'
    ELSE 'answer_provider_hosted'
  END,
  "credentialMode" = CASE
    WHEN "kind" = 'perplexity_tool_search' THEN 'provider_model'
    ELSE 'answer_provider'
  END,
  "draft" = jsonb_build_object(
    'adapterKind', CASE
      WHEN "kind" = 'none' THEN 'none'
      WHEN "kind" = 'perplexity_tool_search' THEN 'provider_model_client'
      ELSE 'answer_provider_hosted'
    END,
    'credentialMode', CASE
      WHEN "kind" = 'perplexity_tool_search' THEN 'provider_model'
      ELSE 'answer_provider'
    END,
    'protocol', CASE
      WHEN "kind" = 'gemini_google_search' THEN 'gemini_google_search'
      WHEN "kind" = 'perplexity_tool_search' THEN 'openrouter_perplexity_chat'
      WHEN "kind" = 'openai_native_web_search' THEN 'openai_responses_web_search'
      ELSE 'none'
    END,
    'providerModelId', "providerModelId",
    'configuration', "config"
  ),
  -- Migrated rows are already active and get explicit migration evidence.
  -- Any later draft edit must pass the ordinary SHA-256 test fence before it
  -- can replace this revision.
  "testedDraftHash" = 'migration:' || "id",
  "draftTestEvidence" = jsonb_build_object(
    'method', 'migration',
    'status', 'available'
  ),
  "activatedAt" = COALESCE("updatedAt", "createdAt");

CREATE TABLE "SearchIntegrationRevision" (
  "id" TEXT NOT NULL,
  "searchStrategyId" TEXT NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "adapterKind" TEXT NOT NULL,
  "credentialMode" TEXT NOT NULL,
  "configuration" JSONB NOT NULL,
  "providerModelId" TEXT,
  "validationEvidence" JSONB NOT NULL,
  "draftHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SearchIntegrationRevision_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SearchIntegrationRevision" (
  "id",
  "searchStrategyId",
  "revisionNumber",
  "adapterKind",
  "credentialMode",
  "configuration",
  "providerModelId",
  "validationEvidence",
  "draftHash",
  "createdAt"
)
SELECT
  strategy."id" || ':revision:1',
  strategy."id",
  1,
  strategy."adapterKind",
  strategy."credentialMode",
  strategy."draft",
  strategy."providerModelId",
  strategy."draftTestEvidence",
  strategy."testedDraftHash",
  COALESCE(strategy."activatedAt", strategy."createdAt")
FROM "SearchStrategy" strategy;

UPDATE "SearchStrategy"
SET "activeRevisionId" = "id" || ':revision:1';

CREATE UNIQUE INDEX "SearchStrategy_activeRevisionId_key"
ON "SearchStrategy"("activeRevisionId");
CREATE UNIQUE INDEX "SearchStrategy_id_activeRevisionId_key"
ON "SearchStrategy"("id", "activeRevisionId");
CREATE INDEX "SearchStrategy_enabled_archivedAt_idx"
ON "SearchStrategy"("enabled", "archivedAt");
CREATE UNIQUE INDEX "SearchIntegrationRevision_strategy_revision_key"
ON "SearchIntegrationRevision"("searchStrategyId", "revisionNumber");
CREATE UNIQUE INDEX "SearchIntegrationRevision_strategy_draftHash_key"
ON "SearchIntegrationRevision"("searchStrategyId", "draftHash");
CREATE UNIQUE INDEX "SearchIntegrationRevision_strategy_id_key"
ON "SearchIntegrationRevision"("searchStrategyId", "id");
CREATE INDEX "SearchIntegrationRevision_providerModelId_idx"
ON "SearchIntegrationRevision"("providerModelId");

ALTER TABLE "SearchStrategy"
ADD CONSTRAINT "SearchStrategy_activeRevision_fkey"
FOREIGN KEY ("id", "activeRevisionId")
REFERENCES "SearchIntegrationRevision"("searchStrategyId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "SearchIntegrationRevision"
ADD CONSTRAINT "SearchIntegrationRevision_searchStrategyId_fkey"
FOREIGN KEY ("searchStrategyId") REFERENCES "SearchStrategy"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "SearchIntegrationRevision_providerModelId_fkey"
FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "SearchIntegrationRevision_revisionNumber_check"
CHECK ("revisionNumber" >= 1),
ADD CONSTRAINT "SearchIntegrationRevision_adapterKind_check"
CHECK ("adapterKind" IN ('none', 'answer_provider_hosted', 'provider_model_client')),
ADD CONSTRAINT "SearchIntegrationRevision_credentialMode_check"
CHECK ("credentialMode" IN ('answer_provider', 'provider_model'));

ALTER TABLE "SearchStrategy"
ADD CONSTRAINT "SearchStrategy_draftVersion_check"
CHECK ("draftVersion" >= 1),
ADD CONSTRAINT "SearchStrategy_adapterKind_check"
CHECK ("adapterKind" IN ('none', 'answer_provider_hosted', 'provider_model_client')),
ADD CONSTRAINT "SearchStrategy_credentialMode_check"
CHECK ("credentialMode" IN ('answer_provider', 'provider_model'));

CREATE TABLE "SearchRunBinding" (
  "id" TEXT NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "searchStrategyId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "optionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "technicalBindingKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SearchRunBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SearchRunBinding_ordinal_check" CHECK ("ordinal" >= 0 AND "ordinal" < 3),
  CONSTRAINT "SearchRunBinding_mode_check" CHECK ("mode" IN ('all_selected', 'model_choice'))
);

CREATE UNIQUE INDEX "SearchRunBinding_modelRunId_ordinal_key"
ON "SearchRunBinding"("modelRunId", "ordinal");
CREATE UNIQUE INDEX "SearchRunBinding_modelRunId_optionId_key"
ON "SearchRunBinding"("modelRunId", "optionId");
CREATE INDEX "SearchRunBinding_revisionId_idx"
ON "SearchRunBinding"("revisionId");
CREATE INDEX "SearchRunBinding_searchStrategyId_idx"
ON "SearchRunBinding"("searchStrategyId");

ALTER TABLE "SearchRunBinding"
ADD CONSTRAINT "SearchRunBinding_modelRunId_fkey"
FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "SearchRunBinding_searchStrategyId_fkey"
FOREIGN KEY ("searchStrategyId") REFERENCES "SearchStrategy"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "SearchRunBinding_revisionId_fkey"
FOREIGN KEY ("revisionId") REFERENCES "SearchIntegrationRevision"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SearchRun"
ADD COLUMN "searchRevisionId" TEXT,
ADD COLUMN "invocationId" TEXT,
ADD COLUMN "query" TEXT,
ADD COLUMN "durationMs" INTEGER;

CREATE UNIQUE INDEX "SearchRun_modelRunId_invocationId_key"
ON "SearchRun"("modelRunId", "invocationId");
CREATE INDEX "SearchRun_searchRevisionId_idx"
ON "SearchRun"("searchRevisionId");

ALTER TABLE "SearchRun"
ADD CONSTRAINT "SearchRun_searchRevisionId_fkey"
FOREIGN KEY ("searchRevisionId") REFERENCES "SearchIntegrationRevision"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "SearchRun_durationMs_check"
CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
ADD CONSTRAINT "SearchRun_query_length_check"
CHECK ("query" IS NULL OR char_length("query") <= 1000);
