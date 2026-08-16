ALTER TABLE "SkillPublication"
  DROP CONSTRAINT "SkillPublication_revision_fkey";

DROP INDEX "SkillPublication_revisionId_idx";

ALTER TABLE "SkillPublication"
  DROP COLUMN "revisionId";

ALTER TABLE "SkillDefinition"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "SkillDefinition_deletedAt_updatedAt_id_idx"
  ON "SkillDefinition"("deletedAt", "updatedAt", "id");
