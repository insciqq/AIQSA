-- Administrators publish several image models with their own parameters; each
-- user may choose one (NULL follows the administrator default). The current
-- image model is published once, as the default, with its saved parameters, so
-- every user keeps following it. The policy version and accepted image plans
-- stay unchanged. Published rows and user choices restrict deletion of their
-- provider model; withdrawal resets the affected choices before the row goes.
--
-- Expand only: "imageParamsJson" stays for previous-release readers during
-- Compose replacement and is no longer written. A previous-release default
-- change to an unpublished model is refused by the new foreign key.
CREATE TABLE "PublishedImageModel" (
    "providerModelId" TEXT NOT NULL,
    "paramsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishedImageModel_pkey" PRIMARY KEY ("providerModelId")
);

ALTER TABLE "UserSettings" ADD COLUMN "imageProviderModelId" TEXT;

CREATE INDEX "UserSettings_imageProviderModelId_idx" ON "UserSettings"("imageProviderModelId");

ALTER TABLE "PublishedImageModel" ADD CONSTRAINT "PublishedImageModel_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "PublishedImageModel" ("providerModelId", "paramsJson", "updatedAt")
SELECT "imageProviderModelId", "imageParamsJson", CURRENT_TIMESTAMP
FROM "SystemModelPolicy"
WHERE "imageProviderModelId" IS NOT NULL
ON CONFLICT ("providerModelId") DO NOTHING;

ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_imagePublication_fkey" FOREIGN KEY ("imageProviderModelId") REFERENCES "PublishedImageModel"("providerModelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_imageProviderModelId_fkey" FOREIGN KEY ("imageProviderModelId") REFERENCES "PublishedImageModel"("providerModelId") ON DELETE RESTRICT ON UPDATE CASCADE;
