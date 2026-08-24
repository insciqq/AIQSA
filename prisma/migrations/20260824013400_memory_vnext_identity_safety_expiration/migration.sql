-- Package B: add server-owned SLOT/PROPOSITION identity, independent
-- relation-pending vocabulary, conservative temporal fields, and an explicit
-- reuse-expiration fence. Existing pre-vNext rows retain null identity/time
-- metadata and remain governed by their existing compatibility predicates.

CREATE TYPE "MemoryFactIdentityKind" AS ENUM ('SLOT', 'PROPOSITION');

ALTER TYPE "MemoryFactVersionState" ADD VALUE 'PENDING_RELATION' AFTER 'ACTIVE';

ALTER TABLE "MemoryFact"
  ADD COLUMN "identityKind" "MemoryFactIdentityKind",
  ADD COLUMN "identityVersion" VARCHAR(64),
  ADD COLUMN "subjectKey" VARCHAR(256),
  ADD COLUMN "predicateKey" VARCHAR(64),
  ADD COLUMN "dimensionKey" VARCHAR(256);

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "occurredAt" TIMESTAMP(3),
  ADD COLUMN "expectedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "MemoryFact"
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
  );

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_vnext_temporal_check" CHECK (
    ("validFrom" IS NULL OR "validTo" IS NULL OR "validFrom" < "validTo")
    AND ("expiresAt" IS NULL OR "observedAt" IS NULL OR "expiresAt" > "observedAt")
  );

CREATE INDEX "MemoryFactVersion_userId_occurredAt_idx"
  ON "MemoryFactVersion"("userId", "occurredAt");

CREATE INDEX "MemoryFactVersion_userId_expectedAt_idx"
  ON "MemoryFactVersion"("userId", "expectedAt");

CREATE INDEX "MemoryFactVersion_userId_expiresAt_idx"
  ON "MemoryFactVersion"("userId", "expiresAt");

CREATE OR REPLACE FUNCTION aiqsa_memory_vnext_identity_temporal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'MemoryFact' THEN
    IF OLD."identityKind" IS NOT NULL
       AND (
         NEW."identityKind",
         NEW."identityVersion",
         NEW."subjectKey",
         NEW."predicateKey",
         NEW."dimensionKey",
         NEW."canonicalKey"
       ) IS DISTINCT FROM (
         OLD."identityKind",
         OLD."identityVersion",
         OLD."subjectKey",
         OLD."predicateKey",
         OLD."dimensionKey",
         OLD."canonicalKey"
       ) THEN
      RAISE EXCEPTION 'MemoryFact vNext identity is immutable once assigned'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."ingestionFingerprint" IS NOT NULL
     AND (
       NEW."occurredAt",
       NEW."expectedAt",
       NEW."expiresAt",
       NEW."validFrom",
       NEW."validTo",
       NEW."rawTemporalExpression",
       NEW."sourceTimezone",
       NEW."temporalResolverVersion",
       NEW."temporalResolutionEvidence"
     ) IS DISTINCT FROM (
       OLD."occurredAt",
       OLD."expectedAt",
       OLD."expiresAt",
       OLD."validFrom",
       OLD."validTo",
       OLD."rawTemporalExpression",
       OLD."sourceTimezone",
       OLD."temporalResolverVersion",
       OLD."temporalResolutionEvidence"
     )
     AND NOT (
       NEW."contentPurgedAt" IS NOT NULL
       AND NEW."state"::text IN ('RETRACTED', 'FORGOTTEN')
       AND num_nonnulls(
         NEW."occurredAt",
         NEW."expectedAt",
         NEW."expiresAt",
         NEW."validFrom",
         NEW."validTo",
         NEW."rawTemporalExpression",
         NEW."sourceTimezone",
         NEW."temporalResolverVersion",
         NEW."temporalResolutionEvidence"
       ) = 0
     ) THEN
    RAISE EXCEPTION 'MemoryFactVersion vNext temporal semantics are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFact_vnext_identity_guard"
BEFORE UPDATE OF
  "identityKind", "identityVersion", "subjectKey", "predicateKey",
  "dimensionKey", "canonicalKey"
ON "MemoryFact"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_vnext_identity_temporal_guard();

CREATE TRIGGER "MemoryFactVersion_vnext_temporal_guard"
BEFORE UPDATE OF
  "occurredAt", "expectedAt", "expiresAt", "validFrom", "validTo",
  "rawTemporalExpression", "sourceTimezone", "temporalResolverVersion",
  "temporalResolutionEvidence"
ON "MemoryFactVersion"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_vnext_identity_temporal_guard();

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_fact_pointer(
  p_user_id text,
  p_fact_id text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  fact_row "MemoryFact"%ROWTYPE;
  active_count integer;
  pointed_state "MemoryFactVersionState";
  pointed_expires_at timestamp(3);
BEGIN
  SELECT * INTO fact_row FROM "MemoryFact"
  WHERE "userId" = p_user_id AND "id" = p_fact_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO active_count FROM "MemoryFactVersion"
  WHERE "userId" = p_user_id AND "factId" = p_fact_id AND "state" = 'ACTIVE';

  IF fact_row."state" = 'ACTIVE' THEN
    SELECT "state", "expiresAt" INTO pointed_state, pointed_expires_at
    FROM "MemoryFactVersion"
    WHERE "userId" = p_user_id
      AND "factId" = p_fact_id
      AND "id" = fact_row."currentVersionId";
    IF fact_row."currentVersionId" IS NULL
       OR pointed_state IS DISTINCT FROM 'ACTIVE'
       OR active_count <> 1
       OR pointed_expires_at <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'ACTIVE Memory fact must point to one live ACTIVE same-owner version';
    END IF;
  ELSIF fact_row."currentVersionId" IS NOT NULL OR active_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Non-ACTIVE Memory fact cannot retain an ACTIVE version or current pointer';
  END IF;
END;
$function$;
