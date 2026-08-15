-- Keep active-generation consistency at the database boundary: both writers
-- converge on the same deferred assertion, including raw SQL and concurrent work.
CREATE OR REPLACE FUNCTION public.aiqsa_memory_active_generation_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM aiqsa_memory_assert_active_generation(NEW."userId");
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM aiqsa_memory_assert_active_generation(OLD."userId");
  END IF;
  RETURN NULL;
END
$function$;
