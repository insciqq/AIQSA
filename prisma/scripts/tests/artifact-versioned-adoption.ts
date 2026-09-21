/** Synthetic predecessor rows. The migration contract owns disposable targets. */
export const ARTIFACT_VERSIONED_MIGRATION = "20260921070000_artifact_versioned_publication";
export const artifactVersionedFixtureSql = `
INSERT INTO "User" (id,"displayName",status,"updatedAt") VALUES
 ('versioned-owner','Fixture owner','active',now()),('versioned-other','Fixture other','active',now());
INSERT INTO "Artifact" (id,"ownerUserId",title,kind,"updatedAt") VALUES
 ('versioned-artifact','versioned-owner','Fixture artifact','html',now()),
 ('versioned-other-artifact','versioned-other','Other artifact','html',now());
INSERT INTO "ArtifactVersion" (id,"artifactId","versionNumber",title,kind,"manifest","bundleStorageKey",checksum,"byteSize",status)
VALUES ('versioned-v1','versioned-artifact',1,'One','html','{}','fixture/versioned/v1',repeat('a',64),10,'READY'),
 ('versioned-v3','versioned-artifact',3,'Three','html','{}','fixture/versioned/v3',repeat('b',64),20,'READY'),
 ('versioned-pending','versioned-artifact',4,'Pending','html','{}','fixture/versioned/pending',repeat('c',64),20,'PENDING'),
 ('versioned-foreign','versioned-other-artifact',1,'Foreign','html','{}','fixture/versioned/foreign',repeat('d',64),10,'READY');
INSERT INTO "ArtifactPublication" (id,"ownerUserId","artifactId","artifactVersionId","tokenHash","bundleStorageKey","publicManifest",title,kind,checksum,"byteSize",status,"expiresAt","createdAt")
VALUES ('versioned-legacy','versioned-owner','versioned-artifact','versioned-v1',repeat('e',64),'fixture/versioned/snapshot',
 '{"version":1,"title":"One","kind":"html","entrypoint":null,"files":[]}','One','html',repeat('f',64),10,'READY','2099-01-01','2026-09-20');
`;
export const artifactVersionedProofSql = `
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "ArtifactPublication" WHERE id='versioned-legacy' AND mode='SINGLE' AND revision=1
   AND "defaultVersionId" IS NULL AND "artifactVersionId"='versioned-v1' AND "tokenHash"=repeat('e',64)
   AND "bundleStorageKey"='fixture/versioned/snapshot' AND checksum=repeat('f',64) AND "byteSize"=10
   AND "expiresAt"='2099-01-01' AND "createdAt"='2026-09-20' AND status='READY' AND title='One' AND kind='html'
   AND "publicManifest"='{"version":1,"title":"One","kind":"html","entrypoint":null,"files":[]}'::jsonb) THEN
   RAISE EXCEPTION 'artifact_versioned_legacy_changed'; END IF;
END $$;
-- The prior writer does not know mode/revision/default; its complete snapshot
-- INSERT remains valid with identical expiry and hash semantics.
INSERT INTO "ArtifactPublication" (id,"ownerUserId","artifactId","artifactVersionId","tokenHash","bundleStorageKey","publicManifest",title,kind,checksum,"byteSize",status,"expiresAt")
SELECT 'versioned-old-writer',"ownerUserId","artifactId","artifactVersionId",repeat('1',64),'fixture/versioned/old-writer',"publicManifest",title,kind,checksum,"byteSize",status,"expiresAt"
FROM "ArtifactPublication" WHERE id='versioned-legacy';
BEGIN;
INSERT INTO "ArtifactPublication" (id,"ownerUserId","artifactId",mode,"defaultVersionId","tokenHash",status)
VALUES ('versioned-set','versioned-owner','versioned-artifact','VERSION_SET','versioned-v3',repeat('2',64),'READY');
INSERT INTO "ArtifactPublicationVersion" ("publicationId","artifactId","versionId",position) VALUES
 ('versioned-set','versioned-artifact','versioned-v1',0),('versioned-set','versioned-artifact','versioned-v3',1);
COMMIT;
DO $$ BEGIN
 IF (SELECT mode FROM "ArtifactPublication" WHERE id='versioned-old-writer') <> 'SINGLE'
  OR (SELECT count(*) FROM "ArtifactPublicationVersion" WHERE "publicationId"='versioned-set') <> 2 THEN
  RAISE EXCEPTION 'artifact_versioned_adoption_failed'; END IF;
 BEGIN
  DELETE FROM "ArtifactPublicationVersion" WHERE "publicationId"='versioned-set' AND "versionId"='versioned-v3';
  SET CONSTRAINTS "ArtifactPublication_id_defaultVersionId_fkey" IMMEDIATE;
  RAISE EXCEPTION 'artifact_versioned_missing_default_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ArtifactPublicationVersion" VALUES ('versioned-set','versioned-artifact','versioned-foreign',2);
  SET CONSTRAINTS "ArtifactPublicationVersion_artifactId_versionId_fkey" IMMEDIATE;
  RAISE EXCEPTION 'artifact_versioned_foreign_version_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ArtifactPublicationVersion" VALUES ('versioned-set','versioned-artifact','versioned-pending',2);
  SET CONSTRAINTS "ArtifactPublicationVersion_ready_set_check" IMMEDIATE;
  RAISE EXCEPTION 'artifact_versioned_pending_member_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ArtifactPublicationVersion" VALUES ('versioned-set','versioned-artifact','versioned-pending',100);
  RAISE EXCEPTION 'artifact_versioned_unbounded_position_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ArtifactPublicationVersion" VALUES ('versioned-legacy','versioned-artifact','versioned-v1',0);
  SET CONSTRAINTS "ArtifactPublicationVersion_ready_set_check" IMMEDIATE;
  RAISE EXCEPTION 'artifact_versioned_single_member_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ArtifactPublication" (id,"ownerUserId","artifactId",mode,"defaultVersionId","tokenHash",status)
  VALUES ('versioned-empty','versioned-owner','versioned-artifact','VERSION_SET','versioned-v1',repeat('3',64),'READY');
  SET CONSTRAINTS "ArtifactPublication_id_defaultVersionId_fkey" IMMEDIATE;
  RAISE EXCEPTION 'artifact_versioned_empty_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO "ArtifactPublication" (id,"ownerUserId","artifactId",mode,"defaultVersionId","tokenHash",status)
  VALUES ('versioned-cross-owner','versioned-other','versioned-artifact','VERSION_SET','versioned-v1',repeat('3',64),'READY');
  RAISE EXCEPTION 'artifact_versioned_foreign_owner_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  UPDATE "ArtifactPublication" SET "bundleStorageKey"='fixture/hybrid' WHERE id='versioned-set';
  RAISE EXCEPTION 'artifact_versioned_hybrid_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
-- Reorder replaces membership atomically while the same default remains valid.
BEGIN;
DELETE FROM "ArtifactPublicationVersion" WHERE "publicationId"='versioned-set';
INSERT INTO "ArtifactPublicationVersion" VALUES
 ('versioned-set','versioned-artifact','versioned-v3',0),('versioned-set','versioned-artifact','versioned-v1',1);
COMMIT;
-- Direct artifact deletion and account deletion both cross the default/member
-- cycle. Neither must fail at statement time or at deferred commit validation.
DELETE FROM "Artifact" WHERE id='versioned-artifact';
BEGIN;
INSERT INTO "ArtifactPublication" (id,"ownerUserId","artifactId",mode,"defaultVersionId","tokenHash",status)
VALUES ('versioned-user-cascade','versioned-other','versioned-other-artifact','VERSION_SET','versioned-foreign',repeat('4',64),'READY');
INSERT INTO "ArtifactPublicationVersion" VALUES ('versioned-user-cascade','versioned-other-artifact','versioned-foreign',0);
COMMIT;
DELETE FROM "User" WHERE id IN ('versioned-owner','versioned-other');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "ArtifactPublication" WHERE id LIKE 'versioned-%')
  OR EXISTS(SELECT 1 FROM "ArtifactPublicationVersion" WHERE "publicationId" LIKE 'versioned-%')
  OR EXISTS(SELECT 1 FROM "ArtifactVersion" WHERE id LIKE 'versioned-%')
  OR EXISTS(SELECT 1 FROM "Artifact" WHERE id LIKE 'versioned-%') THEN
  RAISE EXCEPTION 'artifact_versioned_cascade_failed'; END IF;
END $$;
`;
