-- Owner deletion reaches blobs after one cascade and version references after
-- three. PostgreSQL checks an immediate NO ACTION FK during the nested delete,
-- before the deeper cascade completes. Check the reference at commit instead;
-- deleting a blob while any surviving version references it still rolls back.
ALTER TABLE "ArtifactVersionBlob"
  ALTER CONSTRAINT "ArtifactVersionBlob_blobId_fkey"
  DEFERRABLE INITIALLY DEFERRED;
