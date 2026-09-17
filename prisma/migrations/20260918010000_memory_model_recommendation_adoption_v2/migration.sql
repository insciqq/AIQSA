-- Bootstrap reconsiders the expanded, ordered recommendation catalog once.
-- Preserve assignments and the previous marker until exact current admission;
-- both old and new bootstrap writers remain valid during application replacement.
ALTER TABLE "MemoryUtilityModelPolicy"
  DROP CONSTRAINT "MemoryUtilityModelPolicy_recommendation_adoption_check",
  ADD CONSTRAINT "MemoryUtilityModelPolicy_recommendation_adoption_check"
  CHECK (("recommendationAdoptionVersion" = 0 AND "recommendationAdoptionReason" IS NULL)
    OR ("recommendationAdoptionVersion" IN (1, 2) AND "recommendationAdoptionReason" IS NOT NULL
      AND "recommendationAdoptionReason" IN ('preserved_operator', 'applied', 'no_eligible_model')));
