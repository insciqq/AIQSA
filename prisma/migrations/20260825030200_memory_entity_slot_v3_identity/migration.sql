-- Extend the pre-existing vNext identity vocabulary only after the entity
-- relation and its stricter slot-v3 shape constraint exist.

ALTER TABLE "MemoryFact"
  DROP CONSTRAINT "MemoryFact_vnext_identity_check",
  ADD CONSTRAINT "MemoryFact_vnext_identity_check" CHECK (
    (
      "identityKind" IS NULL
      AND num_nonnulls(
        "identityVersion", "subjectKey", "predicateKey", "dimensionKey"
      ) = 0
    )
    OR (
      "identityKind" = 'PROPOSITION'::"MemoryFactIdentityKind"
      AND "identityVersion" = 'proposition-v1'
      AND "subjectKey" IS NULL
      AND "predicateKey" IS NULL
      AND "dimensionKey" IS NULL
      AND "canonicalKey" ~ '^prop:v1:[a-f0-9]{64}$'
    )
    OR (
      "identityKind" = 'SLOT'::"MemoryFactIdentityKind"
      AND "identityVersion" = 'slot-v2'
      AND "subjectKey" IS NOT NULL
      AND "predicateKey" IN (
        'product_status',
        'residence',
        'employment_status',
        'goal_status',
        'project_status',
        'preference',
        'constraint',
        'routine'
      )
      AND (
        "predicateKey" NOT IN (
          'residence', 'employment_status', 'preference', 'constraint', 'routine'
        )
        OR "dimensionKey" IS NOT NULL
      )
      AND "canonicalKey" LIKE 'slot:v2:%'
    )
    OR (
      "identityKind" = 'SLOT'::"MemoryFactIdentityKind"
      AND "identityVersion" = 'slot-v3'
      AND "predicateKey" = 'product_status'
      AND "subjectEntityId" IS NOT NULL
      AND "subjectKey" = 'entity:' || "subjectEntityId"
      AND "dimensionKey" IS NULL
      AND "canonicalKey" =
        'slot:v3:entity:' || "subjectEntityId" || ':product_status:_'
    )
  );
