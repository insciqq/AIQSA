/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const SKILL_IMPORT_SOURCE_MIGRATION = "20260928210000_skill_import_source";
export const skillImportSourceFixtureSql = `
INSERT INTO "User" (id,"displayName",status,"updatedAt") VALUES ('source-owner','Fixture owner','active',now());
INSERT INTO "SkillDefinition" (id,"ownerUserId",version,"updatedAt") VALUES ('source-skill','source-owner',7,now());
INSERT INTO "SkillRevision" (id,"skillId","revisionNumber",name,instructions)
VALUES ('source-revision','source-skill',1,'Fixture','Keep existing instructions');
UPDATE "SkillDefinition" SET "currentRevisionId"='source-revision' WHERE id='source-skill';
`;
export const skillImportSourceProofSql = `
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "SkillDefinition" s JOIN "SkillRevision" r ON r.id=s."currentRevisionId"
   WHERE s.id='source-skill' AND s.version=7 AND s."importSourceJson" IS NULL
   AND r.instructions='Keep existing instructions') THEN
   RAISE EXCEPTION 'skill_source_existing_state_changed';
 END IF;
END $$;
INSERT INTO "SkillDefinition" (id,"ownerUserId","updatedAt") VALUES ('source-old-writer','source-owner',now());
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "SkillDefinition" WHERE id='source-old-writer' AND "importSourceJson" IS NULL) THEN
   RAISE EXCEPTION 'skill_source_old_writer_failed';
 END IF;
END $$;
`;
