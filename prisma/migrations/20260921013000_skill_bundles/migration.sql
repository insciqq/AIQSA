ALTER TABLE "SkillRevision"
  ADD COLUMN "frontmatterJson" JSONB,
  ADD COLUMN "bundleDigest" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "fileCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bundleByteSize" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hasExecutables" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bundleReady" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SkillRevision" DROP CONSTRAINT "SkillRevision_description_check";
ALTER TABLE "SkillRevision" DROP CONSTRAINT "SkillRevision_instructions_check";
ALTER TABLE "SkillRevision" DROP CONSTRAINT "SkillRevision_name_check";
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_description_check"
  CHECK (("schemaVersion" < 2 AND char_length("description") <= 400)
    OR ("schemaVersion" >= 2 AND char_length("description") BETWEEN 1 AND 1024));
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_instructions_check"
  CHECK (("schemaVersion" < 2 AND char_length("instructions") BETWEEN 1 AND 32000)
    OR ("schemaVersion" >= 2 AND octet_length("instructions") BETWEEN 1 AND 131072));
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_name_check"
  CHECK (char_length("name") BETWEEN 1 AND CASE WHEN "schemaVersion" < 2 THEN 80 ELSE 64 END);
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_bundle_bounds_check"
  CHECK ("fileCount" BETWEEN 0 AND 200 AND "bundleByteSize" BETWEEN 0 AND 25165824
    AND ("frontmatterJson" IS NULL OR jsonb_typeof("frontmatterJson") = 'object'));

-- Keep old writers valid during Compose replacement and backfill without changing
-- historical name, description, instructions or schemaVersion. Canonical property
-- ordering matches the application digest for a text-only revision.
CREATE FUNCTION aiqsa_skill_text_bundle_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bundleDigest" = '' AND NEW."fileCount" = 0 THEN
    NEW."bundleDigest" := encode(sha256(convert_to(
      '{"description":' || to_json(NEW."description")::text ||
      ',"files":[],"frontmatter":null,"instructions":' || to_json(NEW."instructions")::text ||
      ',"name":' || to_json(NEW."name")::text || '}', 'UTF8')), 'hex');
    NEW."bundleByteSize" := octet_length(
      E'---\n"name": ' || to_json(NEW."name")::text ||
      E'\n"description": ' || to_json(CASE WHEN NEW."description" = '' THEN NEW."name" ELSE NEW."description" END)::text ||
      E'\n---\n' || NEW."instructions" || E'\n');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SkillRevision_text_bundle_metadata"
  BEFORE INSERT OR UPDATE OF "bundleDigest" ON "SkillRevision"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_skill_text_bundle_metadata();
UPDATE "SkillRevision" SET "bundleDigest" = '' WHERE "bundleDigest" = '';
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_bundle_digest_check"
  CHECK ("bundleDigest" ~ '^[a-f0-9]{64}$');

CREATE TABLE "SkillRevisionFile" (
  "revisionId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "executable" BOOLEAN NOT NULL DEFAULT false,
  "textContent" TEXT,
  "storageKey" TEXT,
  CONSTRAINT "SkillRevisionFile_pkey" PRIMARY KEY ("revisionId", "path"),
  CONSTRAINT "SkillRevisionFile_skillId_revisionId_fkey" FOREIGN KEY ("skillId", "revisionId")
    REFERENCES "SkillRevision"("skillId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SkillRevisionFile_bytes_check" CHECK ("byteSize" BETWEEN 0 AND 8388608),
  CONSTRAINT "SkillRevisionFile_checksum_check" CHECK ("checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "SkillRevisionFile_content_check" CHECK (
    ("kind" = 'text' AND "textContent" IS NOT NULL AND "storageKey" IS NULL
      AND octet_length("textContent") = "byteSize" AND "byteSize" <= 1048576)
    OR ("kind" = 'binary' AND "storageKey" IS NOT NULL AND "textContent" IS NULL)),
  CONSTRAINT "SkillRevisionFile_path_check" CHECK (
    "path" <> '' AND "path" !~ '(^/|(^|/)\.\.?(/|$)|[[:cntrl:]]|^[A-Za-z]:)' AND position(E'\\' in "path") = 0
    AND lower("path") <> 'skill.md')
);
CREATE UNIQUE INDEX "SkillRevisionFile_casefold_path_key" ON "SkillRevisionFile" ("revisionId", lower("path"));
CREATE INDEX "SkillRevisionFile_skillId_revisionId_idx" ON "SkillRevisionFile" ("skillId", "revisionId");
CREATE INDEX "SkillRevisionFile_storageKey_idx" ON "SkillRevisionFile" ("storageKey");

CREATE FUNCTION aiqsa_skill_current_bundle_ready() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SkillDefinition" AS definition
    JOIN "SkillRevision" AS revision ON revision."id" = definition."currentRevisionId"
    WHERE definition."id" = NEW."id" AND NOT revision."bundleReady") THEN
    RAISE EXCEPTION 'skill_bundle_not_ready' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "SkillDefinition_current_bundle_ready"
  AFTER INSERT OR UPDATE ON "SkillDefinition" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_skill_current_bundle_ready();
