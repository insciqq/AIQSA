/** Synthetic predecessor data only; migration-contract owns disposable targets. */
export const SKILLS_SHARING_MIGRATION = "20260921023000_skill_sharing_approval";

export const skillsSharingFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, role, "updatedAt") VALUES
 ('sharing-owner', 'Fixture owner', 'active', 'user', now()),
 ('sharing-admin', 'Fixture admin', 'active', 'admin', now());
INSERT INTO "Group" (id, name, "updatedAt") VALUES ('sharing-group', 'Fixture group', now());
INSERT INTO "Project" (id, name, "createdByDisplayName", "updatedAt") VALUES ('sharing-project', 'Fixture Project', 'Fixture owner', now());
INSERT INTO "ProjectGrant" (id, "projectId", "userId", role, "updatedAt") VALUES ('sharing-grant', 'sharing-project', 'sharing-owner', 'OWNER', now());
INSERT INTO "SkillDefinition" (id, "ownerUserId", "updatedAt") VALUES
 ('sharing-text', 'sharing-owner', now()), ('sharing-mixed', 'sharing-owner', now()),
 ('sharing-files', 'sharing-owner', now()), ('sharing-admin-files', 'sharing-admin', now()),
 ('sharing-project-only', 'sharing-owner', now()), ('sharing-private', 'sharing-owner', now());
INSERT INTO "SkillRevision" (id, "skillId", "revisionNumber", name, instructions, "fileCount", "bundleReady", "bundleDigest") VALUES
 ('sharing-text-1', 'sharing-text', 1, 'Legacy text', 'First', 0, true, ''),
 ('sharing-text-2', 'sharing-text', 2, 'Legacy text', 'Current', 0, true, ''),
 ('sharing-text-3', 'sharing-text', 3, 'Legacy text', 'Staged', 0, false, ''),
 ('sharing-mixed-1', 'sharing-mixed', 1, 'Mixed', 'First', 0, true, ''),
 ('sharing-mixed-2', 'sharing-mixed', 2, 'Mixed', 'Last text', 0, true, ''),
 ('sharing-mixed-3', 'sharing-mixed', 3, 'Mixed', 'Current files', 1, true, repeat('a',64)),
 ('sharing-mixed-4', 'sharing-mixed', 4, 'Mixed', 'Later staging', 0, false, ''),
 ('sharing-files-1', 'sharing-files', 1, 'Files only', 'Current files', 1, true, repeat('b',64)),
 ('sharing-admin-files-1', 'sharing-admin-files', 1, 'Admin files', 'Current files', 1, true, repeat('c',64)),
 ('sharing-project-only-1', 'sharing-project-only', 1, 'Project', 'Previous text', 0, true, ''),
 ('sharing-project-only-2', 'sharing-project-only', 2, 'Project', 'Current files', 1, true, repeat('d',64)),
 ('sharing-private-1', 'sharing-private', 1, 'Private', 'Private text', 0, true, '');
INSERT INTO "SkillRevisionFile" ("skillId", "revisionId", path, "byteSize", checksum, kind, "textContent")
SELECT "skillId", id, 'references/a.txt', 7, encode(sha256(convert_to('fixture','UTF8')),'hex'), 'text', 'fixture'
FROM "SkillRevision" WHERE id LIKE 'sharing-%' AND "fileCount" = 1;
UPDATE "SkillDefinition" SET "currentRevisionId" = id || CASE
  WHEN id IN ('sharing-text','sharing-project-only') THEN '-2' WHEN id = 'sharing-mixed' THEN '-3' ELSE '-1' END
WHERE id LIKE 'sharing-%';
INSERT INTO "SkillPublication" (id, "skillId", scope, "groupId", "updatedAt")
SELECT id || '-publication', id, 'group', 'sharing-group', now() FROM "SkillDefinition"
WHERE id IN ('sharing-text','sharing-mixed','sharing-files','sharing-admin-files');
INSERT INTO "ProjectSkillBinding" (id, "projectId", "skillId", "addedByUserId")
VALUES ('sharing-project-binding', 'sharing-project', 'sharing-project-only', 'sharing-owner');
COMMIT;
`;

export const skillsSharingProofSql = `
DO $$
BEGIN
  IF (SELECT "sharedRevisionId" FROM "SkillDefinition" WHERE id='sharing-text') IS DISTINCT FROM 'sharing-text-2'
    OR (SELECT "sharedRevisionId" FROM "SkillDefinition" WHERE id='sharing-mixed') IS DISTINCT FROM 'sharing-mixed-2'
    OR (SELECT "sharedRevisionId" FROM "SkillDefinition" WHERE id='sharing-project-only') IS DISTINCT FROM 'sharing-project-only-1' THEN
    RAISE EXCEPTION 'sharing_text_fallback_incorrect';
  END IF;
  IF EXISTS (SELECT 1 FROM "SkillDefinition" WHERE id IN ('sharing-files','sharing-admin-files','sharing-private') AND "sharedRevisionId" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "SkillDefinition" AS d JOIN "SkillRevision" AS r ON r.id=d."sharedRevisionId"
      WHERE d.id LIKE 'sharing-%' AND (r."fileCount" <> 0 OR NOT r."bundleReady")) THEN
    RAISE EXCEPTION 'sharing_migration_approved_files_or_staging';
  END IF;
  IF (SELECT count(*) FROM "SkillShareRequest" WHERE "skillId" LIKE 'sharing-%') <> 4
    OR EXISTS (SELECT 1 FROM "SkillShareRequest" AS q JOIN "SkillDefinition" AS d ON d.id=q."skillId"
      WHERE d.id LIKE 'sharing-%' AND (q.state <> 'pending' OR q."revisionId" <> d."currentRevisionId" OR q."requestedByUserId" <> d."ownerUserId"))
    OR EXISTS (SELECT 1 FROM "SkillDefinition" WHERE id LIKE 'sharing-%' AND version <> 1) THEN
    RAISE EXCEPTION 'sharing_request_backfill_incorrect';
  END IF;
  BEGIN
    INSERT INTO "SkillShareRequest" (id,"skillId","revisionId","requestedByUserId") VALUES ('sharing-duplicate','sharing-mixed','sharing-mixed-3','sharing-owner');
    RAISE EXCEPTION 'sharing_pending_unique_missing';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE "SkillDefinition" SET "sharedRevisionId"='sharing-files-1' WHERE id='sharing-text';
    RAISE EXCEPTION 'sharing_composite_pointer_missing';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO "SkillShareRequest" (id,"skillId","revisionId","requestedByUserId") VALUES ('sharing-foreign','sharing-private','sharing-files-1','sharing-owner');
    RAISE EXCEPTION 'sharing_request_revision_scope_missing';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
-- Previous-release writers omit the new column and request table. Their text
-- edits remain private, and a late grant does not silently approve anything.
INSERT INTO "SkillRevision" (id,"skillId","revisionNumber",name,instructions)
VALUES ('sharing-mixed-5','sharing-mixed',5,'Legacy edit','New private text');
UPDATE "SkillDefinition" SET "currentRevisionId"='sharing-mixed-5',version=version+1 WHERE id='sharing-mixed';
INSERT INTO "SkillPublication" (id,"skillId",scope,"groupId","updatedAt")
VALUES ('sharing-late-grant','sharing-private','group','sharing-group',now());
DO $$ BEGIN
  IF (SELECT "sharedRevisionId" FROM "SkillDefinition" WHERE id='sharing-mixed') IS DISTINCT FROM 'sharing-mixed-2'
    OR (SELECT "sharedRevisionId" FROM "SkillDefinition" WHERE id='sharing-private') IS NOT NULL
    OR EXISTS (SELECT 1 FROM "SkillShareRequest" WHERE "skillId"='sharing-private')
    OR (SELECT "revisionId" FROM "SkillShareRequest" WHERE "skillId"='sharing-mixed' AND state='pending') IS DISTINCT FROM 'sharing-mixed-3' THEN
    RAISE EXCEPTION 'sharing_legacy_writer_changed_approval';
  END IF;
END $$;
`;
