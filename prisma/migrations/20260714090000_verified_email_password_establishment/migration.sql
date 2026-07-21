-- Legacy registration stored a caller-selected password before email proof.
-- Invalidate every outstanding legacy verification link before clearing those unsafe hashes.
BEGIN;

UPDATE "AuthFlowToken" AS token
SET
  "consumedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "AuthIdentity" AS identity
WHERE token."identityId" = identity."id"
  AND token."purpose" = 'email_verification'
  AND token."consumedAt" IS NULL
  AND identity."provider" = 'password'
  AND identity."emailVerifiedAt" IS NULL;

UPDATE "AuthIdentity"
SET
  "passwordHash" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'password'
  AND "emailVerifiedAt" IS NULL
  AND "passwordHash" IS NOT NULL;

COMMIT;
