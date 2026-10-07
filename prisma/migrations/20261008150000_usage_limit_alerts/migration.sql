-- Budget alerts to administrators: one row per UTC month, threshold and user
-- (the user only for a reached personal budget). The row is the claim,
-- inserted before sending, so replicas and restarts send each alert at most
-- once; NULLS NOT DISTINCT makes the pooled-cap rows (no user) unique too.
-- `claimed` rows are in flight or crash-ambiguous and are never retried;
-- `undelivered` rows reached nobody and may be claimed again by a later check.
-- The table is new and starts empty, so ordinary DDL in one transaction is safe.
CREATE TYPE "UsageLimitAlertKind" AS ENUM ('installation_cap_near', 'installation_cap_reached', 'user_budget_reached');

CREATE TYPE "UsageLimitAlertState" AS ENUM ('claimed', 'delivered', 'undelivered');

CREATE TABLE "UsageLimitAlert" (
  "id" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "kind" "UsageLimitAlertKind" NOT NULL,
  "userId" TEXT,
  "state" "UsageLimitAlertState" NOT NULL DEFAULT 'claimed',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "claimedAt" TIMESTAMP(3) NOT NULL,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "UsageLimitAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLimitAlert_user_check" CHECK (("kind" = 'user_budget_reached') = ("userId" IS NOT NULL)),
  CONSTRAINT "UsageLimitAlert_attempts_check" CHECK ("attempts" >= 1),
  CONSTRAINT "UsageLimitAlert_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UsageLimitAlert_periodStart_kind_userId_key"
  ON "UsageLimitAlert"("periodStart", "kind", "userId") NULLS NOT DISTINCT;
CREATE INDEX "UsageLimitAlert_userId_idx" ON "UsageLimitAlert"("userId");
