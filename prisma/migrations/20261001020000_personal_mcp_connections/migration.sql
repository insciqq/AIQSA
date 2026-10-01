-- Personal remote MCP ownership and per-user tool switch-offs.
ALTER TABLE "McpServer" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "McpUserServer" ADD COLUMN "userDisabledToolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
  CONSTRAINT "McpUserServer_userDisabledToolNames_check" CHECK (cardinality("userDisabledToolNames") <= 1024);
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredInventory" JSONB;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredRevisionId" TEXT;
ALTER TABLE "McpUserServer" ADD COLUMN "discoveredOAuthConnectionId" TEXT;

CREATE INDEX "McpServer_ownerUserId_enabled_archivedAt_idx"
  ON "McpServer"("ownerUserId", "enabled", "archivedAt");

ALTER TABLE "McpServer"
  ADD CONSTRAINT "McpServer_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- personal-mcp-db-integrity
-- A personal server belongs to exactly one owner, enforced in the database:
-- the Full access group gets no grant on it, its preferences, OAuth
-- connections and grants name only that owner, installation-only children
-- never reference it, and its owner never changes after insert.
CREATE OR REPLACE FUNCTION public.aiqsa_grant_full_access_to_new_mcp_server()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  full_access_group_id TEXT;
BEGIN
  -- Full access covers installation MCP only; personal servers stay private.
  IF NEW."ownerUserId" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT "id"
    INTO full_access_group_id
  FROM "Group"
  WHERE "systemRole" = 'full_access'::"GroupSystemRole";

  IF full_access_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "McpGrant" (
    "id",
    "serverId",
    "groupId",
    "canUse",
    "personalSlotKeys",
    "createdAt",
    "updatedAt"
  ) VALUES (
    aiqsa_full_access_mcp_grant_id(NEW."id"),
    NEW."id",
    full_access_group_id,
    true,
    ARRAY[]::TEXT[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("serverId", "groupId")
  DO UPDATE SET
    "canUse" = true,
    "personalSlotKeys" = ARRAY[]::TEXT[],
    "updatedAt" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$function$;

-- Guard: a personal server keeps only its owner's direct grant.
DELETE FROM "McpGrant" AS grant_row
USING "McpServer" AS server_row
WHERE server_row."id" = grant_row."serverId"
  AND server_row."ownerUserId" IS NOT NULL
  AND (grant_row."groupId" IS NOT NULL OR grant_row."userId" IS DISTINCT FROM server_row."ownerUserId");

CREATE OR REPLACE FUNCTION aiqsa_mcp_personal_boundary_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  violation BOOLEAN := false;
BEGIN
  -- Deferred to commit: judge each row as committed, never a superseded NEW.
  IF TG_TABLE_NAME = 'McpUserServer' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpUserServer" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND child."userId" <> server_row."ownerUserId"
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpOAuthConnection' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpOAuthConnection" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND child."userId" <> server_row."ownerUserId"
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpGrant' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpGrant" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND server_row."ownerUserId" IS NOT NULL
        AND (child."groupId" IS NOT NULL OR child."userId" IS DISTINCT FROM server_row."ownerUserId")
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'ProjectMcpBinding' THEN
    SELECT EXISTS (
      SELECT 1 FROM "ProjectMcpBinding" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."projectId" = NEW."projectId" AND child."serverId" = NEW."serverId"
        AND server_row."ownerUserId" IS NOT NULL
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpSharedRuntime' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpSharedRuntime" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."serverId" = NEW."serverId" AND server_row."ownerUserId" IS NOT NULL
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpToolAccessPolicy' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpToolAccessPolicy" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND server_row."ownerUserId" IS NOT NULL
    ) INTO violation;
  ELSIF TG_TABLE_NAME = 'McpActivationJob' THEN
    SELECT EXISTS (
      SELECT 1 FROM "McpActivationJob" AS child
      JOIN "McpServer" AS server_row ON server_row."id" = child."serverId"
      WHERE child."id" = NEW."id" AND server_row."ownerUserId" IS NOT NULL
    ) INTO violation;
  END IF;
  IF violation THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = TG_TABLE_NAME || ' crosses the personal MCP owner boundary';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "McpUserServer_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId", "userId" ON "McpUserServer" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();
CREATE CONSTRAINT TRIGGER "McpOAuthConnection_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId", "userId" ON "McpOAuthConnection" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();
CREATE CONSTRAINT TRIGGER "McpGrant_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId", "userId", "groupId" ON "McpGrant" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();
CREATE CONSTRAINT TRIGGER "ProjectMcpBinding_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId" ON "ProjectMcpBinding" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();
CREATE CONSTRAINT TRIGGER "McpSharedRuntime_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId" ON "McpSharedRuntime" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();
CREATE CONSTRAINT TRIGGER "McpToolAccessPolicy_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId" ON "McpToolAccessPolicy" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();
CREATE CONSTRAINT TRIGGER "McpActivationJob_personal_owner_boundary"
AFTER INSERT OR UPDATE OF "serverId" ON "McpActivationJob" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_personal_boundary_trigger();

CREATE OR REPLACE FUNCTION aiqsa_mcp_server_owner_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  -- Only the owner FK's ON UPDATE CASCADE may follow a changed User id; the
  -- previous owner id then no longer exists.
  IF NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" AND (
    OLD."ownerUserId" IS NULL OR NEW."ownerUserId" IS NULL OR
    EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."ownerUserId")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'McpServer ownership is immutable';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "McpServer_owner_immutable" BEFORE UPDATE OF "ownerUserId" ON "McpServer"
FOR EACH ROW EXECUTE FUNCTION aiqsa_mcp_server_owner_immutable_guard();

CREATE INDEX "McpUserServer_discoveredRevisionId_idx" ON "McpUserServer"("discoveredRevisionId");
CREATE INDEX "McpUserServer_discoveredOAuthConnectionId_idx" ON "McpUserServer"("discoveredOAuthConnectionId");

ALTER TABLE "McpUserServer"
  ADD CONSTRAINT "McpUserServer_discoveredRevisionId_fkey"
  FOREIGN KEY ("discoveredRevisionId") REFERENCES "McpRevision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "McpUserServer"
  ADD CONSTRAINT "McpUserServer_discoveredOAuthConnectionId_fkey"
  FOREIGN KEY ("discoveredOAuthConnectionId") REFERENCES "McpOAuthConnection"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
