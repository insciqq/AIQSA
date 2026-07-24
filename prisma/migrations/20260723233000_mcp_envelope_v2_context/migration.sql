-- Add stable, non-reusable value identities for every mutable MCP secret
-- envelope. Ciphertext conversion is intentionally performed by the stopped
-- application cutover tool because PostgreSQL never receives the root key.

ALTER TABLE "McpOAuthClient"
ADD COLUMN "clientSecretGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "McpOAuthConnection"
ADD COLUMN "tokenGeneration" INTEGER NOT NULL DEFAULT 0;

UPDATE "McpOAuthClient"
SET "clientSecretGeneration" = 1
WHERE "clientSecretEnvelope" IS NOT NULL;

UPDATE "McpOAuthConnection"
SET "tokenGeneration" = 1
WHERE "tokenEnvelope" IS NOT NULL;

ALTER TABLE "McpServer"
ADD CONSTRAINT "McpServer_shared_config_envelope_generation_check"
CHECK ("sharedConfigVersion" > 0 OR "sharedConfigEnvelope" IS NULL);

ALTER TABLE "McpUserServer"
ADD CONSTRAINT "McpUserServer_personal_config_envelope_generation_check"
CHECK ("personalConfigVersion" > 0 OR "personalConfigEnvelope" IS NULL);

ALTER TABLE "McpOAuthClient"
ADD CONSTRAINT "McpOAuthClient_secret_generation_check"
CHECK (
  "clientSecretGeneration" >= 0
  AND ("clientSecretGeneration" > 0 OR "clientSecretEnvelope" IS NULL)
);

ALTER TABLE "McpOAuthConnection"
ADD CONSTRAINT "McpOAuthConnection_token_generation_check"
CHECK (
  "tokenGeneration" >= 0
  AND ("tokenGeneration" > 0 OR "tokenEnvelope" IS NULL)
);
