-- Auth admission must survive application restarts and be shared by every
-- process. keyHash is an installation-secret HMAC; raw IP, email, and token
-- material is not stored in this table.
CREATE TABLE "AuthRateLimitBucket" (
    "keyHash" CHAR(64) NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "resetAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AuthRateLimitBucket_pkey" PRIMARY KEY ("keyHash"),
    CONSTRAINT "AuthRateLimitBucket_attemptCount_check"
      CHECK ("attemptCount" >= 1)
);

CREATE INDEX "AuthRateLimitBucket_resetAt_idx"
ON "AuthRateLimitBucket"("resetAt");

-- Rollback requires stopping every application writer first, then dropping
-- AuthRateLimitBucket. Rolling back intentionally discards only admission
-- counters; it does not touch identities, credentials, or sessions.
