-- PostgreSQL CHECK constraints accept UNKNOWN. Make the enabled/null case
-- explicitly false while still preserving a valid remembered policy version
-- when the reversible preference is disabled.
ALTER TABLE "UserMemorySettings"
  DROP CONSTRAINT "UserMemorySettings_decay_shape_check",
  ADD CONSTRAINT "UserMemorySettings_decay_shape_check" CHECK (
    (
      "decayPolicyVersion" IS NULL
      AND "decayEnabled" = FALSE
    )
    OR (
      "decayPolicyVersion" IS NOT NULL
      AND "decayPolicyVersion" ~
        '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
    )
  );
