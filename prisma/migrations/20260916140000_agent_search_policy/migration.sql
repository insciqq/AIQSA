CREATE TABLE "AgentPolicy" (
  "id" TEXT PRIMARY KEY,
  "limitsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "timeoutSeconds" INTEGER NOT NULL DEFAULT 3600,
  "maxModelCalls" INTEGER NOT NULL DEFAULT 40,
  "maxToolCalls" INTEGER NOT NULL DEFAULT 80,
  "tokenBudget" INTEGER NOT NULL DEFAULT 2000000,
  "maxOutputTokens" INTEGER NOT NULL DEFAULT 16384,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "AgentPolicy_values_check" CHECK (
    "version" > 0 AND "timeoutSeconds" BETWEEN 1 AND 7200 AND
    "maxModelCalls" BETWEEN 1 AND 200 AND "maxToolCalls" BETWEEN 1 AND 200 AND
    "tokenBudget" BETWEEN 1 AND 20000000 AND "maxOutputTokens" BETWEEN 1 AND 131072)
);
CREATE INDEX "AgentPolicy_updatedByUserId_idx" ON "AgentPolicy"("updatedByUserId");
INSERT INTO "AgentPolicy" ("id", "updatedAt") VALUES ('installation', CURRENT_TIMESTAMP);

ALTER TABLE "AgentRunBinding"
  ALTER COLUMN "reservedTokens" TYPE BIGINT,
  ADD COLUMN "failureCode" VARCHAR(64),
  DROP CONSTRAINT "AgentRunBinding_grant_check",
  ADD CONSTRAINT "AgentRunBinding_grant_check" CHECK (
    ("tokenHash" IS NULL) = ("startedAt" IS NULL) AND
    ("expiresAt" IS NULL OR "startedAt" IS NOT NULL));
ALTER TABLE "AgentProviderAttempt" ADD COLUMN "searchOptionId" TEXT, ADD COLUMN "searchInvocationId" TEXT;
CREATE INDEX "AgentProviderAttempt_modelRunId_searchOptionId_idx"
  ON "AgentProviderAttempt"("modelRunId", "searchOptionId");
