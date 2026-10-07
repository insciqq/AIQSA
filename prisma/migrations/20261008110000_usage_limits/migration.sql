-- Administrator usage limits. The installation singleton holds the pooled
-- monthly cap for everyone and the per-user defaults; a UsageLimit row is one
-- group's per-member allowance or one user's override. NULL means "not set";
-- bounds mirror USAGE_LIMIT_BOUNDS (lib/contracts/usageLimits.ts). Both tables
-- are new and small, so ordinary DDL in one transaction is safe.
CREATE TABLE "UsageLimitPolicy" (
  "id" TEXT NOT NULL,
  "monthlyCapMicros" BIGINT,
  "monthlyBudgetMicros" BIGINT,
  "messagesPerHour" INTEGER,
  "messagesPerDay" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsageLimitPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLimitPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "UsageLimitPolicy_version_check" CHECK ("version" >= 1),
  CONSTRAINT "UsageLimitPolicy_values_check" CHECK (
    ("monthlyCapMicros" IS NULL OR "monthlyCapMicros" BETWEEN 0 AND 1000000000000) AND
    ("monthlyBudgetMicros" IS NULL OR "monthlyBudgetMicros" BETWEEN 0 AND 1000000000000) AND
    ("messagesPerHour" IS NULL OR "messagesPerHour" BETWEEN 0 AND 10000) AND
    ("messagesPerDay" IS NULL OR "messagesPerDay" BETWEEN 0 AND 100000)
  ),
  CONSTRAINT "UsageLimitPolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "UsageLimitPolicy_updatedByUserId_idx" ON "UsageLimitPolicy"("updatedByUserId");

-- No limits until an administrator sets them.
INSERT INTO "UsageLimitPolicy" ("id", "updatedAt")
VALUES ('installation', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE "UsageLimit" (
  "id" TEXT NOT NULL,
  "groupId" TEXT,
  "userId" TEXT,
  "exempt" BOOLEAN NOT NULL DEFAULT false,
  "monthlyBudgetMicros" BIGINT,
  "messagesPerHour" INTEGER,
  "messagesPerDay" INTEGER,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsageLimit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLimit_target_check" CHECK (num_nonnulls("groupId", "userId") = 1),
  -- Exemption drops per-user limits, so only a user override can carry it.
  CONSTRAINT "UsageLimit_exempt_check" CHECK (NOT "exempt" OR "userId" IS NOT NULL),
  CONSTRAINT "UsageLimit_values_check" CHECK (
    ("monthlyBudgetMicros" IS NULL OR "monthlyBudgetMicros" BETWEEN 0 AND 1000000000000) AND
    ("messagesPerHour" IS NULL OR "messagesPerHour" BETWEEN 0 AND 10000) AND
    ("messagesPerDay" IS NULL OR "messagesPerDay" BETWEEN 0 AND 100000)
  ),
  -- A row that sets nothing is deleted instead of stored.
  CONSTRAINT "UsageLimit_present_check" CHECK (
    "exempt" OR num_nonnulls("monthlyBudgetMicros", "messagesPerHour", "messagesPerDay") > 0
  ),
  CONSTRAINT "UsageLimit_groupId_fkey" FOREIGN KEY ("groupId")
    REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UsageLimit_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UsageLimit_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UsageLimit_groupId_key" ON "UsageLimit"("groupId");
CREATE UNIQUE INDEX "UsageLimit_userId_key" ON "UsageLimit"("userId");
CREATE INDEX "UsageLimit_updatedByUserId_idx" ON "UsageLimit"("updatedByUserId");
