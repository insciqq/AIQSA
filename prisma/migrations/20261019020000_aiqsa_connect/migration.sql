-- AIQSA Connect: the installation switch (off until an administrator turns it
-- on), the computers paired with their owners' accounts and the pending
-- pairings they poll. New tables only; previous-release writers never touch
-- them. Only SHA-256 hashes of device tokens, pairing codes and poll secrets
-- are stored; terminal sessions and their output never reach the database.
CREATE TABLE "ConnectPolicy" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "ConnectPolicy_version_check" CHECK ("version" > 0)
);

INSERT INTO "ConnectPolicy" ("id", "enabled", "version", "updatedAt")
VALUES ('installation', false, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE "ConnectDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" VARCHAR(64) NOT NULL,
  "hostname" VARCHAR(255) NOT NULL,
  "os" VARCHAR(16) NOT NULL,
  "arch" VARCHAR(16) NOT NULL,
  "clientVersion" VARCHAR(64) NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  CONSTRAINT "ConnectDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectDevice_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);

-- A pairing is pending, denied, or approved by one account; only an approved
-- pairing is ever consumed, and it expires after it was created.
CREATE TABLE "ConnectPairing" (
  "id" TEXT NOT NULL,
  "userCodeHash" CHAR(64) NOT NULL,
  "pollSecretHash" CHAR(64) NOT NULL,
  "name" VARCHAR(64) NOT NULL,
  "hostname" VARCHAR(255) NOT NULL,
  "os" VARCHAR(16) NOT NULL,
  "arch" VARCHAR(16) NOT NULL,
  "clientVersion" VARCHAR(64) NOT NULL,
  "approvedUserId" TEXT,
  "deniedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectPairing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectPairing_userCodeHash_check" CHECK ("userCodeHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ConnectPairing_pollSecretHash_check" CHECK ("pollSecretHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ConnectPairing_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "ConnectPairing_state_check" CHECK (
    ("approvedUserId" IS NULL OR "deniedAt" IS NULL)
    AND ("consumedAt" IS NULL OR "approvedUserId" IS NOT NULL)
  )
);

CREATE INDEX "ConnectPolicy_updatedByUserId_idx" ON "ConnectPolicy"("updatedByUserId");
CREATE UNIQUE INDEX "ConnectDevice_tokenHash_key" ON "ConnectDevice"("tokenHash");
CREATE INDEX "ConnectDevice_userId_createdAt_idx" ON "ConnectDevice"("userId", "createdAt");
CREATE UNIQUE INDEX "ConnectPairing_userCodeHash_key" ON "ConnectPairing"("userCodeHash");
CREATE INDEX "ConnectPairing_expiresAt_consumedAt_idx" ON "ConnectPairing"("expiresAt", "consumedAt");
CREATE INDEX "ConnectPairing_approvedUserId_idx" ON "ConnectPairing"("approvedUserId");

-- Devices and approvals leave with their account; the policy keeps its
-- history without the deleted administrator.
ALTER TABLE "ConnectPolicy" ADD CONSTRAINT "ConnectPolicy_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConnectDevice" ADD CONSTRAINT "ConnectDevice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectPairing" ADD CONSTRAINT "ConnectPairing_approvedUserId_fkey"
  FOREIGN KEY ("approvedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
