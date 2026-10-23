/** Disposable predecessor fixtures for retiring Projects (operator decision 2026-10-23).
 * The migration contract owns database creation and cleanup. */
export const RETIRE_PROJECTS_MIGRATION = "20261023210000_retire_projects";

// What the previous release leaves: active and archived Projects with a sole
// Owner, a Project chat with a live public share beside a personal one, and
// SCIM deactivations that waited for an ownership transfer.
export const retireProjectsFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", role, status, "scimDeactivatedAt", "updatedAt") VALUES
  ('retire-owner', 'Synthetic owner', 'user', 'active', NULL, now()),
  ('retire-pending', 'Synthetic pending member', 'user', 'active', now(), now()),
  ('retire-pending-admin', 'Synthetic pending admin', 'admin', 'active', now(), now()),
  ('retire-admin', 'Synthetic admin', 'admin', 'active', NULL, now()),
  ('retire-disabled', 'Synthetic disabled member', 'user', 'disabled', now(), now());
INSERT INTO "Project" (id, name, "createdByDisplayName", "updatedAt") VALUES
  ('retire-active', 'Synthetic Project', 'Synthetic owner', now());
INSERT INTO "Project" (id, name, "createdByDisplayName", status, "archivedAt", "updatedAt") VALUES
  ('retire-archived', 'Synthetic archive', 'Synthetic owner', 'ARCHIVED', now(), now());
INSERT INTO "ProjectGrant" (id, "projectId", "userId", role, "updatedAt") VALUES
  ('retire-grant-active', 'retire-active', 'retire-pending', 'OWNER', now()),
  ('retire-grant-archived', 'retire-archived', 'retire-owner', 'OWNER', now());
INSERT INTO "Chat" (id, "userId", "projectId", "createdByUserId", "createdByDisplayName", title, "memoryMode", "updatedAt") VALUES
  ('retire-project-chat', NULL, 'retire-active', 'retire-pending', 'Synthetic pending member', 'Synthetic Project chat', 'EXCLUDED', now()),
  ('retire-personal-chat', 'retire-owner', NULL, NULL, '', 'Synthetic personal chat', 'NORMAL', now());
INSERT INTO "SharedChatSnapshot" (id, "projectId", "ownerUserId", "createdByDisplayName", "chatId", "slugHash", title, snapshot) VALUES
  ('retire-project-share', 'retire-active', NULL, 'Synthetic pending member', 'retire-project-chat', repeat('a', 64), 'Synthetic', '{}'),
  ('retire-personal-share', NULL, 'retire-owner', NULL, 'retire-personal-chat', repeat('b', 64), 'Synthetic', '{}');
COMMIT;
`;

// Every Project is fenced for deletion, its chats' shares are revoked, the
// owner triggers are gone, and the waiting SCIM deactivations completed;
// nothing personal changed. Repeating the deploy changes nothing more.
export const retireProjectsProofSql = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN
      ('Project_owner_required', 'ProjectGrant_owner_required', 'User_project_owner_required'))
    OR to_regprocedure('aiqsa_assert_project_active_owner(text)') IS NOT NULL
    OR to_regprocedure('aiqsa_project_owner_constraint_trigger()') IS NOT NULL
    THEN RAISE EXCEPTION 'retire_projects_owner_triggers_survived'; END IF;
  IF EXISTS (SELECT 1 FROM "Project" WHERE status <> 'DELETING' OR "deletionRequestedAt" IS NULL)
    OR NOT EXISTS (SELECT 1 FROM "Project" WHERE id = 'retire-archived' AND "archivedAt" IS NOT NULL)
    OR (SELECT count(*) FROM "Project" WHERE id IN ('retire-active', 'retire-archived')) <> 2
    THEN RAISE EXCEPTION 'retire_projects_not_fenced'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "SharedChatSnapshot" WHERE id = 'retire-project-share' AND "revokedAt" IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM "SharedChatSnapshot" WHERE id = 'retire-personal-share' AND "revokedAt" IS NULL)
    THEN RAISE EXCEPTION 'retire_projects_shares_wrong'; END IF;
  IF (SELECT jsonb_object_agg(id, status::text) FROM "User" WHERE id LIKE 'retire-%') IS DISTINCT FROM jsonb_build_object(
      'retire-owner', 'active', 'retire-pending', 'disabled', 'retire-pending-admin', 'disabled',
      'retire-admin', 'active', 'retire-disabled', 'disabled')
    THEN RAISE EXCEPTION 'retire_projects_scim_deactivations_wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'retire-personal-chat' AND "userId" = 'retire-owner')
    OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id = 'retire-project-chat')
    THEN RAISE EXCEPTION 'retire_projects_deleted_rows_itself'; END IF;
END $$;
BEGIN;
-- Disabling a former sole Owner no longer waits for anything.
UPDATE "User" SET status = 'disabled' WHERE id = 'retire-owner';
ROLLBACK;
`;
