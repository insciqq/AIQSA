BEGIN;

ALTER TABLE "SkillDefinition" ADD COLUMN "sharedRevisionId" TEXT;
CREATE UNIQUE INDEX "SkillDefinition_sharedRevisionId_key" ON "SkillDefinition"("sharedRevisionId");
CREATE UNIQUE INDEX "SkillDefinition_id_sharedRevisionId_key" ON "SkillDefinition"("id", "sharedRevisionId");
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_sharedRevision_fkey"
  FOREIGN KEY ("id", "sharedRevisionId") REFERENCES "SkillRevision"("skillId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TYPE "SkillShareRequestState" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn', 'superseded');
CREATE TABLE "SkillShareRequest" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "state" "SkillShareRequestState" NOT NULL DEFAULT 'pending',
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SkillShareRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SkillShareRequest_requestedByUserId_skillId_fkey" FOREIGN KEY ("requestedByUserId", "skillId")
    REFERENCES "SkillDefinition"("ownerUserId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkillShareRequest_skillId_revisionId_fkey" FOREIGN KEY ("skillId", "revisionId")
    REFERENCES "SkillRevision"("skillId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkillShareRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SkillShareRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SkillShareRequest_review_check" CHECK (
    ("state" IN ('approved', 'rejected') AND "reviewedAt" IS NOT NULL)
    OR ("state" IN ('pending', 'withdrawn', 'superseded') AND "reviewedAt" IS NULL
      AND "reviewedByUserId" IS NULL AND "reviewNote" IS NULL)),
  CONSTRAINT "SkillShareRequest_note_check" CHECK (char_length("reviewNote") <= 4000)
);
CREATE UNIQUE INDEX "SkillShareRequest_pending_skill_key" ON "SkillShareRequest"("skillId") WHERE "state" = 'pending';
CREATE INDEX "SkillShareRequest_state_createdAt_id_idx" ON "SkillShareRequest"("state", "createdAt", "id");
CREATE INDEX "SkillShareRequest_skillId_createdAt_id_idx" ON "SkillShareRequest"("skillId", "createdAt", "id");
CREATE INDEX "SkillShareRequest_requestedByUserId_idx" ON "SkillShareRequest"("requestedByUserId");
CREATE INDEX "SkillShareRequest_reviewedByUserId_idx" ON "SkillShareRequest"("reviewedByUserId");

-- The definition lock from ALTER remains held through this complete snapshot.
-- Never adopt a staged revision or approve files merely because an audience exists.
CREATE TEMP TABLE skill_sharing_backfill ON COMMIT DROP AS
SELECT definition."id" AS "skillId", definition."ownerUserId", current."id" AS "currentRevisionId",
  fallback."id" AS "sharedRevisionId",
  (current."fileCount" > 0 OR EXISTS (SELECT 1 FROM "SkillRevisionFile" AS file WHERE file."revisionId" = current."id")) AS "needsReview"
FROM "SkillDefinition" AS definition
JOIN "SkillRevision" AS current ON current."skillId" = definition."id" AND current."id" = definition."currentRevisionId" AND current."bundleReady"
LEFT JOIN LATERAL (
  SELECT revision."id" FROM "SkillRevision" AS revision
  WHERE revision."skillId" = definition."id" AND revision."bundleReady" AND revision."fileCount" = 0
    AND NOT EXISTS (SELECT 1 FROM "SkillRevisionFile" AS file WHERE file."revisionId" = revision."id")
  ORDER BY (revision."id" = current."id") DESC, revision."revisionNumber" DESC LIMIT 1
) AS fallback ON true
WHERE EXISTS (SELECT 1 FROM "SkillPublication" AS publication WHERE publication."skillId" = definition."id")
   OR EXISTS (SELECT 1 FROM "ProjectSkillBinding" AS binding WHERE binding."skillId" = definition."id");

UPDATE "SkillDefinition" AS definition SET "sharedRevisionId" = backfill."sharedRevisionId"
FROM skill_sharing_backfill AS backfill WHERE definition."id" = backfill."skillId";
INSERT INTO "SkillShareRequest" ("id", "skillId", "revisionId", "requestedByUserId")
SELECT gen_random_uuid()::text, "skillId", "currentRevisionId", "ownerUserId"
FROM skill_sharing_backfill WHERE "needsReview";

CREATE OR REPLACE FUNCTION aiqsa_skill_current_bundle_ready() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SkillDefinition" AS definition
    JOIN "SkillRevision" AS revision ON revision."id" IN (definition."currentRevisionId", definition."sharedRevisionId")
    WHERE definition."id" = NEW."id" AND NOT revision."bundleReady") THEN
    RAISE EXCEPTION 'skill_bundle_not_ready' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION aiqsa_skill_share_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."skillId", NEW."revisionId", NEW."requestedByUserId", NEW."createdAt")
      IS DISTINCT FROM (OLD."id", OLD."skillId", OLD."revisionId", OLD."requestedByUserId", OLD."createdAt")
    OR (OLD."state" <> 'pending' AND (
      (to_jsonb(NEW) - 'reviewedByUserId') IS DISTINCT FROM (to_jsonb(OLD) - 'reviewedByUserId')
      OR (NEW."reviewedByUserId" IS NOT NULL AND NEW."reviewedByUserId" IS DISTINCT FROM OLD."reviewedByUserId"))) THEN
    RAISE EXCEPTION 'skill_share_request_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SkillShareRequest_guard" BEFORE UPDATE ON "SkillShareRequest"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_skill_share_request_guard();

COMMIT;
