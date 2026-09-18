-- Auto is a nullable installation setting; accepted runs retain their numeric budgets.
ALTER TABLE "ModelPolicy"
  ALTER COLUMN "mcpAutoDiscoveryMaxOutputTokens" DROP NOT NULL,
  ALTER COLUMN "mcpAutoDiscoveryMaxOutputTokens" DROP DEFAULT;

-- Only untouched installation defaults adopt Auto. An administrator's saved
-- policy remains exact and can explicitly opt in through Defaults & roles.
UPDATE "ModelPolicy"
SET "mcpAutoDiscoveryMaxOutputTokens" = NULL, version = version + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "mcpAutoDiscoveryMaxOutputTokens" = 8192 AND "updatedByUserId" IS NULL AND version = 1;
