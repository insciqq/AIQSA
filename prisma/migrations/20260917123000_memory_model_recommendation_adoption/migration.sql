-- Model selection runs once in installation bootstrap, through exact current
-- capability/credential admission. SQL never infers quality from a model name.
ALTER TABLE "MemoryUtilityModelPolicy"
  ADD COLUMN "recommendationAdoptionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recommendationAdoptionReason" VARCHAR(32);

ALTER TABLE "MemoryUtilityModelPolicy" ADD CONSTRAINT "MemoryUtilityModelPolicy_recommendation_adoption_check"
  CHECK (("recommendationAdoptionVersion" = 0 AND "recommendationAdoptionReason" IS NULL)
    OR ("recommendationAdoptionVersion" = 1 AND "recommendationAdoptionReason" IS NOT NULL
      AND "recommendationAdoptionReason" IN ('preserved_operator', 'applied', 'no_eligible_model')));
