-- RunProfile was an operator-mutable surface, even though it had only the fixed
-- Fast/Balanced/Deep ids. Prove that every row is still the exact provisioned
-- stock configuration before the following reusable-assistants contract
-- migration drops the table.
--
-- This migration is fail-closed. A missing/extra row, any edited field, an
-- operator-attributed write, a version advance, or a non-stock model target
-- stops deployment before any legacy column or table is changed.
--
-- Once validation succeeds, a statement trigger seals RunProfile against every
-- DML class and TRUNCATE. The lock makes validation and fence installation
-- atomic, while the trigger survives this migration's commit so an interrupted
-- deploy cannot change a previously approved row before the following contract
-- migration drops the table. That DROP removes the trigger; a later migration
-- removes the then-unreferenced trigger function.
BEGIN;

DO $$
BEGIN
  IF to_regclass('"RunProfile"') IS NULL THEN
    RAISE EXCEPTION 'run_profile_stock_cleanup_blocked'
      USING DETAIL = 'The RunProfile table is missing before the reusable-assistants contract migration.';
  END IF;
END $$;

LOCK TABLE "RunProfile" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  unexpected_count INTEGER;
BEGIN
  SELECT count(*)
  INTO unexpected_count
  FROM (
    VALUES
      ('fast', 'Simple, well-defined questions', 'openai:gpt-5.6-luna', 'medium', 'standard'),
      ('balanced', 'Most everyday questions', 'openai:gpt-5.6-terra', 'medium', 'standard'),
      ('deep', 'Difficult or open-ended questions', 'openai:gpt-5.6-sol', 'max', 'pro')
  ) AS expected("id", "description", "templateKey", "reasoningEffort", "reasoningMode")
  FULL OUTER JOIN "RunProfile" AS profile ON profile."id" = expected."id"
  LEFT JOIN "ProviderModel" AS model ON model."id" = profile."providerModelId"
  WHERE expected."id" IS NULL
     OR profile."id" IS NULL
     OR profile."description" IS DISTINCT FROM expected."description"
     OR profile."reasoningEffort" IS DISTINCT FROM expected."reasoningEffort"
     OR profile."reasoningMode" IS DISTINCT FROM expected."reasoningMode"
     OR profile."version" IS DISTINCT FROM 1
     OR profile."updatedByUserId" IS NOT NULL
     OR NOT (
       (profile."enabled" = false AND profile."providerModelId" IS NULL)
       OR (
         profile."enabled" = true
         AND profile."providerModelId" IS NOT NULL
         AND model."templateKey" IS NOT DISTINCT FROM expected."templateKey"
       )
     );

  IF unexpected_count <> 0 THEN
    RAISE EXCEPTION 'run_profile_stock_cleanup_blocked'
      USING DETAIL = format(
        'Expected exactly three untouched fixed stock rows; found %s missing, extra, or changed row(s).',
        unexpected_count
      ),
      HINT = 'Review and preserve the RunProfile configuration before retrying this migration.';
  END IF;
END $$;

CREATE FUNCTION "run_profile_stock_cleanup_write_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION 'run_profile_stock_cleanup_write_blocked'
    USING DETAIL = 'RunProfile is sealed between compatibility validation and its contract removal.';
  RETURN NULL;
END;
$guard$;

CREATE TRIGGER "RunProfile_stock_cleanup_write_guard"
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "RunProfile"
FOR EACH STATEMENT
EXECUTE FUNCTION "run_profile_stock_cleanup_write_guard"();

COMMIT;
