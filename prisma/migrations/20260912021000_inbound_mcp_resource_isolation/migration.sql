-- Defaults preserve the previous Memory-only writer and all existing material.
-- resourcePath is the immutable installation-relative audience snapshot;
-- code/family resource and issuer retain their existing exact absolute URL checks.
ALTER TABLE "InboundMcpOAuthGrant"
  ADD COLUMN "resourcePath" VARCHAR(32) NOT NULL DEFAULT '/mcp',
  ADD COLUMN "capability" VARCHAR(32) NOT NULL DEFAULT 'memory:facts',
  ADD CONSTRAINT "InboundMcpOAuthGrant_resource_capability_check"
    CHECK (("resourcePath" = '/mcp' AND "capability" = 'memory:facts')
      OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub'));
ALTER TABLE "InboundMcpOAuthAuthorizationCode"
  ADD COLUMN "resourcePath" VARCHAR(32) NOT NULL DEFAULT '/mcp',
  ADD COLUMN "capability" VARCHAR(32) NOT NULL DEFAULT 'memory:facts',
  ADD CONSTRAINT "InboundMcpOAuthAuthorizationCode_resource_capability_check"
    CHECK (("resourcePath" = '/mcp' AND "capability" = 'memory:facts')
      OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub'));
ALTER TABLE "InboundMcpOAuthTokenFamily"
  ADD COLUMN "resourcePath" VARCHAR(32) NOT NULL DEFAULT '/mcp',
  ADD COLUMN "capability" VARCHAR(32) NOT NULL DEFAULT 'memory:facts',
  ADD CONSTRAINT "InboundMcpOAuthTokenFamily_resource_capability_check"
    CHECK (("resourcePath" = '/mcp' AND "capability" = 'memory:facts')
      OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub'));
ALTER TABLE "InboundMcpOAuthToken"
  ADD COLUMN "resourcePath" VARCHAR(32) NOT NULL DEFAULT '/mcp',
  ADD COLUMN "capability" VARCHAR(32) NOT NULL DEFAULT 'memory:facts',
  ADD CONSTRAINT "InboundMcpOAuthToken_resource_capability_check"
    CHECK (("resourcePath" = '/mcp' AND "capability" = 'memory:facts')
      OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub'));
DROP INDEX "InboundMcpOAuthGrant_userId_oauthClientId_key";
CREATE UNIQUE INDEX "InboundMcpOAuthGrant_userId_oauthClientId_resourcePath_key"
  ON "InboundMcpOAuthGrant" ("userId", "oauthClientId", "resourcePath");

-- Prevent later consent or a raw writer from expanding issued authority.
CREATE FUNCTION "inbound_mcp_immutable_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."resourcePath" IS DISTINCT FROM OLD."resourcePath"
    OR NEW."capability" IS DISTINCT FROM OLD."capability" THEN
    RAISE EXCEPTION 'inbound_mcp_immutable_authority';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "InboundMcpOAuthGrant_immutable_authority"
  BEFORE UPDATE ON "InboundMcpOAuthGrant" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_authority"();
CREATE TRIGGER "InboundMcpOAuthAuthorizationCode_immutable_authority"
  BEFORE UPDATE ON "InboundMcpOAuthAuthorizationCode" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_authority"();
CREATE TRIGGER "InboundMcpOAuthTokenFamily_immutable_authority"
  BEFORE UPDATE ON "InboundMcpOAuthTokenFamily" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_authority"();
CREATE TRIGGER "InboundMcpOAuthToken_immutable_authority"
  BEFORE UPDATE ON "InboundMcpOAuthToken" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_authority"();

CREATE UNIQUE INDEX "InboundMcpOAuthGrant_authority_key"
  ON "InboundMcpOAuthGrant" ("id", "resourcePath", "capability");
CREATE UNIQUE INDEX "InboundMcpOAuthGrant_client_authority_key"
  ON "InboundMcpOAuthGrant" ("id", "oauthClientId", "resourcePath", "capability");
CREATE UNIQUE INDEX "InboundMcpOAuthTokenFamily_authority_key"
  ON "InboundMcpOAuthTokenFamily" ("id", "resourcePath", "capability");
ALTER TABLE "InboundMcpOAuthAuthorizationCode"
  DROP CONSTRAINT "InboundMcpOAuthAuthorizationCode_grantId_oauthClientId_fkey",
  ADD CONSTRAINT "InboundMcpOAuthAuthorizationCode_authority_fkey"
    FOREIGN KEY ("grantId", "oauthClientId", "resourcePath", "capability")
    REFERENCES "InboundMcpOAuthGrant" ("id", "oauthClientId", "resourcePath", "capability") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthTokenFamily"
  DROP CONSTRAINT "InboundMcpOAuthTokenFamily_grantId_fkey",
  ADD CONSTRAINT "InboundMcpOAuthTokenFamily_authority_fkey"
    FOREIGN KEY ("grantId", "resourcePath", "capability")
    REFERENCES "InboundMcpOAuthGrant" ("id", "resourcePath", "capability") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboundMcpOAuthToken"
  DROP CONSTRAINT "InboundMcpOAuthToken_familyId_fkey",
  ADD CONSTRAINT "InboundMcpOAuthToken_authority_fkey"
    FOREIGN KEY ("familyId", "resourcePath", "capability")
    REFERENCES "InboundMcpOAuthTokenFamily" ("id", "resourcePath", "capability") ON DELETE CASCADE ON UPDATE CASCADE;
