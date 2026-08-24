-- vNext direct observations are append-only semantic records. Lifecycle and
-- safety may change state/classification metadata, while content purge may
-- clear the payload only after the version has entered its safe terminal
-- state.

CREATE OR REPLACE FUNCTION aiqsa_memory_vnext_semantic_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."ingestionFingerprint" IS NOT NULL
     AND (
       NEW."displayText",
       NEW."normalizedSearchText",
       NEW."structuredValue",
       NEW."observedAt"
     ) IS DISTINCT FROM (
       OLD."displayText",
       OLD."normalizedSearchText",
       OLD."structuredValue",
       OLD."observedAt"
     )
     AND NOT (
       NEW."contentPurgedAt" IS NOT NULL
       AND NEW."state"::text IN ('RETRACTED', 'FORGOTTEN')
       AND num_nonnulls(
         NEW."displayText",
         NEW."normalizedSearchText",
         NEW."structuredValue"
       ) = 0
       AND NEW."observedAt" IS NOT DISTINCT FROM OLD."observedAt"
     ) THEN
    RAISE EXCEPTION 'MemoryFactVersion vNext semantic observation is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFactVersion_vnext_semantic_guard"
BEFORE UPDATE OF
  "displayText", "normalizedSearchText", "structuredValue", "observedAt",
  "contentPurgedAt", "state"
ON "MemoryFactVersion"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_vnext_semantic_guard();
