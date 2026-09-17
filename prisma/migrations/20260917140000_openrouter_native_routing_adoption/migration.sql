ALTER TABLE "ProviderModel"
  ADD COLUMN "nativeRoutingAdoptionVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "nativeRoutingAdoptionReason" VARCHAR(32);

-- Only rows present at this upgrade are eligible. New defaults use live
-- discovery during setup; subsequent operator choices are never re-adopted.
UPDATE "ProviderModel" SET "nativeRoutingAdoptionVersion" = 0
WHERE "provider" = 'openrouter';

ALTER TABLE "ProviderModel" ADD CONSTRAINT "ProviderModel_nativeRoutingAdoption_check"
CHECK (("nativeRoutingAdoptionVersion" = 0 AND "nativeRoutingAdoptionReason" IS NULL) OR
  ("nativeRoutingAdoptionVersion" = 1 AND ("nativeRoutingAdoptionReason" IS NULL OR
    "nativeRoutingAdoptionReason" IN ('applied', 'preserved', 'verification_required',
      'native_unavailable', 'native_incompatible', 'publisher_unknown'))));

-- During rolling replacement, the previous application's writers do not know
-- the marker. Their explicit model edits must close adoption as well.
CREATE FUNCTION "preserve_native_route_operator_edit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."nativeRoutingAdoptionVersion" = 0 AND NEW."nativeRoutingAdoptionVersion" = 0 AND
    (NEW."draftVersion" IS DISTINCT FROM OLD."draftVersion" OR NEW."activeVersion" IS DISTINCT FROM OLD."activeVersion" OR
     NEW."draftConfig" IS DISTINCT FROM OLD."draftConfig" OR NEW."activeConfig" IS DISTINCT FROM OLD."activeConfig") THEN
    NEW."nativeRoutingAdoptionVersion" := 1;
    NEW."nativeRoutingAdoptionReason" := 'preserved';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProviderModel_preserve_native_route_operator_edit"
BEFORE UPDATE ON "ProviderModel" FOR EACH ROW EXECUTE FUNCTION "preserve_native_route_operator_edit"();
