-- Fake QSA is a disposable development fixture, never an installed catalog
-- publication. Preserve the code-owned rows and historical foreign keys while
-- withdrawing any publication created by older installation bootstraps.
UPDATE "ProviderModel"
SET
  "enabled" = FALSE,
  "activeConfig" = NULL,
  "activeVersion" = 0,
  "activatedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "provider" = 'fake'
  OR "connectionId" IN (
    SELECT "id"
    FROM "ProviderConnection"
    WHERE "family" = 'fake'
  );

UPDATE "ProviderConnection"
SET
  "enabled" = FALSE,
  "activeConfig" = NULL,
  "activeVersion" = 0,
  "activatedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "family" = 'fake';
