/** Synthetic predecessor state; migration-contract owns disposable targets. */
export const CHAT_IMPORT_SOURCE_MIGRATION = "20261005121500_chat_import_source";
export const chatImportSourceFixtureSql = `
INSERT INTO "User" (id,"displayName",status,"updatedAt") VALUES ('import-owner','Fixture owner','active',now());
INSERT INTO "Chat" (id,"userId",title,"updatedAt") VALUES ('import-normal','import-owner','Normal chat',now());
INSERT INTO "Chat" (id,"userId",title,"memoryMode","updatedAt") VALUES ('import-excluded','import-owner','Excluded chat','EXCLUDED',now());
`;
export const chatImportSourceProofSql = `
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "Chat" WHERE id IN ('import-normal','import-excluded')
     AND num_nonnulls("importSource","importSourceKey","importSourceModel") <> 0)
   OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id='import-normal' AND "memoryMode"='NORMAL')
   OR NOT EXISTS (SELECT 1 FROM "Chat" WHERE id='import-excluded' AND "memoryMode"='EXCLUDED') THEN
   RAISE EXCEPTION 'chat_import_existing_state_changed';
 END IF;
END $$;
UPDATE "Chat" SET "memoryMode"='EXCLUDED' WHERE id='import-normal';
UPDATE "Chat" SET "memoryMode"='NORMAL' WHERE id='import-excluded';
INSERT INTO "Chat" (id,"userId",title,"updatedAt") VALUES ('import-old-writer','import-owner','Old writer',now());
INSERT INTO "Chat" (id,"userId",title,"memoryMode","importSource","importSourceKey","updatedAt")
VALUES ('import-new','import-owner','Imported','EXCLUDED','CHATGPT',repeat('c',64),now());
DO $$ BEGIN
 BEGIN
   UPDATE "Chat" SET "memoryMode"='NORMAL' WHERE id='import-new';
   RAISE EXCEPTION 'chat_import_resume_allowed';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
   INSERT INTO "Chat" (id,"userId",title,"memoryMode","importSource","importSourceKey","updatedAt")
   VALUES ('import-duplicate','import-owner','Duplicate','EXCLUDED','CHATGPT',repeat('c',64),now());
   RAISE EXCEPTION 'chat_import_duplicate_allowed';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 IF NOT EXISTS (SELECT 1 FROM "Chat" WHERE id='import-old-writer' AND "importSource" IS NULL AND "memoryMode"='NORMAL') THEN
   RAISE EXCEPTION 'chat_import_old_writer_failed';
 END IF;
END $$;
`;
