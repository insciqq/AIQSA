-- The Skills a scheduled task pins: plain Skill ids every run loads at their
-- current revision besides the Auto catalog, rechecked against the owner's
-- available Skills at save and before every run (a lost one pauses the task
-- as `skill_unavailable`), so no foreign key. At most four, without nulls,
-- and only while the task has tools on. Existing tasks start without pins,
-- so the check is valid at once.
ALTER TABLE "ScheduledTask"
  ADD COLUMN "pinnedSkillIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD CONSTRAINT "ScheduledTask_pinned_skill_ids_check" CHECK (
    cardinality("pinnedSkillIds") <= 4
    AND array_position("pinnedSkillIds", NULL) IS NULL
    AND (cardinality("pinnedSkillIds") = 0 OR "toolsEnabled")
  );
