-- Move default Memory utility-egress acceptance to one installation-owned,
-- secret-free policy snapshot. Per-user acceptance columns remain intact for
-- installations that explicitly select PER_USER mode.
BEGIN;

CREATE TABLE "MemoryEgressAdminPolicy" (
  "id" TEXT NOT NULL,
  "acceptedFingerprint" VARCHAR(128),
  "acceptedPolicyVersion" VARCHAR(64),
  "acceptedDestinations" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "acceptedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryEgressAdminPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryEgressAdminPolicy_shape_check" CHECK (
    "id" = 'installation'
    AND "version" >= 1
    AND jsonb_typeof("acceptedDestinations") = 'array'
    AND jsonb_array_length("acceptedDestinations") <= 8192
    AND pg_column_size("acceptedDestinations") <= 1048576
    AND (
      (
        "acceptedFingerprint" IS NULL
        AND "acceptedPolicyVersion" IS NULL
        AND "acceptedAt" IS NULL
        AND "acceptedDestinations" = '[]'::jsonb
      ) OR (
        "acceptedFingerprint" ~ '^[a-f0-9]{64}$'
        AND "acceptedPolicyVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
        AND "acceptedAt" IS NOT NULL
      )
    )
  )
);

CREATE INDEX "MemoryEgressAdminPolicy_acceptedByUserId_idx"
  ON "MemoryEgressAdminPolicy"("acceptedByUserId");

ALTER TABLE "MemoryEgressAdminPolicy"
  ADD CONSTRAINT "MemoryEgressAdminPolicy_acceptedByUserId_fkey"
    FOREIGN KEY ("acceptedByUserId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "MemoryEgressAdminPolicy" ("id") VALUES ('installation');

COMMIT;
