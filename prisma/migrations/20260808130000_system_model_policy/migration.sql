-- Internal utility work uses one exact administrator-selected answer model.
-- The row starts empty and never changes existing model or chat defaults.

CREATE TABLE "SystemModelPolicy" (
  "id" TEXT NOT NULL,
  "providerModelId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SystemModelPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SystemModelPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "SystemModelPolicy_version_check" CHECK ("version" >= 1)
);

INSERT INTO "SystemModelPolicy" ("id", "providerModelId")
VALUES ('installation', NULL);

CREATE INDEX "SystemModelPolicy_providerModelId_idx"
ON "SystemModelPolicy"("providerModelId");

CREATE INDEX "SystemModelPolicy_updatedByUserId_idx"
ON "SystemModelPolicy"("updatedByUserId");

ALTER TABLE "SystemModelPolicy"
ADD CONSTRAINT "SystemModelPolicy_providerModelId_fkey"
FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SystemModelPolicy"
ADD CONSTRAINT "SystemModelPolicy_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
