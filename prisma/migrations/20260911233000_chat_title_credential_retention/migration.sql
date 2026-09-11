BEGIN;

ALTER TABLE "ChatTitleGeneration" ADD COLUMN "credentialVersionId" TEXT;
ALTER TABLE "ChatTitleGeneration" ADD CONSTRAINT "ChatTitleGeneration_credentialVersionId_fkey"
  FOREIGN KEY ("credentialVersionId") REFERENCES "ProviderCredentialVersion"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "ChatTitleGeneration_credentialVersionId_idx" ON "ChatTitleGeneration"("credentialVersionId");

-- Derive the holding reference from the accepted snapshot, including writes
-- from the previous app during replacement. Terminal transitions release it.
CREATE FUNCTION chat_title_credential_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."credentialVersionId" := NULL;
  IF NEW.status IN ('pending', 'dispatched') THEN
    SELECT version.id INTO NEW."credentialVersionId"
    FROM "ProviderCredentialVersion" version
    WHERE version.id = NEW."providerSnapshot"->>'credentialVersionId'
      AND version."credentialId" = NEW."providerSnapshot"->>'credentialId';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ChatTitleGeneration_credential_reference"
  BEFORE INSERT OR UPDATE OF status, "providerSnapshot", "credentialVersionId"
  ON "ChatTitleGeneration" FOR EACH ROW EXECUTE FUNCTION chat_title_credential_reference();

-- A missing historical key cannot be reconstructed. Such pending jobs retain
-- no authority and are skipped by the worker; dispatched work is never replayed.
UPDATE "ChatTitleGeneration" SET "credentialVersionId" = NULL
WHERE status IN ('pending', 'dispatched');

COMMIT;
