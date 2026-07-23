ALTER TABLE "McpRuntimeGeneration"
  ADD COLUMN "credentialSources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "externalAccountLabel" TEXT;

ALTER TABLE "McpRuntimeGeneration"
  ADD CONSTRAINT "McpRuntimeGeneration_credentialSources_check"
  CHECK (
    "credentialSources" <@ ARRAY['oauth', 'personal', 'shared']::TEXT[]
    AND cardinality("credentialSources") <= 3
  );
