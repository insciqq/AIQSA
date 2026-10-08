-- Storage for the whole external sign-in wave: OIDC, LDAP, SAML and
-- trusted-header identities, IdP group and admin-role management, sign-in
-- settings and switches, TOTP and SCIM. Expand only: new enum values, nullable
-- columns, new tables and checks that every existing row and previous-release
-- writer satisfies. The new enum values are not used before this migration
-- commits, and the unique indexes cover columns that are NULL on every
-- existing row of the small User and Group tables.

CREATE TYPE "GroupExternalNameSource" AS ENUM ('oidc', 'ldap', 'saml', 'trusted_header');

ALTER TYPE "AuthIdentityProvider" ADD VALUE 'oidc';
ALTER TYPE "AuthIdentityProvider" ADD VALUE 'ldap';
ALTER TYPE "AuthIdentityProvider" ADD VALUE 'saml';
ALTER TYPE "AuthIdentityProvider" ADD VALUE 'trusted_header';

-- Who manages the admin role, and SCIM provisioning state.
ALTER TABLE "User" ADD COLUMN     "roleManagedBy" TEXT,
ADD COLUMN     "scimDeactivatedAt" TIMESTAMP(3),
ADD COLUMN     "scimExternalId" TEXT;

-- External identities are bound to their configured source; password, Google
-- and Yandex identities (every existing row) have none.
ALTER TABLE "AuthIdentity" ADD COLUMN     "lastSyncWarning" VARCHAR(64),
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT,
ADD CONSTRAINT "AuthIdentity_source_check" CHECK (
  ("source" IS NULL) = ("provider" IN ('password', 'google', 'yandex'))
  AND ("source" IS NULL OR char_length("source") > 0)
);

-- Existing sessions keep a NULL sign-in method.
ALTER TABLE "AuthSession" ADD COLUMN     "signInMethod" VARCHAR(32);

ALTER TABLE "Group" ADD COLUMN     "scimExternalId" TEXT;

-- One row per configured method, with the SMTP control's draft, test,
-- activation, write-only secret and health invariants.
CREATE TABLE "AuthSignInMethodSetting" (
    "method" TEXT NOT NULL,
    "draftConfig" JSONB,
    "draftSecretEnvelope" TEXT,
    "draftSecretGeneration" INTEGER,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "testedDraftVersion" INTEGER,
    "draftTestVersion" INTEGER,
    "draftTestAt" TIMESTAMP(3),
    "draftTestCode" TEXT,
    "activeConfig" JSONB,
    "activeSecretEnvelope" TEXT,
    "activeSecretGeneration" INTEGER,
    "activeVersion" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "secretGenerationCounter" INTEGER NOT NULL DEFAULT 0,
    "healthActiveVersion" INTEGER,
    "lastAttemptAt" TIMESTAMP(3),
    "lastAcceptedAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "configurationUpdatedAt" TIMESTAMP(3),
    "configurationUpdatedByUserId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSignInMethodSetting_pkey" PRIMARY KEY ("method"),
    CONSTRAINT "AuthSignInMethodSetting_method_check" CHECK (
      "method" IN ('google', 'yandex', 'oidc', 'ldap', 'saml', 'trusted_header', 'scim')
    ),
    CONSTRAINT "AuthSignInMethodSetting_versions_check" CHECK (
      "draftVersion" >= 0 AND "activeVersion" >= 0 AND "secretGenerationCounter" >= 0
    ),
    CONSTRAINT "AuthSignInMethodSetting_draft_secret_check" CHECK (
      ("draftSecretEnvelope" IS NULL) = ("draftSecretGeneration" IS NULL)
      AND ("draftSecretGeneration" IS NULL
        OR "draftSecretGeneration" > 0 AND "draftSecretGeneration" <= "secretGenerationCounter")
    ),
    CONSTRAINT "AuthSignInMethodSetting_active_secret_check" CHECK (
      ("activeSecretEnvelope" IS NULL) = ("activeSecretGeneration" IS NULL)
      AND ("activeSecretGeneration" IS NULL
        OR "activeSecretGeneration" > 0 AND "activeSecretGeneration" <= "secretGenerationCounter")
    ),
    CONSTRAINT "AuthSignInMethodSetting_draft_slot_check" CHECK (
      "draftConfig" IS NOT NULL
      OR "draftSecretEnvelope" IS NULL AND "draftSecretGeneration" IS NULL
        AND "testedDraftVersion" IS NULL AND "draftTestVersion" IS NULL
        AND "draftTestAt" IS NULL AND "draftTestCode" IS NULL
    ),
    CONSTRAINT "AuthSignInMethodSetting_draft_test_check" CHECK (
      "draftTestVersion" IS NULL AND "draftTestAt" IS NULL AND "draftTestCode" IS NULL
      OR "draftTestVersion" = "draftVersion" AND "draftTestAt" IS NOT NULL AND "draftTestCode" IS NOT NULL
    ),
    -- A tested draft is the current draft whose recorded test passed; the
    -- method's tester owns the result codes.
    CONSTRAINT "AuthSignInMethodSetting_tested_draft_check" CHECK (
      "testedDraftVersion" IS NULL
      OR "testedDraftVersion" = "draftVersion" AND "draftTestVersion" = "draftVersion"
    ),
    CONSTRAINT "AuthSignInMethodSetting_active_slot_check" CHECK (
      "activeConfig" IS NULL AND "activeSecretEnvelope" IS NULL AND "activeSecretGeneration" IS NULL
        AND "enabled" = false AND "activatedAt" IS NULL AND "activatedByUserId" IS NULL
      OR "activeConfig" IS NOT NULL AND "activatedAt" IS NOT NULL
    ),
    CONSTRAINT "AuthSignInMethodSetting_health_check" CHECK (
      "healthActiveVersion" IS NULL AND "lastAttemptAt" IS NULL AND "lastAcceptedAt" IS NULL
        AND "lastFailureAt" IS NULL AND "lastFailureCode" IS NULL
      OR "healthActiveVersion" = "activeVersion" AND ("lastFailureAt" IS NULL) = ("lastFailureCode" IS NULL)
    )
);

-- Password sign-in and registration switches; a missing row means both on.
CREATE TABLE "AuthSignInPolicy" (
    "id" TEXT NOT NULL,
    "passwordLoginEnabled" BOOLEAN NOT NULL DEFAULT true,
    "registrationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSignInPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthSignInPolicy_singleton_check" CHECK ("id" = 'installation'),
    CONSTRAINT "AuthSignInPolicy_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "AuthTotpFactor" (
    "userId" TEXT NOT NULL,
    "secretEnvelope" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "pendingSecretEnvelope" TEXT,
    "pendingCreatedAt" TIMESTAMP(3),
    "lastUsedStep" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthTotpFactor_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "AuthTotpFactor_confirmed_check" CHECK (("secretEnvelope" IS NULL) = ("confirmedAt" IS NULL)),
    CONSTRAINT "AuthTotpFactor_pending_check" CHECK (("pendingSecretEnvelope" IS NULL) = ("pendingCreatedAt" IS NULL)),
    CONSTRAINT "AuthTotpFactor_step_check" CHECK ("lastUsedStep" IS NULL OR "lastUsedStep" >= 0)
);

CREATE TABLE "AuthRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthScimToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayPrefix" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AuthScimToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupExternalName" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "source" "GroupExternalNameSource" NOT NULL,
    "value" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupExternalName_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GroupExternalName_value_check" CHECK (char_length("value") > 0)
);

CREATE INDEX "AuthSignInMethodSetting_activatedByUserId_idx" ON "AuthSignInMethodSetting"("activatedByUserId");

CREATE INDEX "AuthSignInMethodSetting_configurationUpdatedByUserId_idx" ON "AuthSignInMethodSetting"("configurationUpdatedByUserId");

CREATE INDEX "AuthSignInPolicy_updatedByUserId_idx" ON "AuthSignInPolicy"("updatedByUserId");

CREATE UNIQUE INDEX "AuthRecoveryCode_codeHash_key" ON "AuthRecoveryCode"("codeHash");

CREATE INDEX "AuthRecoveryCode_userId_idx" ON "AuthRecoveryCode"("userId");

CREATE UNIQUE INDEX "AuthScimToken_tokenHash_key" ON "AuthScimToken"("tokenHash");

CREATE INDEX "AuthScimToken_createdByUserId_idx" ON "AuthScimToken"("createdByUserId");

CREATE INDEX "GroupExternalName_source_value_idx" ON "GroupExternalName"("source", "value");

CREATE UNIQUE INDEX "GroupExternalName_groupId_source_value_key" ON "GroupExternalName"("groupId", "source", "value");

CREATE UNIQUE INDEX "User_scimExternalId_key" ON "User"("scimExternalId");

CREATE UNIQUE INDEX "Group_scimExternalId_key" ON "Group"("scimExternalId");

ALTER TABLE "AuthSignInMethodSetting" ADD CONSTRAINT "AuthSignInMethodSetting_activatedByUserId_fkey" FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuthSignInMethodSetting" ADD CONSTRAINT "AuthSignInMethodSetting_configurationUpdatedByUserId_fkey" FOREIGN KEY ("configurationUpdatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuthSignInPolicy" ADD CONSTRAINT "AuthSignInPolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuthTotpFactor" ADD CONSTRAINT "AuthTotpFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recovery codes leave with their factor, and the factor with its user.
ALTER TABLE "AuthRecoveryCode" ADD CONSTRAINT "AuthRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthTotpFactor"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthScimToken" ADD CONSTRAINT "AuthScimToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GroupExternalName" ADD CONSTRAINT "GroupExternalName_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
