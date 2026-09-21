-- Check after the statement's cascades, so deleting an owner can remove both
-- the version references and their blobs. Direct deletion of a referenced blob
-- remains forbidden; this constraint is not deferred across transactions.
ALTER TABLE "ArtifactVersionBlob"
  DROP CONSTRAINT "ArtifactVersionBlob_blobId_fkey",
  ADD CONSTRAINT "ArtifactVersionBlob_blobId_fkey"
    FOREIGN KEY ("blobId") REFERENCES "ArtifactBlob"("id")
    ON DELETE NO ACTION ON UPDATE RESTRICT;
