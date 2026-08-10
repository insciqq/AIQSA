-- Phase 3 activates the already-modeled typed Memory scopes. Keep scope and
-- fact identity immutable, prove Assistant ownership in the database, and make
-- scope/fact availability a deferred all-or-nothing lifecycle invariant.
BEGIN;

DROP TRIGGER "MemoryScope_phase1_guard" ON "MemoryScope";
DROP FUNCTION aiqsa_memory_scope_guard();

CREATE FUNCTION aiqsa_memory_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $memory_scope_guard$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."userId", NEW."scopeType", NEW."targetIdSnapshot")
         IS DISTINCT FROM (OLD."userId", OLD."scopeType", OLD."targetIdSnapshot") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory scope identity is immutable';
  END IF;
  RETURN NEW;
END
$memory_scope_guard$;

CREATE TRIGGER "MemoryScope_identity_guard"
BEFORE UPDATE ON "MemoryScope"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_scope_guard();

CREATE FUNCTION aiqsa_memory_fact_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $memory_fact_scope_guard$
BEGIN
  IF NEW."scopeId" IS DISTINCT FROM OLD."scopeId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory fact scope identity is immutable';
  END IF;
  RETURN NEW;
END
$memory_fact_scope_guard$;

CREATE TRIGGER "MemoryFact_scope_identity_guard"
BEFORE UPDATE OF "scopeId" ON "MemoryFact"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_fact_scope_guard();

CREATE UNIQUE INDEX "AssistantDefinition_ownerUserId_id_key"
ON "AssistantDefinition"("ownerUserId", "id");

ALTER TABLE "MemoryScope"
  DROP CONSTRAINT "MemoryScope_assistant_fkey",
  ADD CONSTRAINT "MemoryScope_assistant_fkey"
    FOREIGN KEY ("userId", "assistantId")
    REFERENCES "AssistantDefinition"("ownerUserId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION aiqsa_memory_assert_scope_fact_availability() RETURNS trigger
LANGUAGE plpgsql AS $memory_scope_fact_availability$
DECLARE
  checked_user_id text;
  checked_scope_id text;
BEGIN
  IF TG_TABLE_NAME = 'MemoryScope' THEN
    checked_user_id := NEW."userId";
    checked_scope_id := NEW."id";
  ELSE
    checked_user_id := NEW."userId";
    checked_scope_id := NEW."scopeId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE fact."userId" = checked_user_id
      AND fact."scopeId" = checked_scope_id
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND scope."state" <> 'ACTIVE'::"MemoryScopeState"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ACTIVE Memory fact requires an ACTIVE scope';
  END IF;
  RETURN NEW;
END
$memory_scope_fact_availability$;

CREATE CONSTRAINT TRIGGER "MemoryScope_fact_availability_check"
AFTER INSERT OR UPDATE ON "MemoryScope"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_assert_scope_fact_availability();

CREATE CONSTRAINT TRIGGER "MemoryFact_scope_availability_check"
AFTER INSERT OR UPDATE ON "MemoryFact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_assert_scope_fact_availability();

-- Rollback requires first resolving any active non-global scope and moved
-- lineage created under this contract. Reinstalling the Phase 1 feature-dark
-- guard while such rows remain active would misrepresent durable behavior.
COMMIT;
