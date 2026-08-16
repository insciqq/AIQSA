CREATE TYPE "SkillPublicationScope" AS ENUM ('group', 'installation');

CREATE TABLE "SkillDefinition" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "currentRevisionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SkillDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillRevision" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL,
    "authorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillPublication" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "scope" "SkillPublicationScope" NOT NULL,
    "groupId" TEXT,
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SkillPublication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelRunSkillBinding" (
    "modelRunId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelRunSkillBinding_pkey" PRIMARY KEY ("modelRunId", "skillId")
);

CREATE UNIQUE INDEX "SkillDefinition_currentRevisionId_key" ON "SkillDefinition"("currentRevisionId");
CREATE UNIQUE INDEX "SkillDefinition_id_currentRevisionId_key" ON "SkillDefinition"("id", "currentRevisionId");
CREATE UNIQUE INDEX "SkillDefinition_ownerUserId_id_key" ON "SkillDefinition"("ownerUserId", "id");
CREATE INDEX "SkillDefinition_ownerUserId_archivedAt_idx" ON "SkillDefinition"("ownerUserId", "archivedAt");

CREATE UNIQUE INDEX "SkillRevision_skillId_revisionNumber_key" ON "SkillRevision"("skillId", "revisionNumber");
CREATE UNIQUE INDEX "SkillRevision_skillId_id_key" ON "SkillRevision"("skillId", "id");
CREATE INDEX "SkillRevision_authorUserId_idx" ON "SkillRevision"("authorUserId");

CREATE UNIQUE INDEX "SkillPublication_skillId_groupId_key" ON "SkillPublication"("skillId", "groupId");
CREATE UNIQUE INDEX "SkillPublication_installation_key" ON "SkillPublication"("skillId") WHERE "scope" = 'installation'::"SkillPublicationScope";
CREATE INDEX "SkillPublication_groupId_idx" ON "SkillPublication"("groupId");
CREATE INDEX "SkillPublication_skillId_scope_idx" ON "SkillPublication"("skillId", "scope");
CREATE INDEX "SkillPublication_revisionId_idx" ON "SkillPublication"("revisionId");

CREATE UNIQUE INDEX "ModelRunSkillBinding_modelRunId_revisionId_key" ON "ModelRunSkillBinding"("modelRunId", "revisionId");
CREATE INDEX "ModelRunSkillBinding_skillId_revisionId_idx" ON "ModelRunSkillBinding"("skillId", "revisionId");

ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_currentRevision_fkey"
  FOREIGN KEY ("id", "currentRevisionId") REFERENCES "SkillRevision"("skillId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_version_check"
  CHECK ("version" >= 1);
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_description_check"
  CHECK (char_length("description") <= 400);
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_instructions_check"
  CHECK (char_length("instructions") >= 1 AND char_length("instructions") <= 32000);
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_name_check"
  CHECK (char_length("name") >= 1 AND char_length("name") <= 80);
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_revision_number_check"
  CHECK ("revisionNumber" >= 1);
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_schema_version_check"
  CHECK ("schemaVersion" >= 1);

ALTER TABLE "SkillPublication" ADD CONSTRAINT "SkillPublication_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SkillPublication" ADD CONSTRAINT "SkillPublication_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SkillPublication" ADD CONSTRAINT "SkillPublication_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SkillPublication" ADD CONSTRAINT "SkillPublication_revision_fkey"
  FOREIGN KEY ("skillId", "revisionId") REFERENCES "SkillRevision"("skillId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SkillPublication" ADD CONSTRAINT "SkillPublication_scope_group_check"
  CHECK (
    ("scope" = 'group'::"SkillPublicationScope" AND "groupId" IS NOT NULL)
    OR ("scope" = 'installation'::"SkillPublicationScope" AND "groupId" IS NULL)
  );

ALTER TABLE "ModelRunSkillBinding" ADD CONSTRAINT "ModelRunSkillBinding_modelRunId_fkey"
  FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelRunSkillBinding" ADD CONSTRAINT "ModelRunSkillBinding_revision_fkey"
  FOREIGN KEY ("skillId", "revisionId") REFERENCES "SkillRevision"("skillId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
