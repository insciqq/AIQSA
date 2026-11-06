-- A Skill the release ships has no human owner. Exactly one of the owner and
-- the shipped key is set, so every owner-scoped write path refuses it, and the
-- previous release, which reads Skills only through an owner or a publication,
-- never sees one during the upgrade or after a rollback.
ALTER TABLE "SkillDefinition" ALTER COLUMN "ownerUserId" DROP NOT NULL;
ALTER TABLE "SkillDefinition" ADD COLUMN "shippedKey" TEXT;
CREATE UNIQUE INDEX "SkillDefinition_shippedKey_key" ON "SkillDefinition"("shippedKey");
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_shipped_owner_check"
  CHECK (("ownerUserId" IS NULL) = ("shippedKey" IS NOT NULL));
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_shippedKey_check"
  CHECK ("shippedKey" IS NULL OR "shippedKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
