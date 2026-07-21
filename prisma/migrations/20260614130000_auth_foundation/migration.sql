-- CreateEnum
CREATE TYPE "AuthAccessRuleKind" AS ENUM ('email', 'domain');

-- CreateEnum
CREATE TYPE "AuthFlowTokenPurpose" AS ENUM ('email_verification', 'password_reset', 'invite_acceptance');

-- CreateEnum
CREATE TYPE "AuthIdentityProvider" AS ENUM ('password', 'google', 'yandex');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'disabled', 'denied');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'user',
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'pending';

-- Preserve already-seeded local data as active, then promote the bootstrap operator.
UPDATE "User"
SET "status" = 'active';

UPDATE "User"
SET "role" = 'admin',
    "status" = 'active'
WHERE "id" = '00000000-0000-4000-8000-000000000001';

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AuthIdentityProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokedReason" TEXT,
    "createdByIp" TEXT,
    "createdByUserAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAccessRule" (
    "id" TEXT NOT NULL,
    "kind" "AuthAccessRuleKind" NOT NULL,
    "value" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAccessRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAccessRuleGroup" (
    "accessRuleId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAccessRuleGroup_pkey" PRIMARY KEY ("accessRuleId","groupId")
);

-- CreateTable
CREATE TABLE "AuthInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthInviteGroup" (
    "inviteId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthInviteGroup_pkey" PRIMARY KEY ("inviteId","groupId")
);

-- CreateTable
CREATE TABLE "AuthFlowToken" (
    "id" TEXT NOT NULL,
    "purpose" "AuthFlowTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT,
    "identityId" TEXT,
    "inviteId" TEXT,
    "normalizedEmail" TEXT,
    "sentToEmail" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthFlowToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_providerAccountId_key" ON "AuthIdentity"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_normalizedEmail_key" ON "AuthIdentity"("provider", "normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthIdentity_normalizedEmail_idx" ON "AuthIdentity"("normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_revokedAt_idx" ON "AuthSession"("revokedAt");

-- CreateIndex
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccessRule_kind_value_key" ON "AuthAccessRule"("kind", "value");

-- CreateIndex
CREATE INDEX "AuthAccessRule_enabled_idx" ON "AuthAccessRule"("enabled");

-- CreateIndex
CREATE INDEX "AuthAccessRuleGroup_groupId_idx" ON "AuthAccessRuleGroup"("groupId");

-- CreateIndex
CREATE INDEX "AuthInvite_expiresAt_idx" ON "AuthInvite"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthInvite_normalizedEmail_idx" ON "AuthInvite"("normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthInvite_revokedAt_idx" ON "AuthInvite"("revokedAt");

-- CreateIndex
CREATE INDEX "AuthInviteGroup_groupId_idx" ON "AuthInviteGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthFlowToken_tokenHash_key" ON "AuthFlowToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthFlowToken_identityId_idx" ON "AuthFlowToken"("identityId");

-- CreateIndex
CREATE INDEX "AuthFlowToken_inviteId_idx" ON "AuthFlowToken"("inviteId");

-- CreateIndex
CREATE INDEX "AuthFlowToken_normalizedEmail_idx" ON "AuthFlowToken"("normalizedEmail");

-- CreateIndex
CREATE INDEX "AuthFlowToken_purpose_expiresAt_idx" ON "AuthFlowToken"("purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthFlowToken_userId_idx" ON "AuthFlowToken"("userId");

-- Seed the existing bootstrap operator with a verified password identity shell.
-- No password is created in this foundation task; later password setup/reset fills passwordHash.
INSERT INTO "AuthIdentity" (
    "id",
    "userId",
    "provider",
    "providerAccountId",
    "normalizedEmail",
    "emailVerifiedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    '00000000-0000-4000-8000-000000000020',
    "id",
    'password',
    lower(trim("email")),
    lower(trim("email")),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "User"
WHERE "id" = '00000000-0000-4000-8000-000000000001'
  AND "email" IS NOT NULL
ON CONFLICT ("provider", "providerAccountId") DO NOTHING;

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccessRule" ADD CONSTRAINT "AuthAccessRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccessRuleGroup" ADD CONSTRAINT "AuthAccessRuleGroup_accessRuleId_fkey" FOREIGN KEY ("accessRuleId") REFERENCES "AuthAccessRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccessRuleGroup" ADD CONSTRAINT "AuthAccessRuleGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInvite" ADD CONSTRAINT "AuthInvite_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInvite" ADD CONSTRAINT "AuthInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInviteGroup" ADD CONSTRAINT "AuthInviteGroup_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "AuthInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthInviteGroup" ADD CONSTRAINT "AuthInviteGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthFlowToken" ADD CONSTRAINT "AuthFlowToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthFlowToken" ADD CONSTRAINT "AuthFlowToken_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "AuthIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthFlowToken" ADD CONSTRAINT "AuthFlowToken_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "AuthInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
