-- Inbound Personal Memory MCP authorization is intentionally separate from
-- the outbound MCP OAuth client owned by AIQSA runs. Only hashes of issued
-- codes and tokens are persisted.
CREATE TYPE "InboundMcpOAuthApplicationType" AS ENUM ('NATIVE', 'WEB');
CREATE TYPE "InboundMcpOAuthClientKind" AS ENUM ('CLIENT_ID_METADATA_DOCUMENT', 'DYNAMIC_REGISTRATION');
CREATE TYPE "InboundMcpOAuthGrantState" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "InboundMcpOAuthTokenKind" AS ENUM ('ACCESS', 'REFRESH');

CREATE TABLE "InboundMcpOAuthClient" (
  "id" TEXT NOT NULL,
  "clientId" VARCHAR(2048) NOT NULL,
  "clientName" VARCHAR(200) NOT NULL,
  "clientOrigin" VARCHAR(2048) NOT NULL,
  "clientUri" VARCHAR(2048),
  "redirectUris" TEXT[] NOT NULL,
  "applicationType" "InboundMcpOAuthApplicationType" NOT NULL,
  "kind" "InboundMcpOAuthClientKind" NOT NULL,
  "metadataFingerprint" VARCHAR(64) NOT NULL,
  "metadataExpiresAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InboundMcpOAuthClient_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundMcpOAuthClient_client_id_check" CHECK (
    length("clientId") BETWEEN 1 AND 2048
    AND "clientId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "InboundMcpOAuthClient_client_name_check" CHECK (
    length(btrim("clientName")) BETWEEN 1 AND 200
    AND "clientName" = btrim("clientName")
    AND "clientName" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "InboundMcpOAuthClient_client_origin_check" CHECK (
    length("clientOrigin") BETWEEN 1 AND 2048
    AND "clientOrigin" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "InboundMcpOAuthClient_client_uri_check" CHECK (
    "clientUri" IS NULL OR (
      length("clientUri") BETWEEN 1 AND 2048
      AND "clientUri" !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT "InboundMcpOAuthClient_redirect_uris_check" CHECK (
    cardinality("redirectUris") BETWEEN 1 AND 10
  ),
  CONSTRAINT "InboundMcpOAuthClient_metadata_fingerprint_check" CHECK (
    "metadataFingerprint" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "InboundMcpOAuthGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "oauthClientId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "state" "InboundMcpOAuthGrantState" NOT NULL DEFAULT 'ACTIVE',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InboundMcpOAuthGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundMcpOAuthGrant_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "InboundMcpOAuthGrant_state_check" CHECK (
    ("state" = 'ACTIVE' AND "revokedAt" IS NULL)
    OR ("state" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "InboundMcpOAuthAuthorizationCode" (
  "id" TEXT NOT NULL,
  "codeHash" VARCHAR(64) NOT NULL,
  "grantId" TEXT NOT NULL,
  "oauthClientId" TEXT NOT NULL,
  "grantRevision" INTEGER NOT NULL,
  "redirectUri" VARCHAR(2048) NOT NULL,
  "codeChallenge" VARCHAR(43) NOT NULL,
  "issuer" VARCHAR(2048) NOT NULL,
  "resource" VARCHAR(2048) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InboundMcpOAuthAuthorizationCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundMcpOAuthAuthorizationCode_hash_check" CHECK (
    "codeHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "InboundMcpOAuthAuthorizationCode_challenge_check" CHECK (
    "codeChallenge" ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT "InboundMcpOAuthAuthorizationCode_revision_check" CHECK (
    "grantRevision" > 0
  ),
  CONSTRAINT "InboundMcpOAuthAuthorizationCode_expiry_check" CHECK (
    "expiresAt" > "createdAt"
  )
);

CREATE TABLE "InboundMcpOAuthTokenFamily" (
  "id" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "grantRevision" INTEGER NOT NULL,
  "issuer" VARCHAR(2048) NOT NULL,
  "resource" VARCHAR(2048) NOT NULL,
  "inactivityExpiresAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revocationReason" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InboundMcpOAuthTokenFamily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundMcpOAuthTokenFamily_revision_check" CHECK (
    "grantRevision" > 0
  ),
  CONSTRAINT "InboundMcpOAuthTokenFamily_expiry_check" CHECK (
    "inactivityExpiresAt" > "createdAt"
  ),
  CONSTRAINT "InboundMcpOAuthTokenFamily_revocation_check" CHECK (
    ("revokedAt" IS NULL AND "revocationReason" IS NULL)
    OR ("revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL)
  )
);

CREATE TABLE "InboundMcpOAuthToken" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "kind" "InboundMcpOAuthTokenKind" NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InboundMcpOAuthToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundMcpOAuthToken_hash_check" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "InboundMcpOAuthToken_expiry_check" CHECK (
    "expiresAt" > "createdAt"
  ),
  CONSTRAINT "InboundMcpOAuthToken_consumption_check" CHECK (
    "kind" = 'REFRESH' OR "consumedAt" IS NULL
  )
);

CREATE UNIQUE INDEX "InboundMcpOAuthClient_clientId_key"
  ON "InboundMcpOAuthClient"("clientId");
CREATE INDEX "InboundMcpOAuthClient_kind_lastUsedAt_createdAt_idx"
  ON "InboundMcpOAuthClient"("kind", "lastUsedAt", "createdAt");
CREATE INDEX "InboundMcpOAuthClient_metadataExpiresAt_idx"
  ON "InboundMcpOAuthClient"("metadataExpiresAt");

CREATE UNIQUE INDEX "InboundMcpOAuthGrant_id_oauthClientId_key"
  ON "InboundMcpOAuthGrant"("id", "oauthClientId");
CREATE UNIQUE INDEX "InboundMcpOAuthGrant_userId_oauthClientId_key"
  ON "InboundMcpOAuthGrant"("userId", "oauthClientId");
CREATE INDEX "InboundMcpOAuthGrant_oauthClientId_state_idx"
  ON "InboundMcpOAuthGrant"("oauthClientId", "state");
CREATE INDEX "InboundMcpOAuthGrant_userId_state_updatedAt_idx"
  ON "InboundMcpOAuthGrant"("userId", "state", "updatedAt");

CREATE UNIQUE INDEX "InboundMcpOAuthAuthorizationCode_codeHash_key"
  ON "InboundMcpOAuthAuthorizationCode"("codeHash");
CREATE INDEX "InboundMcpOAuthAuthorizationCode_expiresAt_consumedAt_idx"
  ON "InboundMcpOAuthAuthorizationCode"("expiresAt", "consumedAt");
CREATE INDEX "InboundMcpOAuthAuthorizationCode_grantId_grantRevision_idx"
  ON "InboundMcpOAuthAuthorizationCode"("grantId", "grantRevision");
CREATE INDEX "InboundMcpOAuthAuthorizationCode_oauthClientId_idx"
  ON "InboundMcpOAuthAuthorizationCode"("oauthClientId");

CREATE INDEX "InboundMcpOAuthTokenFamily_grantId_grantRevision_revokedAt_idx"
  ON "InboundMcpOAuthTokenFamily"("grantId", "grantRevision", "revokedAt");
CREATE INDEX "InboundMcpOAuthTokenFamily_inactivityExpiresAt_revokedAt_idx"
  ON "InboundMcpOAuthTokenFamily"("inactivityExpiresAt", "revokedAt");

CREATE UNIQUE INDEX "InboundMcpOAuthToken_tokenHash_key"
  ON "InboundMcpOAuthToken"("tokenHash");
CREATE INDEX "InboundMcpOAuthToken_expiresAt_kind_consumedAt_idx"
  ON "InboundMcpOAuthToken"("expiresAt", "kind", "consumedAt");
CREATE INDEX "InboundMcpOAuthToken_familyId_kind_consumedAt_idx"
  ON "InboundMcpOAuthToken"("familyId", "kind", "consumedAt");

ALTER TABLE "InboundMcpOAuthGrant"
  ADD CONSTRAINT "InboundMcpOAuthGrant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthGrant"
  ADD CONSTRAINT "InboundMcpOAuthGrant_oauthClientId_fkey"
  FOREIGN KEY ("oauthClientId") REFERENCES "InboundMcpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthAuthorizationCode"
  ADD CONSTRAINT "InboundMcpOAuthAuthorizationCode_oauthClientId_fkey"
  FOREIGN KEY ("oauthClientId") REFERENCES "InboundMcpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthAuthorizationCode"
  ADD CONSTRAINT "InboundMcpOAuthAuthorizationCode_grantId_oauthClientId_fkey"
  FOREIGN KEY ("grantId", "oauthClientId") REFERENCES "InboundMcpOAuthGrant"("id", "oauthClientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthTokenFamily"
  ADD CONSTRAINT "InboundMcpOAuthTokenFamily_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "InboundMcpOAuthGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthToken"
  ADD CONSTRAINT "InboundMcpOAuthToken_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "InboundMcpOAuthTokenFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;
