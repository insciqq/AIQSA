ALTER TYPE "ProviderCredentialSource" ADD VALUE 'user';

CREATE TABLE "ProviderUserCredentialAssignment" (
  "connectionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderUserCredentialAssignment_pkey"
    PRIMARY KEY ("connectionId", "userId")
);

CREATE INDEX "ProviderUserCredentialAssignment_credentialId_idx"
ON "ProviderUserCredentialAssignment"("credentialId");

CREATE INDEX "ProviderUserCredentialAssignment_userId_idx"
ON "ProviderUserCredentialAssignment"("userId");

ALTER TABLE "ProviderUserCredentialAssignment"
  ADD CONSTRAINT "ProviderUserAssignment_credential_fkey"
  FOREIGN KEY ("connectionId", "credentialId")
  REFERENCES "ProviderCredential"("connectionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ProviderUserCredentialAssignment"
  ADD CONSTRAINT "ProviderUserAssignment_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
