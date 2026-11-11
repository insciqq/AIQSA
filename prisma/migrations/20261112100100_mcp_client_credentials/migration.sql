-- MCP client credentials: an installation server may sign in with one OAuth
-- client-credentials grant. Its client secret is a write-only envelope on the
-- server row, sealed per generation and bound inside the envelope to the
-- token endpoint origin it was entered for; tokens live only in the app
-- process and are never stored. Expand only: previous-release writers never
-- read or write the columns, a nullable column and a constant default need no
-- rewrite or backfill, and every existing row satisfies the check.
ALTER TABLE "McpServer" ADD COLUMN "clientCredentialsSecretEnvelope" TEXT;
ALTER TABLE "McpServer" ADD COLUMN "clientCredentialsSecretGeneration" INTEGER NOT NULL DEFAULT 0;

-- Like the OAuth token envelope: a stored secret always has a generation.
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_client_credentials_secret_generation_check"
  CHECK ("clientCredentialsSecretGeneration" >= 0 AND
    ("clientCredentialsSecretGeneration" > 0 OR "clientCredentialsSecretEnvelope" IS NULL));
