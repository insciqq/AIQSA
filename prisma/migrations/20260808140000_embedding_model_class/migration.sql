-- Embedding deployments share provider connections, credentials, activation,
-- and grants, but are never eligible for answer-model admission.

CREATE TYPE "ProviderModelClass" AS ENUM ('answer', 'embedding');

ALTER TABLE "ProviderModel"
ADD COLUMN "modelClass" "ProviderModelClass" NOT NULL DEFAULT 'answer';

CREATE INDEX "ProviderModel_modelClass_enabled_idx"
ON "ProviderModel"("modelClass", "enabled");
