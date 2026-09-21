BEGIN;

CREATE TYPE "SkillsMode" AS ENUM ('auto', 'off');
CREATE TYPE "AssistantSkillMode" AS ENUM ('pinned', 'available');
CREATE TYPE "ModelRunSkillMode" AS ENUM ('pinned', 'loaded');
ALTER TABLE "AssistantDefinition" ADD COLUMN "skillsMode" "SkillsMode" NOT NULL DEFAULT 'auto';
ALTER TABLE "UserSettings" ADD COLUMN "defaultSkillsMode" "SkillsMode" NOT NULL DEFAULT 'auto';
ALTER TABLE "AssistantSkill" ADD COLUMN "mode" "AssistantSkillMode" NOT NULL DEFAULT 'pinned';

CREATE TABLE "UserSkillPreference" (
  "userId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserSkillPreference_pkey" PRIMARY KEY ("userId", "skillId"),
  CONSTRAINT "UserSkillPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "UserSkillPreference_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "UserSkillPreference_skillId_idx" ON "UserSkillPreference"("skillId");

ALTER TABLE "ModelRunSkillBinding"
  ADD COLUMN "mode" "ModelRunSkillMode" NOT NULL DEFAULT 'pinned',
  ADD COLUMN "alias" VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN "modelRunToolCallId" TEXT;

-- Same ASCII slug and collision rules as skillAlias. Kept for the previous
-- release's inserts during the Compose replacement window.
CREATE FUNCTION aiqsa_skill_run_alias(skill_name TEXT, used_aliases TEXT[]) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE base TEXT; candidate TEXT; suffix INTEGER := 2; tail TEXT;
BEGIN
  -- Only ASCII letters plus Kelvin sign and dotted capital I can survive the
  -- JavaScript lowercase-then-ASCII filter. Avoid database-locale lower(),
  -- which drops the combining dot from I and changes historical aliases.
  base := translate(replace(skill_name, 'İ', 'i-'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZK', 'abcdefghijklmnopqrstuvwxyzk');
  base := rtrim(left(trim(both '-' FROM regexp_replace(base, '[^a-z0-9]+', '-', 'g')), 64), '-');
  IF base IS NULL OR base = '' THEN base := 'skill'; END IF;
  candidate := base;
  WHILE candidate = ANY(used_aliases) LOOP
    tail := '-' || suffix::text;
    candidate := rtrim(left(base, 64 - length(tail)), '-') || tail;
    suffix := suffix + 1;
  END LOOP;
  RETURN candidate;
END $$;

-- Backfill in the accepted manifest's pinned order. Bindings that predate a
-- usable manifest retain a deterministic createdAt/id order without rewriting
-- historical normalizedRequest or instruction content.
DO $$
DECLARE run_row RECORD; binding_row RECORD; aliases TEXT[]; candidate TEXT;
BEGIN
  FOR run_row IN SELECT DISTINCT run."id", run."normalizedRequest"
    FROM "ModelRun" AS run JOIN "ModelRunSkillBinding" AS binding ON binding."modelRunId" = run."id"
  LOOP
    aliases := ARRAY[]::TEXT[];
    FOR binding_row IN
      SELECT binding."skillId", revision."name"
      FROM "ModelRunSkillBinding" AS binding
      JOIN "SkillRevision" AS revision ON revision."id" = binding."revisionId"
      LEFT JOIN LATERAL (
        SELECT entry.ordinal FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(run_row."normalizedRequest"->'skills') = 'array'
          THEN run_row."normalizedRequest"->'skills' ELSE '[]'::jsonb END) WITH ORDINALITY AS entry(value, ordinal)
        WHERE entry.value->>'skillId' = binding."skillId" ORDER BY entry.ordinal LIMIT 1
      ) AS manifest ON true
      WHERE binding."modelRunId" = run_row."id"
      ORDER BY manifest.ordinal NULLS LAST, binding."createdAt", binding."skillId"
    LOOP
      candidate := aiqsa_skill_run_alias(binding_row."name", aliases);
      aliases := array_append(aliases, candidate);
      UPDATE "ModelRunSkillBinding" SET "alias" = candidate
        WHERE "modelRunId" = run_row."id" AND "skillId" = binding_row."skillId";
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION aiqsa_skill_legacy_binding_alias() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot JSONB; entry JSONB; aliases TEXT[] := ARRAY[]::TEXT[]; candidate TEXT; skill_name TEXT;
BEGIN
  IF NEW."alias" <> '' THEN RETURN NEW; END IF;
  SELECT "normalizedRequest" INTO snapshot FROM "ModelRun" WHERE "id" = NEW."modelRunId" FOR UPDATE;
  IF jsonb_typeof(snapshot->'skills') = 'array' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(snapshot->'skills') LOOP
      candidate := aiqsa_skill_run_alias(entry->>'name', aliases);
      aliases := array_append(aliases, candidate);
      IF entry->>'skillId' = NEW."skillId" THEN NEW."alias" := candidate; RETURN NEW; END IF;
    END LOOP;
  END IF;
  SELECT "name" INTO skill_name FROM "SkillRevision" WHERE "id" = NEW."revisionId";
  SELECT coalesce(array_agg("alias"), ARRAY[]::TEXT[]) INTO aliases
    FROM "ModelRunSkillBinding" WHERE "modelRunId" = NEW."modelRunId";
  NEW."alias" := aiqsa_skill_run_alias(skill_name, aliases);
  RETURN NEW;
END $$;
CREATE TRIGGER "ModelRunSkillBinding_legacy_alias" BEFORE INSERT ON "ModelRunSkillBinding"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_skill_legacy_binding_alias();

ALTER TABLE "ModelRunSkillBinding"
  ADD CONSTRAINT "ModelRunSkillBinding_alias_check" CHECK ("alias" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  ADD CONSTRAINT "ModelRunSkillBinding_delivery_check" CHECK (
    ("mode" = 'pinned' AND "modelRunToolCallId" IS NULL) OR ("mode" = 'loaded' AND "modelRunToolCallId" IS NOT NULL)),
  ADD CONSTRAINT "ModelRunSkillBinding_modelRunId_modelRunToolCallId_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id")
    ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "ModelRunSkillBinding_modelRunId_alias_key" ON "ModelRunSkillBinding"("modelRunId", "alias");
CREATE INDEX "ModelRunSkillBinding_modelRunId_modelRunToolCallId_idx" ON "ModelRunSkillBinding"("modelRunId", "modelRunToolCallId");

COMMIT;
