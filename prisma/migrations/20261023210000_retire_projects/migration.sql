-- Projects were removed together with their data (operator decision
-- 2026-10-23). Nothing creates or opens Projects any more; this migration
-- ends what Projects still held back and fences the rest for deletion.
-- Workspace maintenance then finalizes every fenced Project through the
-- Project deletion path (`lib/server/projects/deletion.ts`), which removes
-- their Workspace VMs, queues their stored objects for deletion and lets the
-- chats, messages, runs, shares and memberships cascade. The tables stay
-- until the next release drops them. Every statement is idempotent and a
-- previous-release writer still running during the upgrade only sees
-- Projects that are being deleted.

-- The sole-owner offboarding block ends: disabling, deactivating or deleting
-- an account no longer waits for a Project ownership transfer.
DROP TRIGGER IF EXISTS "Project_owner_required" ON "Project";
DROP TRIGGER IF EXISTS "ProjectGrant_owner_required" ON "ProjectGrant";
DROP TRIGGER IF EXISTS "User_project_owner_required" ON "User";
DROP FUNCTION IF EXISTS aiqsa_project_owner_constraint_trigger();
DROP FUNCTION IF EXISTS aiqsa_assert_project_active_owner(TEXT);

-- Every remaining Project is fenced for deletion, as its Owner's delete
-- would have done.
UPDATE "Project"
SET "status" = 'DELETING',
    "deletionRequestedAt" = COALESCE("deletionRequestedAt", CURRENT_TIMESTAMP)
WHERE "status" <> 'DELETING';

-- Public shares of Project chats stop working now, before their rows go.
UPDATE "SharedChatSnapshot"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "projectId" IS NOT NULL AND "revokedAt" IS NULL;

-- A SCIM deactivation that waited for a Project ownership transfer
-- completes. Its sessions, inbound MCP grants, devices and Telegram links
-- were revoked when it was recorded, and sign-in has refused the account
-- since. An administrator stays active, as SCIM deactivation leaves one,
-- unless another administrator can still sign in.
UPDATE "User" AS pending
SET "status" = 'disabled', "updatedAt" = CURRENT_TIMESTAMP
WHERE pending."status" = 'active'
  AND pending."scimDeactivatedAt" IS NOT NULL
  AND (pending."role" <> 'admin' OR EXISTS (
    SELECT 1 FROM "User" AS other
    WHERE other."id" <> pending."id"
      AND other."role" = 'admin'
      AND other."status" = 'active'
      AND other."scimDeactivatedAt" IS NULL
  ));

-- The shared MCP runtimes served only Project chats; their runtime
-- generations go with them and run bindings keep their fingerprints.
DELETE FROM "McpSharedRuntime";
