-- Package C: product SLOT identity is anchored to an owner-scoped entity,
-- automatic entity provenance is explicit, and root resolution treats a
-- retracted root as terminally unavailable without promoting merged children.

ALTER TABLE "MemoryFact"
  ADD COLUMN "subjectEntityId" TEXT;

ALTER TABLE "MemoryEntity"
  ADD COLUMN "automaticOnly" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "MemoryFact"
  ADD CONSTRAINT "MemoryFact_subject_entity_shape_check" CHECK (
    (
      "subjectEntityId" IS NULL
      AND NOT (
        "identityKind" = 'SLOT'::"MemoryFactIdentityKind"
        AND "identityVersion" = 'slot-v3'
        AND "predicateKey" = 'product_status'
      )
    )
    OR (
      "subjectEntityId" IS NOT NULL
      AND "identityKind" = 'SLOT'::"MemoryFactIdentityKind"
      AND "identityVersion" = 'slot-v3'
      AND "predicateKey" = 'product_status'
      AND "dimensionKey" IS NULL
      AND "subjectKey" = 'entity:' || "subjectEntityId"
      AND "canonicalKey" =
        'slot:v3:entity:' || "subjectEntityId" || ':product_status:_'
    )
  );

CREATE INDEX "MemoryFact_userId_subjectEntityId_predicateKey_dimensionKey_idx"
  ON "MemoryFact"("userId", "subjectEntityId", "predicateKey", "dimensionKey");

ALTER TABLE "MemoryFact"
  ADD CONSTRAINT "MemoryFact_subject_entity_fkey"
    FOREIGN KEY ("userId", "subjectEntityId")
    REFERENCES "MemoryEntity"("userId", "id")
    ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEntity"
  DROP CONSTRAINT "MemoryEntity_state_check",
  ADD CONSTRAINT "MemoryEntity_state_check" CHECK (
    ("state" IN (
      'ACTIVE'::"MemoryEntityState",
      'RETRACTED'::"MemoryEntityState"
    ) AND "mergedIntoId" IS NULL)
    OR (
      "state" = 'MERGED'::"MemoryEntityState"
      AND "mergedIntoId" IS NOT NULL
      AND "mergedIntoId" <> "id"
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_memory_entity_root_id(
  p_user_id TEXT,
  p_entity_id TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  WITH RECURSIVE entity_chain AS (
    SELECT
      entity."id",
      entity."mergedIntoId",
      entity."state",
      ARRAY[entity."id"]::TEXT[] AS visited,
      FALSE AS cycle,
      0 AS depth
    FROM "MemoryEntity" AS entity
    WHERE entity."userId" = p_user_id
      AND entity."id" = p_entity_id

    UNION ALL

    SELECT
      parent."id",
      parent."mergedIntoId",
      parent."state",
      child.visited || parent."id",
      parent."id" = ANY(child.visited),
      child.depth + 1
    FROM entity_chain AS child
    INNER JOIN "MemoryEntity" AS parent
      ON parent."userId" = p_user_id
      AND parent."id" = child."mergedIntoId"
    WHERE NOT child.cycle
      AND child.depth < 16
  )
  SELECT chain."id"
  FROM entity_chain AS chain
  WHERE chain."mergedIntoId" IS NULL
    AND chain."state" = 'ACTIVE'::"MemoryEntityState"
    AND NOT chain.cycle
    AND NOT EXISTS (
      SELECT 1
      FROM entity_chain AS invalid
      WHERE invalid.cycle
        OR (invalid.depth = 16 AND invalid."mergedIntoId" IS NOT NULL)
    )
  ORDER BY chain.depth DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_entity_root_is_active(
  p_user_id TEXT,
  p_entity_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT aiqsa_memory_entity_root_id(p_user_id, p_entity_id) IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_entity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'MemoryEntity' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (
        NEW."userId", NEW."canonicalKey", NEW."entityType", NEW."displayName",
        NEW."languageCode", NEW."automaticOnly", NEW."createdAt"
      ) IS DISTINCT FROM (
        OLD."userId", OLD."canonicalKey", OLD."entityType", OLD."displayName",
        OLD."languageCode", OLD."automaticOnly", OLD."createdAt"
      ) THEN
        RAISE EXCEPTION 'Memory entity identity is immutable'
          USING ERRCODE = '23514';
      END IF;
      IF OLD."state" IN (
        'MERGED'::"MemoryEntityState",
        'RETRACTED'::"MemoryEntityState"
      ) AND (NEW."state", NEW."mergedIntoId") IS DISTINCT FROM
        (OLD."state", OLD."mergedIntoId") THEN
        RAISE EXCEPTION 'Terminal memory entity state is immutable'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."state" = 'MERGED'::"MemoryEntityState" THEN
      IF NEW."mergedIntoId" = NEW."id" OR NOT EXISTS (
        SELECT 1 FROM "MemoryEntity" AS root
        WHERE root."userId" = NEW."userId"
          AND root."id" = NEW."mergedIntoId"
          AND root."state" = 'ACTIVE'::"MemoryEntityState"
          AND root."mergedIntoId" IS NULL
      ) THEN
        RAISE EXCEPTION 'Memory entity merge target is cyclic or unavailable'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Memory entity provenance rows are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
