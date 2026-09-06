-- A retained run keeps its immutable decay receipt after the reusable fact is
-- purged and the fact-version foreign key is detached with ON DELETE SET NULL.
ALTER TABLE "ModelRunMemoryItem"
  DROP CONSTRAINT "ModelRunMemoryItem_decay_touch_shape_check",
  ADD CONSTRAINT "ModelRunMemoryItem_decay_touch_shape_check" CHECK (
    ("decayTouchedAt" IS NULL) = ("decayTouchPolicyVersion" IS NULL)
    AND (
      "decayTouchedAt" IS NULL
      OR (
        "itemType" = 'FACT_VERSION'::"MemorySearchItemType"
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
  IF NEW."decayTouchedAt" IS NOT NULL
    AND NEW."factVersionId" IS NULL
    AND (TG_OP = 'INSERT' OR OLD."decayTouchedAt" IS NULL) THEN
    RAISE EXCEPTION 'A new Memory decay touch requires a current fact version'
      USING ERRCODE = '23514';
  END IF;
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

DROP TRIGGER "ModelRunMemoryItem_decay_touch_guard" ON "ModelRunMemoryItem";
CREATE TRIGGER "ModelRunMemoryItem_decay_touch_guard"
BEFORE INSERT OR UPDATE OF "decayTouchedAt", "decayTouchPolicyVersion"
ON "ModelRunMemoryItem"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_decay_touch_guard();
