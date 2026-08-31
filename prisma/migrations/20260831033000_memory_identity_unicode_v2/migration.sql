CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "MemoryIdentityCompatibility" (
  "id" CHAR(64) NOT NULL,
  "userId" TEXT NOT NULL,
  "namespace" VARCHAR(32) NOT NULL,
  "containerId" VARCHAR(256) NOT NULL,
  "legacyKeyHash" CHAR(64) NOT NULL,
  "unicodeKeyHash" CHAR(64) NOT NULL,
  "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observationCount" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "MemoryIdentityCompatibility_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryIdentityCompatibility_shape_check" CHECK (
    "namespace" IN ('FACT', 'GROUNDED_ENTITY', 'LABEL_ENTITY')
    AND "id" ~ '^[a-f0-9]{64}$'
    AND "legacyKeyHash" ~ '^[a-f0-9]{64}$'
    AND "unicodeKeyHash" ~ '^[a-f0-9]{64}$'
    AND "observationCount" > 0
  ),
  CONSTRAINT "MemoryIdentityCompatibility_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "MemoryIdentityCompatibility_mapping_key"
  ON "MemoryIdentityCompatibility"(
    "userId", "namespace", "containerId", "legacyKeyHash", "unicodeKeyHash"
  );

CREATE INDEX "MemoryIdentityCompatibility_legacy_idx"
  ON "MemoryIdentityCompatibility"(
    "userId", "namespace", "containerId", "legacyKeyHash"
  );

CREATE INDEX "MemoryIdentityCompatibility_unicode_idx"
  ON "MemoryIdentityCompatibility"(
    "userId", "namespace", "containerId", "unicodeKeyHash"
  );

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
      AND "identityVersion" IN ('proposition-v1', 'proposition-v2')
      AND "subjectKey" IS NULL
      AND "predicateKey" IS NULL
      AND "dimensionKey" IS NULL
      AND "canonicalKey" ~ CASE "identityVersion"
        WHEN 'proposition-v1' THEN '^prop:v1:[a-f0-9]{64}$'
        ELSE '^prop:v2:[a-f0-9]{64}$'
      END
    )
    OR (
      "identityKind" = 'SLOT'::"MemoryFactIdentityKind"
      AND "identityVersion" IN ('slot-v2', 'slot-v4')
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
      AND "canonicalKey" LIKE CASE "identityVersion"
        WHEN 'slot-v2' THEN 'slot:v2:%'
        ELSE 'slot:v4:%'
      END
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
