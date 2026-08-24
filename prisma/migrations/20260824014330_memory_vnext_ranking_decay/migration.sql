-- Package H: opt-in search-time decay and one bounded, idempotent access touch
-- for each fact version that actually entered a durable final frozen pack.

ALTER TABLE "UserMemorySettings"
  ADD COLUMN "decayEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "decayPolicyVersion" VARCHAR(64);

ALTER TABLE "ModelRunMemoryItem"
  ADD COLUMN "decayTouchedAt" TIMESTAMP(3),
  ADD COLUMN "decayTouchPolicyVersion" VARCHAR(64);

ALTER TABLE "UserMemorySettings"
  ADD CONSTRAINT "UserMemorySettings_decay_shape_check" CHECK (
    ("decayPolicyVersion" IS NULL AND "decayEnabled" = FALSE)
    OR "decayPolicyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
  );

ALTER TABLE "ModelRunMemoryItem"
  ADD CONSTRAINT "ModelRunMemoryItem_decay_touch_shape_check" CHECK (
    ("decayTouchedAt" IS NULL) = ("decayTouchPolicyVersion" IS NULL)
    AND (
      "decayTouchedAt" IS NULL
      OR (
        "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
        AND "factVersionId" IS NOT NULL
        AND "decayTouchedAt" >= "createdAt"
        AND "decayTouchPolicyVersion" ~
          '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
      )
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_memory_decay_touch_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."decayTouchedAt" IS NOT NULL AND (
    NEW."decayTouchedAt", NEW."decayTouchPolicyVersion"
  ) IS DISTINCT FROM (
    OLD."decayTouchedAt", OLD."decayTouchPolicyVersion"
  ) THEN
    RAISE EXCEPTION 'Frozen Memory decay touch is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ModelRunMemoryItem_decay_touch_guard"
BEFORE UPDATE OF "decayTouchedAt", "decayTouchPolicyVersion"
ON "ModelRunMemoryItem"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_decay_touch_guard();
