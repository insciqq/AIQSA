-- Installation model defaults are recommendations, separate from nullable
-- per-user preferences and independent persisted chat selections. Existing
-- user/chat values remain untouched; the new installation policy starts empty.

CREATE TABLE "ModelPolicy" (
  "id" TEXT NOT NULL,
  "defaultProviderModelId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModelPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModelPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "ModelPolicy_version_check" CHECK ("version" >= 1)
);

INSERT INTO "ModelPolicy" ("id", "defaultProviderModelId")
VALUES ('installation', NULL);

CREATE INDEX "ModelPolicy_defaultProviderModelId_idx"
ON "ModelPolicy"("defaultProviderModelId");

CREATE INDEX "ModelPolicy_updatedByUserId_idx"
ON "ModelPolicy"("updatedByUserId");

ALTER TABLE "ModelPolicy"
ADD CONSTRAINT "ModelPolicy_defaultProviderModelId_fkey"
FOREIGN KEY ("defaultProviderModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModelPolicy"
ADD CONSTRAINT "ModelPolicy_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
