CREATE TABLE "AssistantRevisionSkill" (
  "assistantRevisionId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,

  CONSTRAINT "AssistantRevisionSkill_pkey"
    PRIMARY KEY ("assistantRevisionId", "skillId")
);

CREATE UNIQUE INDEX "AssistantRevisionSkill_assistantRevisionId_ordinal_key"
  ON "AssistantRevisionSkill"("assistantRevisionId", "ordinal");

CREATE INDEX "AssistantRevisionSkill_skillId_idx"
  ON "AssistantRevisionSkill"("skillId");

ALTER TABLE "AssistantRevisionSkill"
  ADD CONSTRAINT "AssistantRevisionSkill_assistantRevisionId_fkey"
  FOREIGN KEY ("assistantRevisionId")
  REFERENCES "AssistantRevision"("id")
  ON DELETE CASCADE
  ON UPDATE RESTRICT;

ALTER TABLE "AssistantRevisionSkill"
  ADD CONSTRAINT "AssistantRevisionSkill_skillId_fkey"
  FOREIGN KEY ("skillId")
  REFERENCES "SkillDefinition"("id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;
