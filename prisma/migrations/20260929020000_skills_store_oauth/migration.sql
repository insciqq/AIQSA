-- New private Skills authority is isolated from every previously issued grant.
-- Empty scope defaults preserve previous-release Memory/Hub writers.
-- Prisma models lists as nullable SQL arrays; the resource check enforces non-null scopes.
ALTER TABLE "InboundMcpOAuthGrant"
  ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  DROP CONSTRAINT "InboundMcpOAuthGrant_resource_capability_check",
  ADD CONSTRAINT "InboundMcpOAuthGrant_resource_capability_check" CHECK ("scopes" IS NOT NULL AND (
    ("resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/skills' AND "capability" = 'skills:store'
      AND "scopes" IN (ARRAY['skills:read']::TEXT[], ARRAY['skills:read','skills:write']::TEXT[]))
  ));
ALTER TABLE "InboundMcpOAuthAuthorizationCode"
  ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  DROP CONSTRAINT "InboundMcpOAuthAuthorizationCode_resource_capability_check",
  ADD CONSTRAINT "InboundMcpOAuthAuthorizationCode_resource_capability_check" CHECK ("scopes" IS NOT NULL AND (
    ("resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/skills' AND "capability" = 'skills:store'
      AND "scopes" IN (ARRAY['skills:read']::TEXT[], ARRAY['skills:read','skills:write']::TEXT[]))
  ));
ALTER TABLE "InboundMcpOAuthTokenFamily"
  ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  DROP CONSTRAINT "InboundMcpOAuthTokenFamily_resource_capability_check",
  ADD CONSTRAINT "InboundMcpOAuthTokenFamily_resource_capability_check" CHECK ("scopes" IS NOT NULL AND (
    ("resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/skills' AND "capability" = 'skills:store'
      AND "scopes" IN (ARRAY['skills:read']::TEXT[], ARRAY['skills:read','skills:write']::TEXT[]))
  ));
ALTER TABLE "InboundMcpOAuthToken"
  ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  DROP CONSTRAINT "InboundMcpOAuthToken_resource_capability_check",
  ADD CONSTRAINT "InboundMcpOAuthToken_resource_capability_check" CHECK ("scopes" IS NOT NULL AND (
    ("resourcePath" = '/mcp' AND "capability" = 'memory:facts' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/hub' AND "capability" = 'mcp:hub' AND "scopes" = ARRAY[]::TEXT[])
    OR ("resourcePath" = '/mcp/skills' AND "capability" = 'skills:store'
      AND "scopes" IN (ARRAY['skills:read']::TEXT[], ARRAY['skills:read','skills:write']::TEXT[]))
  ));

-- Scope snapshots cannot acquire rights after issuance. Grant changes require a new revision,
-- which invalidates all earlier code/family/token authority without rewriting it.
CREATE FUNCTION "inbound_mcp_immutable_scopes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scopes" IS DISTINCT FROM OLD."scopes" THEN
    IF TG_TABLE_NAME <> 'InboundMcpOAuthGrant' THEN
      RAISE EXCEPTION 'inbound_mcp_immutable_scopes';
    ELSIF NEW."revision" <= OLD."revision" THEN
      RAISE EXCEPTION 'inbound_mcp_scope_revision_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "InboundMcpOAuthGrant_immutable_scopes"
  BEFORE UPDATE ON "InboundMcpOAuthGrant" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_scopes"();
CREATE TRIGGER "InboundMcpOAuthAuthorizationCode_immutable_scopes"
  BEFORE UPDATE ON "InboundMcpOAuthAuthorizationCode" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_scopes"();
CREATE TRIGGER "InboundMcpOAuthTokenFamily_immutable_scopes"
  BEFORE UPDATE ON "InboundMcpOAuthTokenFamily" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_scopes"();
CREATE TRIGGER "InboundMcpOAuthToken_immutable_scopes"
  BEFORE UPDATE ON "InboundMcpOAuthToken" FOR EACH ROW
  EXECUTE FUNCTION "inbound_mcp_immutable_scopes"();

CREATE TABLE "SkillStoreOperation" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "clientId" VARCHAR(2048) NOT NULL,
  "operationKey" VARCHAR(128) NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'STAGED',
  "skillId" TEXT,
  "revisionId" TEXT,
  "expectedVersion" INTEGER,
  "expectedCurrentRevisionId" TEXT,
  "resultJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SkillStoreOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SkillStoreOperation_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SkillStoreOperation_ownerUserId_clientId_operationKey_key" ON "SkillStoreOperation"("ownerUserId", "clientId", "operationKey");
CREATE INDEX "SkillStoreOperation_status_createdAt_idx" ON "SkillStoreOperation"("status", "createdAt");
