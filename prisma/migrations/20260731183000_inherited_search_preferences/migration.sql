-- ADR 0046: installation Search recommendations are distinct from each
-- user's nullable preference. Existing JSON plans remain personal choices;
-- only users provisioned after this migration inherit the installation plan.

ALTER TABLE "UserSettings"
ALTER COLUMN "defaultSearchPlan" DROP NOT NULL,
ALTER COLUMN "defaultSearchPlan" DROP DEFAULT;

CREATE TABLE "SearchPolicy" (
  "id" TEXT NOT NULL,
  "defaultPlan" JSONB NOT NULL DEFAULT '{"mode":"all_selected","optionIds":[]}'::jsonb,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SearchPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SearchPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "SearchPolicy_version_check" CHECK ("version" >= 1)
);

INSERT INTO "SearchPolicy" ("id", "defaultPlan")
VALUES ('installation', '{"mode":"all_selected","optionIds":[]}'::jsonb);

CREATE INDEX "SearchPolicy_updatedByUserId_idx"
ON "SearchPolicy"("updatedByUserId");

ALTER TABLE "SearchPolicy"
ADD CONSTRAINT "SearchPolicy_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
