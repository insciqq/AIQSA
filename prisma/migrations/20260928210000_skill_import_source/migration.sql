-- Import provenance is private owner metadata; accepted and shared revisions stay immutable.
ALTER TABLE "SkillDefinition" ADD COLUMN "importSourceJson" JSONB;
