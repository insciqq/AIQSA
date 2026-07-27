-- Preserve the original category of historical rows whose actor was already
-- erased by ON DELETE SET NULL without inventing a user identity.
UPDATE "AuthSession"
SET "revokedReason" = 'system_legacy_unattributed_' || "revokedReason"
WHERE "revokedAt" IS NOT NULL
  AND "revokedByUserId" IS NULL
  AND "revokedReason" IN ('admin_revoke_user', 'admin_revoke_all');

UPDATE "AuthSession"
SET "revokedReason" = 'system_legacy_unattributed'
WHERE "revokedAt" IS NOT NULL
  AND ("revokedReason" IS NULL OR btrim("revokedReason") = '');

UPDATE "AuthSession"
SET
  "revokedByUserId" = NULL,
  "revokedReason" = NULL
WHERE "revokedAt" IS NULL;

ALTER TABLE "AuthSession"
DROP CONSTRAINT "AuthSession_revokedByUserId_fkey";

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_revokedByUserId_fkey"
FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_revocation_attribution_check"
CHECK (
  (
    "revokedAt" IS NULL
    AND "revokedByUserId" IS NULL
    AND "revokedReason" IS NULL
  )
  OR
  (
    "revokedAt" IS NOT NULL
    AND "revokedReason" IS NOT NULL
    AND btrim("revokedReason") <> ''
    AND (
      "revokedReason" NOT IN ('admin_revoke_user', 'admin_revoke_all')
      OR "revokedByUserId" IS NOT NULL
    )
  )
);
