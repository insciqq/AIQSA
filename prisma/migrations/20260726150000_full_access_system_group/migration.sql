BEGIN;

CREATE TYPE "GroupSystemRole" AS ENUM ('full_access');

ALTER TABLE "Group"
  ADD COLUMN "systemRole" "GroupSystemRole";

CREATE UNIQUE INDEX "Group_systemRole_key"
  ON "Group"("systemRole");

CREATE OR REPLACE FUNCTION aiqsa_full_access_mcp_grant_id(mcp_server_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_hash TEXT;
  candidate_id TEXT;
  candidate_index INTEGER := 0;
BEGIN
  LOOP
    candidate_hash := md5(
      'aiqsa:full-access-mcp-grant:v1:' || mcp_server_id || ':' || candidate_index::TEXT
    );
    candidate_id :=
      substr(candidate_hash, 1, 8) || '-' ||
      substr(candidate_hash, 9, 4) || '-4' ||
      substr(candidate_hash, 14, 3) || '-8' ||
      substr(candidate_hash, 18, 3) || '-' ||
      substr(candidate_hash, 21, 12);

    IF NOT EXISTS (SELECT 1 FROM "McpGrant" WHERE "id" = candidate_id) THEN
      RETURN candidate_id;
    END IF;

    candidate_index := candidate_index + 1;
  END LOOP;
END;
$$;

-- Existing installations isolate every ordinary spelling of the reserved name
-- before creating the built-in group. An empty migrated database stays empty
-- for installation bootstrap.
DO $$
DECLARE
  candidate_hash TEXT;
  candidate_index INTEGER := 0;
  custom_group_name TEXT;
  custom_name_index INTEGER := 1;
  full_access_group_id TEXT;
  initial_admin_id TEXT;
  name_collision RECORD;
BEGIN
  SELECT "id"
    INTO initial_admin_id
  FROM "User"
  WHERE "role" = 'admin'::"UserRole"
  ORDER BY "createdAt" ASC, "id" ASC
  LIMIT 1;

  IF initial_admin_id IS NULL THEN
    RETURN;
  END IF;

  FOR name_collision IN
    SELECT "id"
    FROM "Group"
    WHERE lower(btrim("name")) = 'full access'
    ORDER BY "createdAt" ASC, "id" ASC
  LOOP
    custom_name_index := 1;
    LOOP
      custom_group_name := CASE
        WHEN custom_name_index = 1 THEN 'Full access (custom)'
        ELSE 'Full access (custom ' || custom_name_index::TEXT || ')'
      END;

      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "Group" WHERE "name" = custom_group_name
      );
      custom_name_index := custom_name_index + 1;
    END LOOP;

    UPDATE "Group"
    SET
      "name" = custom_group_name,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = name_collision."id";
  END LOOP;

  LOOP
    candidate_hash := md5(
      'aiqsa:full-access-system-group:v1:' || candidate_index::TEXT
    );
    full_access_group_id :=
      substr(candidate_hash, 1, 8) || '-' ||
      substr(candidate_hash, 9, 4) || '-4' ||
      substr(candidate_hash, 14, 3) || '-8' ||
      substr(candidate_hash, 18, 3) || '-' ||
      substr(candidate_hash, 21, 12);

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM "Group" WHERE "id" = full_access_group_id
    );
    candidate_index := candidate_index + 1;
  END LOOP;

  INSERT INTO "Group" (
    "id",
    "name",
    "systemRole",
    "createdAt",
    "updatedAt"
  ) VALUES (
    full_access_group_id,
    'Full access',
    'full_access'::"GroupSystemRole",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "UserGroup" (
    "userId",
    "groupId",
    "role",
    "createdAt"
  ) VALUES (
    initial_admin_id,
    full_access_group_id,
    'owner',
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("userId", "groupId")
  DO UPDATE SET "role" = 'owner';

  INSERT INTO "McpGrant" (
    "id",
    "serverId",
    "groupId",
    "canUse",
    "personalSlotKeys",
    "createdAt",
    "updatedAt"
  )
  SELECT
    aiqsa_full_access_mcp_grant_id(server."id"),
    server."id",
    full_access_group_id,
    true,
    ARRAY[]::TEXT[],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM "McpServer" AS server
  ON CONFLICT ("serverId", "groupId")
  DO UPDATE SET
    "canUse" = true,
    "personalSlotKeys" = ARRAY[]::TEXT[],
    "updatedAt" = CURRENT_TIMESTAMP;
END $$;

ALTER TABLE "Group"
  ADD CONSTRAINT "Group_full_access_identity_check"
  CHECK (
    (
      "systemRole" IS NOT NULL
      AND "systemRole" = 'full_access'::"GroupSystemRole"
      AND "name" = 'Full access'
      AND "archivedAt" IS NULL
    )
    OR (
      "systemRole" IS NULL
      AND lower(btrim("name")) <> 'full access'
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_protect_full_access_group()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."systemRole" = 'full_access'::"GroupSystemRole" THEN
      RAISE EXCEPTION 'Full access is a built-in group and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD."systemRole" IS NULL
    AND NEW."systemRole" = 'full_access'::"GroupSystemRole"
  THEN
    RAISE EXCEPTION 'Ordinary groups cannot be promoted to the built-in Full access identity'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."systemRole" = 'full_access'::"GroupSystemRole" THEN
    IF NEW."systemRole" IS DISTINCT FROM 'full_access'::"GroupSystemRole"
      OR NEW."name" IS DISTINCT FROM 'Full access'
      OR NEW."archivedAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'Full access is a built-in group and cannot be renamed or archived'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER aiqsa_protect_full_access_group
BEFORE UPDATE OR DELETE ON "Group"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_protect_full_access_group();

CREATE OR REPLACE FUNCTION aiqsa_grant_full_access_to_new_mcp_server()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  full_access_group_id TEXT;
BEGIN
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
$$;

CREATE TRIGGER aiqsa_grant_full_access_to_new_mcp_server
AFTER INSERT ON "McpServer"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_grant_full_access_to_new_mcp_server();

COMMIT;
